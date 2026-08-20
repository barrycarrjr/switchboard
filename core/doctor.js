import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readUserEnv, readMachineEnv } from './env.js';
import { accountScopedEnv, CLAUDE_CREDENTIAL_ENV_VARS, PROVIDERS } from './accounts.js';
import { toEpochMs } from './quota.js';

const runFile = promisify(execFile);

const DAY = 24 * 60 * 60 * 1000;
const CLAUDE_AUTH_STATUS_ARGS = Object.freeze(['auth', 'status', '--json']);
const WINDOWS_BATCH_SHIM = /\.(?:cmd|bat)$/i;

/**
 * Build the deliberately fixed Claude status command without asking Node for a shell.
 *
 * Native executables can be passed straight to `execFile`, including absolute paths with
 * spaces. Windows npm shims are batch files, though, so CreateProcess cannot run them
 * directly. For those only, invoke cmd.exe explicitly with AutoRun and delayed expansion
 * disabled. The executable is the sole interpolated value; it stays inside quotes, and
 * characters that cmd expands even inside quotes are rejected. The status arguments are
 * constants rather than command input.
 */
export function claudeAuthStatusLaunch(executable = 'claude') {
  const file = String(executable ?? '').trim();
  if (!file) throw new Error('Claude executable is required');

  if (!WINDOWS_BATCH_SHIM.test(file)) {
    return {
      file,
      args: [...CLAUDE_AUTH_STATUS_ARGS],
      options: { shell: false },
    };
  }

  // Quotes and control characters cannot occur in a normal Windows filename. Percent is
  // legal but would trigger cmd.exe environment expansion even inside a quoted token, so
  // decline that pathological path rather than risk executing a different command.
  if (/[\u0000-\u001f"%]/.test(file)) {
    throw new Error('Unsafe Claude batch-shim path');
  }

  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', `""${file}" auth status --json"`],
    options: {
      shell: false,
      // Preserve the canonical cmd.exe /s /c outer-quote form above. Node must not apply
      // a second Windows argv quoting pass to the command string.
      windowsVerbatimArguments: true,
    },
  };
}

function scopesWith(name, env) {
  const hits = [];
  if (env.user(name)) hits.push('user');
  if (env.machine(name)) hits.push('machine');
  if (typeof env.process === 'function' && env.process(name)) hits.push('current process');
  return hits;
}

