import fs from 'node:fs';
import path from 'node:path';

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Read the OAuth access token from a Claude config home, transiently.
 * The token is returned to the caller for one request and never stored or logged.
 */
export function readAccessToken(home) {
  try {
    const raw = fs.readFileSync(path.join(home, '.credentials.json'), 'utf8');
    const token = JSON.parse(raw)?.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/** Convert a utilization value to a 0-100 integer. Accepts 0-1 fractions or 0-100 percents. */
export function toPercent(utilization) {
  if (utilization == null || Number.isNaN(Number(utilization))) return null;
  const n = Number(utilization);
  return Math.max(0, Math.min(100, Math.round(n <= 1 ? n * 100 : n)));
}

/** Normalize a reset timestamp (epoch seconds, epoch ms, or ISO string) to epoch ms. */
export function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Map the usage endpoint's body into display windows. Pure, so it is testable and so a
 * silent change in the (undocumented) endpoint shows up as nulls, never as invented data.
 */
export function mapUsage(body) {
  const windows = [];
  const push = (key, label, w) => {
    if (!w) return;
    windows.push({ key, label, usedPercent: toPercent(w.utilization), resetsAt: toEpochMs(w.resets_at) });
  };
  push('session', 'Session (5h)', body.five_hour);
  push('week', 'Week (all models)', body.seven_day);
  push('week_sonnet', 'Week (Sonnet)', body.seven_day_sonnet);
  push('week_opus', 'Week (Opus)', body.seven_day_opus);
  const extra = body.extra_usage;
  if (extra) {
    const enabled = extra.is_enabled !== false;
    const used = Number(extra.used_credits);
    const limit = Number(extra.monthly_limit);
    windows.push({
      key: 'extra',
      label: 'Extra usage',
      usedPercent: enabled ? toPercent(extra.utilization ?? (limit > 0 ? used / limit : null)) : null,
      resetsAt: null,
      // the endpoint reports cents
      valueLabel: enabled && Number.isFinite(used) && Number.isFinite(limit)
        ? `$${(used / 100).toFixed(2)} / $${(limit / 100).toFixed(2)}`
        : (enabled ? null : 'Not enabled'),
    });
  }
  return windows;
}

/** Fetch usage for one token. Throws on any non-OK response; callers show "unavailable". */
export async function fetchClaudeQuota(token, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const resp = await fetchImpl(USAGE_URL, {
      headers: { authorization: `Bearer ${token}`, 'anthropic-beta': OAUTH_BETA },
      signal: controller.signal,
    });
    if (!resp.ok) {
      const err = new Error(`usage endpoint returned ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    return mapUsage(await resp.json());
  } finally {
    clearTimeout(timer);
  }
}

export const DESKTOP_STALE_MS = 15 * 60 * 1000;

/** The standard Claude Desktop profile on Windows, when one is available. */
export function defaultClaudeDesktopProfile(env = process.env) {
  return typeof env.APPDATA === 'string' && env.APPDATA.length > 0
    ? path.join(env.APPDATA, 'Claude')
    : null;
}

/**
 * Read only the stable, non-secret identity used to match this Claude account to
 * Claude Desktop's usage samples. Never infer identity from folder order or recency.
 */
export function readClaudeAccountIdentity(home) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8'));
    const oauth = parsed?.oauthAccount;
    const organizationUuid = typeof oauth?.organizationUuid === 'string' && oauth.organizationUuid.length > 0
      ? oauth.organizationUuid
      : null;
    const accountUuid = typeof oauth?.accountUuid === 'string' && oauth.accountUuid.length > 0
      ? oauth.accountUuid
      : null;
    return organizationUuid ? { organizationUuid, accountUuid } : null;
  } catch {
    return null;
  }
}

/**
 * Fallback source: the usage history the Claude Desktop app maintains for its accounts
 * (plan-usage-history.json). Percentages only; no credentials involved. Callers pass the
 * expected organization so a recent sample from another Desktop login is never borrowed.
 */
export function readDesktopUsage(profileDir, now = Date.now(), expectedOrganizationUuid = null) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(profileDir, 'plan-usage-history.json'), 'utf8'));
    const samples = Array.isArray(parsed?.samples) ? parsed.samples : [];
    const matching = samples.filter((sample) => (
      sample
      && typeof sample.t === 'number'
      && sample.u
      && (!expectedOrganizationUuid || sample.org === expectedOrganizationUuid)
    ));
    const last = matching.reduce((newest, sample) => (!newest || sample.t > newest.t ? sample : newest), null);
    if (!last) return { error: expectedOrganizationUuid ? 'no-matching-account' : 'unreadable' };
    const sessionUsed = toExactPercent(last.u.fh);
    const weekUsed = toExactPercent(last.u.sd);
    // A matching row with an unrecognized payload is not a reading. Treating it as
    // success would let an old/malformed profile hide a newer valid Desktop source.
    if (sessionUsed == null && weekUsed == null) return { error: 'unreadable' };
    const windows = [
      // Desktop history already stores percentages (including the value 1 for one
      // percent), unlike the usage endpoint's fractional schema.
      { key: 'session', label: 'Session (5h)', usedPercent: sessionUsed, resetsAt: null },
      { key: 'week', label: 'Week (all models)', usedPercent: weekUsed, resetsAt: null },
    ];
    const extraUsed = Number(last.u.xu);
    if (last.u.xu != null && Number.isFinite(extraUsed)) {
      windows.push({ key: 'extra', label: 'Extra usage', usedPercent: null, resetsAt: null, valueLabel: `$${extraUsed.toFixed(2)}` });
    }
    return {
      windows,
      source: 'desktop',
      sampledAt: last.t,
      stale: now - last.t > DESKTOP_STALE_MS,
      organizationUuid: typeof last.org === 'string' ? last.org : null,
    };
  } catch {
    return { error: 'unreadable' };
  }
}

/**
 * Quota for one registered Claude account. Never throws; unknown is reported, not
 * guessed. Ladder: the account's own token, then an associated Claude Desktop
 * profile's identity-matched usage history, then honest unavailability.
 */
export async function accountQuota(
  home,
  fetchImpl = fetch,
  usageSource = null,
  now = Date.now(),
  desktopProfile = defaultClaudeDesktopProfile(),
  allowDesktopFallback = true,
) {
  const token = readAccessToken(home);
  let tokenError = null;
  if (token) {
    try {
      return { windows: await fetchClaudeQuota(token, fetchImpl), source: 'token' };
    } catch (e) {
      // 401/403 means the stored access token is stale; the vendor CLI refreshes it
      // on its next real use. 429 means we asked too often; callers should serve
      // their cached numbers rather than an error.
      if (e.status === 401 || e.status === 403) tokenError = { error: 'auth' };
      else if (e.status === 429) tokenError = { error: 'rate-limited' };
      else tokenError = { error: 'unavailable' };
    }
  }

  const identity = readClaudeAccountIdentity(home);
  if (allowDesktopFallback && identity?.organizationUuid) {
    const sources = [...new Set(
      [usageSource, desktopProfile]
        .filter((p) => typeof p === 'string' && p.length > 0)
        .map((p) => path.resolve(p)),
    )];
    const readings = sources
      .map((source) => readDesktopUsage(source, now, identity.organizationUuid))
      .filter((desktop) => !desktop.error)
      .sort((a, b) => (b.sampledAt ?? 0) - (a.sampledAt ?? 0));
    if (readings.length > 0) {
      const desktop = readings[0];
      return tokenError ? { ...desktop, fallbackReason: tokenError.error } : desktop;
    }
  }
  return tokenError ?? { error: 'no-credentials' };
}

/* ------------------------------------------------------------------------- *
 * Codex
 *
 * OpenAI publishes no usage endpoint for Codex subscriptions, but the CLI writes
 * every rate-limit reply it receives into that account's own session log. Reading
 * the newest one is a real answer with a real timestamp, which is worth more than
 * a blank card, as long as the timestamp is shown rather than passed off as live.
 * ------------------------------------------------------------------------- */

/** How old a session snapshot may be before it is called stale rather than current. */
export const CODEX_STALE_MS = 24 * 60 * 60 * 1000;

const CODEX_TAIL_BYTES = 256 * 1024;
const CODEX_FILES_SCANNED = 8;

/** Percent-only conversion: Codex reports 6.0 meaning six percent, never a fraction. */
export function toExactPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

export function codexWindowLabel(minutes) {
  const n = Number(minutes);
  if (!Number.isFinite(n) || n <= 0) return 'Usage';
  if (n === 300) return 'Session (5h)';
  if (n === 10080) return 'Week';
  if (n < 60) return `Last ${n}m`;
  if (n < 1440) return `Last ${Math.round(n / 60)}h`;
  if (n % 1440 === 0) return `Last ${n / 1440}d`;
  return `Last ${Math.round(n / 60)}h`;
}

/** Map one rate_limits record into the same window shape the Claude cards use. */
export function mapCodexRateLimits(limits) {
  if (!limits || typeof limits !== 'object') return [];
  const windows = [];
  const used = new Set();
  const push = (w) => {
    if (!w || w.used_percent == null) return;
    const minutes = Number(w.window_minutes);
    let key = Number.isFinite(minutes) && minutes <= 1440 ? 'session' : 'week';
    while (used.has(key)) key += '2';
    used.add(key);
    windows.push({
      key,
      label: codexWindowLabel(minutes),
      usedPercent: toExactPercent(w.used_percent),
      resetsAt: toEpochMs(w.resets_at),
    });
  };
  push(limits.primary);
  push(limits.secondary);
  const credits = limits.credits;
  if (credits && (credits.unlimited || credits.has_credits)) {
    windows.push({
      key: 'credits',
      label: 'Credits',
      usedPercent: null,
      resetsAt: null,
      valueLabel: credits.unlimited ? 'Unlimited' : String(credits.balance ?? ''),
    });
  }
  return windows;
}

/** Read the last whole lines of a file without pulling a long session into memory. */
function tailLines(file, bytes = CODEX_TAIL_BYTES) {
  let fd;
  try {
    const size = fs.statSync(file).size;
    const length = Math.min(size, bytes);
    const buffer = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    // The first line is cut in half whenever the file is longer than the window.
    if (length < size) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* already gone */ }
  }
}

/**
 * Session logs are filed as sessions/YYYY/MM/DD/rollout-*.jsonl. Walking newest-first
 * by that structure keeps the scan to a handful of files however long the account has
 * been in use.
 */
export function findCodexSessionFiles(home, limit = CODEX_FILES_SCANNED) {
  const root = path.join(home, 'sessions');
  const found = [];
  const descend = (dir, depth) => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth === 3) {
      const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name).sort().reverse();
      for (const name of files) {
        if (found.length >= limit) return;
        found.push(path.join(dir, name));
      }
      return;
    }
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    for (const name of dirs) descend(path.join(dir, name), depth + 1);
  };
  descend(root, 0);
  return found;
}

/** Pull the newest rate_limits record out of one session log, or null. */
export function lastRateLimitsIn(file) {
  const lines = tailLines(file);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.includes('"rate_limits"')) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn or oversized line is skipped, never guessed at
    }
    const limits = parsed?.payload?.rate_limits ?? parsed?.rate_limits;
    if (!limits) continue;
    return { limits, sampledAt: toEpochMs(parsed.timestamp) };
  }
  return null;
}

/**
 * Quota for one registered Codex account, from that account's own session logs.
 * Never throws; an account that has not run yet reports that, rather than zero.
 */
export function codexQuota(home, now = Date.now()) {
  for (const file of findCodexSessionFiles(home)) {
    const hit = lastRateLimitsIn(file);
    if (!hit) continue;
    const windows = mapCodexRateLimits(hit.limits);
    if (windows.length === 0) continue;
    const sampledAt = hit.sampledAt ?? null;
    return {
      windows,
      source: 'session-log',
      sampledAt,
      stale: sampledAt == null || now - sampledAt > CODEX_STALE_MS,
      plan: hit.limits.plan_type ?? null,
    };
  }
  return { error: 'no-usage-data' };
}

/**
 * Usage for any account, routed by what its vendor actually exposes. A provider with
 * no usable source says so once, here, instead of every caller inventing an answer.
 */
export async function providerQuota(provider, home, {
  fetchImpl = fetch,
  usageSource = null,
  desktopProfile = defaultClaudeDesktopProfile(),
  now = Date.now(),
  allowDesktopFallback = true,
} = {}) {
  if (provider === 'claude') return accountQuota(home, fetchImpl, usageSource, now, desktopProfile, allowDesktopFallback);
  if (provider === 'codex') return codexQuota(home, now);
  return { error: 'unsupported' };
}
