import fs from 'node:fs';
import { PROVIDERS, activeAccount, activeHome } from './accounts.js';
import { accountLoginState } from './doctor.js';
import { sharedProviderQuota } from './quota-cache.js';
import { readUserEnv } from './env.js';

/**
 * One reading of everything Switchboard knows about accounts: which folder each tool
 * will use next, which registered account that is, whether it is signed in, and how
 * how much of each available limit it has used.
 *
 * It exists so the whole picture is available without the tray: away from the machine,
 * `switchboard status` is the only way to see it, and a person reading it remotely
 * needs the "as of" stamps as much as the numbers.
 */
export async function collectStatus({
  registry,
  settings = {},
  fetchImpl = fetch,
  envReader = readUserEnv,
  now = Date.now(),
} = {}) {
  const usageSources = settings.usageSources ?? {};
  const providers = await Promise.all(Object.values(PROVIDERS).map(async (def) => {
    const home = activeHome(def.id, envReader);
    const active = activeAccount(registry, def.id, envReader);
    const mine = registry.accounts.filter((a) => a.provider === def.id);
    const accounts = await Promise.all(mine.map(async (a) => {
      const login = accountLoginState(a, now);
      const quota = def.quota && login.signedIn
        ? await sharedProviderQuota(a, { fetchImpl, usageSource: usageSources[a.id] ?? null, now })
        : null;
      return { id: a.id, label: a.label, home: a.home, active: active?.id === a.id, login, quota };
    }));
    return {
      id: def.id,
      name: def.name,
      envVar: def.envVar,
      envValue: envReader(def.envVar),
      activeHome: home,
      activeHomeExists: fs.existsSync(home),
      activeAccountId: active?.id ?? null,
      hasQuota: Boolean(def.quota),
      quotaNote: def.quotaNote ?? null,
      accounts,
    };
  }));
  return { generatedAt: now, providers };
}

function bar(percent, width = 20) {
  const filled = Math.round((Math.max(0, Math.min(100, percent)) / 100) * width);
  return `[${'#'.repeat(filled)}${'.'.repeat(width - filled)}]`;
}

function when(ms) {
  return new Date(ms).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
}

function ago(ms, now) {
  const minutes = Math.round((now - ms) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.round(hours / 24)} days ago`;
}

const QUOTA_REASONS = {
  'no-credentials': 'usage unavailable: no access credential or matching Claude Desktop sample',
  auth: 'usage unavailable: the sign-in needs a refresh (run this account once, or re-authenticate it in Switchboard)',
  'rate-limited': 'usage unavailable: the endpoint is rate-limiting checks; it returns on its own shortly',
  'no-usage-data': 'no usage recorded yet: run this account once and the figures appear',
  unsupported: 'no usage source for this tool',
  unavailable: 'usage unavailable right now',
};

function quotaLines(quota, now) {
  if (!quota) return [];
  if (quota.error) return [QUOTA_REASONS[quota.error] ?? QUOTA_REASONS.unavailable];
  const lines = [];
  for (const w of quota.windows) {
    const value = w.usedPercent == null
      ? (w.valueLabel ?? 'n/a')
      : `${bar(w.usedPercent)} ${String(w.usedPercent).padStart(3)}%${w.valueLabel ? `  ${w.valueLabel}` : ''}`;
    const resets = w.resetsAt ? `   resets ${when(w.resetsAt)}` : '';
    lines.push(`${w.label.padEnd(18)}${value}${resets}`);
  }
  const notes = [];
  if (quota.plan) notes.push(`plan: ${quota.plan}`);
  if (quota.source === 'session-log') notes.push(`from this account's last session, ${ago(quota.sampledAt, now)}`);
  if (quota.source === 'desktop') notes.push(`via Claude Desktop, sampled ${ago(quota.sampledAt, now)}`);
  if (quota.stale) notes.push('stale');
  if (notes.length) lines.push(`(${notes.join('; ')})`);
  return lines;
}

/** The plain-text breakdown. Pure, so what the terminal shows is covered by tests. */
export function formatStatus(status) {
  const out = [];
  const now = status.generatedAt;
  for (const p of status.providers) {
    out.push(`${p.name}   ${p.envVar}=${p.envValue ?? '(unset)'}`);
    if (p.accounts.length === 0) {
      out.push(p.activeHomeExists
        ? `  no accounts registered; the folder in use is ${p.activeHome}`
        : `  not set up on this machine (no ${p.activeHome})`);
      out.push('');
      continue;
    }
    if (!p.activeAccountId) out.push(`  ! the active folder is not registered: ${p.activeHome}`);
    for (const a of p.accounts) {
      out.push(`  ${a.active ? '*' : ' '} ${a.label}`);
      out.push(`      ${a.home}`);
      out.push(`      ${a.login.detail}`);
      for (const line of quotaLines(a.quota, now)) out.push(`      ${line}`);
      if (!p.hasQuota && p.quotaNote && a.active) out.push(`      ${p.quotaNote}`);
    }
    out.push('');
  }
  out.push(`as of ${new Date(now).toLocaleString()}`);
  return out.join('\n');
}