function readProcessEnv(name) {
  const wanted = String(name).toUpperCase();
  const hit = Object.entries(process.env).find(([key]) => key.toUpperCase() === wanted);
  return hit?.[1] ?? null;
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

/**
 * Login state for one account, for the Accounts page as well as the Health tab.
 *
 * The Accounts page offers "Sign in / re-authenticate" on every card, and without this the
 * link reads the same whether the login is good for a month or ran out yesterday. Saying
 * which gives the link a reason.
 *
 * Only Claude publishes a login expiry. Codex writes short-lived tokens and no stamp for
 * the login behind them, so it reports being signed in and nothing more. Inventing a date
 * from the token it does have would repeat the mistake this check was just fixed for.
 */
export function accountLoginState(account, now = Date.now(), readFile = fs.readFileSync) {
  const def = PROVIDERS[account?.provider];
  if (!def) return { signedIn: false, level: 'warn', detail: 'Unknown provider' };
  const credPath = path.join(account.home, def.credFile);
  if (!fs.existsSync(credPath)) {
    return { signedIn: false, level: 'warn', detail: 'Not signed in' };
  }
  if (account.provider !== 'claude') return { signedIn: true, level: 'ok', detail: 'Signed in' };
  try {
    const oauth = JSON.parse(readFile(credPath, 'utf8'))?.claudeAiOauth ?? {};
    // Claude leaves a metadata tombstone behind when a refresh token is rejected:
    // empty credentials plus the old plan and refresh-expiry stamps. File existence and
    // that stale date are not proof of a usable login.
    const hasAccess = typeof oauth.accessToken === 'string' && oauth.accessToken.length > 0;
    const hasRefresh = typeof oauth.refreshToken === 'string' && oauth.refreshToken.length > 0;
    if (!hasAccess && !hasRefresh) {
      return { signedIn: false, level: 'warn', detail: 'Not signed in' };
    }
    return { signedIn: true, ...claudeLoginState(oauth, now) };
  } catch {
    return { signedIn: null, level: 'info', detail: 'Sign-in status unavailable' };
  }
}

/**
 * Parse the deliberately small, non-secret result of `claude auth status --json`.
 * Raw command output never leaves this module.
 */
export function parseClaudeAuthStatus(raw) {
  try {
    const parsed = JSON.parse(String(raw ?? '').trim());
    if (!parsed || typeof parsed.loggedIn !== 'boolean') return null;
    return {
      loggedIn: parsed.loggedIn,
      authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
      apiProvider: typeof parsed.apiProvider === 'string' ? parsed.apiProvider : null,
      email: typeof parsed.email === 'string' ? parsed.email : null,
      organizationUuid: typeof parsed.orgId === 'string' ? parsed.orgId : null,
      organizationName: typeof parsed.orgName === 'string' ? parsed.orgName : null,
      plan: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null,
    };
  } catch {
    return null;
  }
}

/**
 * Ask Claude itself whether this account home is signed in. This is authoritative
 * across credential-format changes and never reads or returns the credential itself.
 */
export async function verifiedAccountLoginState(account, {
  runImpl = runFile,
  executable = 'claude',
  now = Date.now(),
} = {}) {
  const fallback = accountLoginState(account, now);
  if (account?.provider !== 'claude') return fallback;

  const env = accountScopedEnv(account, process.env);

  let raw = null;
  try {
    const launch = claudeAuthStatusLaunch(executable);
    const result = await runImpl(launch.file, launch.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 64 * 1024,
      ...launch.options,
      env,
    });
    raw = result?.stdout;
  } catch (error) {
    // Logged out is an expected exit-1 with valid JSON on stdout.
    raw = error?.stdout;
  }

  const status = parseClaudeAuthStatus(raw);
  if (!status) {
    // A failed/missing probe cannot disprove a secure-store login. Only valid vendor
    // JSON may establish a verified result in either direction.
    return { signedIn: null, level: 'info', detail: 'Sign-in status unavailable', verified: false };
  }
  if (!status.loggedIn) {
    return { signedIn: false, level: 'warn', detail: 'Not signed in', verified: true };
  }
  const isSubscription = status.authMethod === 'claude.ai'
    && (status.apiProvider == null || status.apiProvider === 'firstParty');
  if (!isSubscription) {
    const method = status.authMethod === 'api_key'
      ? 'API-key authentication'
      : status.authMethod ? `${status.authMethod} authentication` : 'non-subscription authentication';
    return {
      signedIn: false,
      level: 'warn',
      detail: `Claude is using ${method}, not this Claude subscription login`,
      verified: true,
      authMethod: status.authMethod,
      apiProvider: status.apiProvider,
    };
  }
  const localDetail = fallback.signedIn === true
    ? { level: fallback.level, detail: fallback.detail }
    : { level: 'ok', detail: 'Signed in' };
  return {
    signedIn: true,
    ...localDetail,
    verified: true,
    authMethod: status.authMethod,
    apiProvider: status.apiProvider,
    email: status.email,
    organizationUuid: status.organizationUuid,
    organizationName: status.organizationName,
    plan: status.plan,
  };
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
  loginStates = {},
  env = { user: readUserEnv, machine: readMachineEnv, process: readProcessEnv },
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

  // Other persistent credential/routing inputs can bypass CLAUDE_CONFIG_DIR just as
  // completely as an API key. Keep API keys and the common OAuth pin in their more
  // specific checks below; name every remaining override here.
  const routeOverrides = CLAUDE_CREDENTIAL_ENV_VARS
    .filter((name) => !['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_SCOPES'].includes(name))
    .map((name) => ({ name, scopes: scopesWith(name, env) }))
    .filter((hit) => hit.scopes.length > 0);
  for (const hit of routeOverrides) {
    checks.push({
      id: `routing-override-${hit.name}`,
      level: 'warn',
      title: `${hit.name} overrides per-account Claude routing`,
      detail: `Set at ${hit.scopes.join(' and ')} scope. New default Claude sessions may ignore the account folder selected in Switchboard.` + (hit.scopes.includes('machine') ? ' Machine scope must be removed from an admin terminal.' : ''),
      fix: hit.scopes.includes('user') ? { action: 'remove-user-env', args: { name: hit.name }, label: 'Remove (user scope)', confirm: `Remove ${hit.name} from your user environment? New Claude sessions will use the selected account folder; running processes are unchanged.` } : undefined,
    });
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
    const login = Object.prototype.hasOwnProperty.call(loginStates, a.id)
      ? loginStates[a.id]
      : accountLoginState(a, now);
    const state = login.signedIn === true ? 'signed in' : login.signedIn === false ? 'is not signed in' : 'sign-in is unknown';
    const hint = login.signedIn === false ? ` Sign in with: ${def.loginHint}` : '';
    checks.push({
      id: `cred-${a.id}`,
      level: login.level,
      title: `${def.name} "${a.label}" ${state}`,
      detail: `${login.detail}.${hint}`.replace('..', '.'),
    });
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
