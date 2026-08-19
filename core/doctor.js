import fs from 'node:fs';
import path from 'node:path';
import { readUserEnv, readMachineEnv } from './env.js';
import { PROVIDERS } from './accounts.js';
import { toEpochMs } from './quota.js';

const DAY = 24 * 60 * 60 * 1000;

function scopesWith(name, env) {
  const hits = [];
  if (env.user(name)) hits.push('user');
  if (env.machine(name)) hits.push('machine');
  return hits;
}

/**
 * Whether a Claude login still works, from the two expiry stamps the vendor writes.
 *
 * These are very different things and reading the wrong one is useless. `expiresAt` is the
 * access token: hours long by design, refreshed silently on the next CLI use, and never
 * something to act on. `refreshTokenExpiresAt` is the login itself, and only that running
 * out means signing in again.
 *
 * This check used to read `expiresAt` and warn under thirty days, so it warned on every
 * account permanently and could not go green: an access token is always hours away. Signing
 * in again appeared to change nothing, because the fresh access token was hours away too.
 *
 * Exported so the distinction stays pinned by tests.
 */
export function claudeLoginState(oauth = {}, now = Date.now()) {
  const refresh = toEpochMs(oauth.refreshTokenExpiresAt);
  const access = toEpochMs(oauth.expiresAt);

  if (typeof refresh === 'number') {
    const left = refresh - now;
    if (left <= 0) {
      return { level: 'warn', detail: `Login expired ${fmtDate(refresh)}. Sign in again.` };
    }
    if (left < 7 * DAY) {
      return { level: 'warn', detail: `Login expires ${inWords(left)}, on ${fmtDate(refresh)}. Sign in again before then.` };
    }
    return { level: 'ok', detail: `Signed in, login valid until ${fmtDate(refresh)}` };
  }

  // Older credential files carry only the access token stamp. It says nothing about whether
  // the login survives, so report being signed in rather than inventing a warning.
  if (typeof access === 'number' && access - now <= 0) {
    return { level: 'ok', detail: 'Signed in. Access token has lapsed and refreshes on next use.' };
  }
  return { level: 'ok', detail: 'Signed in' };
}

function fmtDate(ms) {
  return new Date(ms).toLocaleDateString();
}

/** "in 3 days" / "in about 5 hours", so a sub-day figure never rounds up to "1 days". */
function inWords(ms) {
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours < 1) return 'within the hour';
  if (hours < 48) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in ${Math.floor(ms / DAY)} days`;
}

/**
 * Health checks. Levels: ok, info, warn, bad. Checks report; fixes stay with the human
 * (removing an env var or a proxy entry is an explicit choice, not a side effect).
 */
export async function runChecks({
  accounts = [],
  env = { user: readUserEnv, machine: readMachineEnv },
  fetchImpl = fetch,
  now = Date.now(),
} = {}) {
  const checks = [];

  // 1. API keys silently outrank subscription logins in Claude Code's auth precedence.
  //    User-scope entries get a one-click fix; machine scope needs an admin terminal.
  const overrides = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']
    .map((n) => ({ name: n, scopes: scopesWith(n, env) }))
    .filter((h) => h.scopes.length > 0);
  if (overrides.length === 0) {
    checks.push({ id: 'billing-override', level: 'ok', title: 'No API key overriding subscription billing', detail: 'ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN not set at machine or user scope' });
  } else {
    for (const h of overrides) {
      checks.push({
        id: `billing-override-${h.name}`,
        level: 'bad',
        title: `${h.name} would override subscription billing`,
        detail: `Set at ${h.scopes.join(' and ')} scope. New Claude runs would bill the API, not the subscription.` + (h.scopes.includes('machine') ? ' Machine scope must be removed from an admin terminal.' : ''),
        fix: h.scopes.includes('user') ? { action: 'remove-user-env', args: { name: h.name }, label: 'Remove (user scope)', confirm: `Remove ${h.name} from your user environment? New processes will stop using it; running processes are unchanged.` } : undefined,
      });
    }
  }

  // 2. A persistent OAuth token outranks the config-folder login, so switching folders
  //    would change nothing for CLI runs until the token is removed.
  const pinScopes = scopesWith('CLAUDE_CODE_OAUTH_TOKEN', env);
  if (pinScopes.length > 0) {
    checks.push({
      id: 'token-pin',
      level: 'warn',
      title: 'A persistent Claude token pins every run to one account',
      detail: `CLAUDE_CODE_OAUTH_TOKEN is set at ${pinScopes.join(' and ')} scope. It outranks the config-folder login, so account switching will not change what CLI runs bill until it is removed.` + (pinScopes.includes('machine') ? ' Machine scope must be removed from an admin terminal.' : ''),
      fix: pinScopes.includes('user') ? { action: 'remove-user-env', args: { name: 'CLAUDE_CODE_OAUTH_TOKEN' }, label: 'Remove (user scope)', confirm: 'Remove CLAUDE_CODE_OAUTH_TOKEN from your user environment? New processes will use each account folder\'s own login instead, which is what makes switching real. Running processes keep working; anything that needs a fixed token should carry its own.' } : undefined,
    });
  }

  // 3. Per-account credential state, from each account's own vendor folder.
  for (const a of accounts) {
    const def = PROVIDERS[a.provider];
    if (!def) continue;
    const credPath = path.join(a.home, def.credFile);
    if (!fs.existsSync(credPath)) {
      checks.push({ id: `cred-${a.id}`, level: 'warn', title: `${def.name} "${a.label}" is not signed in`, detail: `No ${def.credFile} in ${a.home}. Sign in with: ${def.loginHint}` });
      continue;
    }
    let detail = 'Signed in';
    let level = 'ok';
    if (a.provider === 'claude') {
      try {
        const oauth = JSON.parse(fs.readFileSync(credPath, 'utf8'))?.claudeAiOauth ?? {};
        ({ level, detail } = claudeLoginState(oauth, now));
      } catch { /* unreadable credential file: presence already counts as signed in */ }
    }
    checks.push({ id: `cred-${a.id}`, level, title: `${def.name} "${a.label}" signed in`, detail });
  }

  // 4. A Codex config that routes through a custom endpoint fails opaquely when that
  //    endpoint is down. Flag any non-default base_url so the failure has a name.
  for (const a of accounts.filter((x) => x.provider === 'codex')) {
    try {
      const toml = fs.readFileSync(path.join(a.home, 'config.toml'), 'utf8');
      for (const m of toml.matchAll(/^\s*base_url\s*=\s*"([^"]+)"/gm)) {
        const url = m[1];
        if (!/openai\.com|chatgpt\.com/i.test(url)) {
          checks.push({
            id: `codex-baseurl-${a.id}`,
            level: 'warn',
            title: `Codex "${a.label}" routes through a custom endpoint`,
            detail: `config.toml sets base_url = ${url}. Runs fail if it is not listening; remove the entry to go direct.`,
            fix: { action: 'codex-remove-baseurl', args: { home: a.home }, label: 'Remove entry', confirm: `Comment out the custom base_url line in ${a.label}'s config.toml? A timestamped backup of the file is written first.` },
          });
        }
      }
    } catch { /* no config.toml is fine */ }
  }

  // 5. Local runtime reachability, informational only.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1500);
    const resp = await fetchImpl('http://127.0.0.1:11434/api/version', { signal: controller.signal }).finally(() => clearTimeout(timer));
    if (resp.ok) checks.push({ id: 'ollama', level: 'ok', title: 'Ollama service is running', detail: 'Local models are available' });
  } catch {
    checks.push({ id: 'ollama', level: 'info', title: 'Ollama service not running', detail: 'Start it to use local models' });
  }

  return checks;
}
