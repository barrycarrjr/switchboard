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

/**
 * Fallback source: the usage history the Claude Desktop app maintains for its own
 * account (plan-usage-history.json). Percentages only; no credentials involved.
 * Only useful when the person has associated a desktop profile folder with an account.
 */
export function readDesktopUsage(profileDir, now = Date.now()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(profileDir, 'plan-usage-history.json'), 'utf8'));
    const last = parsed?.samples?.[parsed.samples.length - 1];
    if (!last || typeof last.t !== 'number' || !last.u) return { error: 'unreadable' };
    const windows = [
      { key: 'session', label: 'Session (5h)', usedPercent: toPercent(last.u.fh), resetsAt: null },
      { key: 'week', label: 'Week (all models)', usedPercent: toPercent(last.u.sd), resetsAt: null },
    ];
    if (last.u.xu != null) {
      windows.push({ key: 'extra', label: 'Extra usage', usedPercent: null, resetsAt: null, valueLabel: `$${Number(last.u.xu).toFixed(2)}` });
    }
    return { windows, source: 'desktop', sampledAt: last.t, stale: now - last.t > DESKTOP_STALE_MS };
  } catch {
    return { error: 'unreadable' };
  }
}

/**
 * Quota for one registered Claude account. Never throws; unknown is reported, not
 * guessed. Ladder: the account's own token, then an associated Claude Desktop
 * profile's usage history, then honest unavailability.
 */
export async function accountQuota(home, fetchImpl = fetch, usageSource = null, now = Date.now()) {
  const token = readAccessToken(home);
  if (token) {
    try {
      return { windows: await fetchClaudeQuota(token, fetchImpl), source: 'token' };
    } catch (e) {
      // 401/403 means the stored access token is stale; the vendor CLI refreshes it
      // on its next real use. 429 means we asked too often; callers should serve
      // their cached numbers rather than an error.
      if (e.status === 401 || e.status === 403) return { error: 'auth' };
      if (e.status === 429) return { error: 'rate-limited' };
      return { error: 'unavailable' };
    }
  }
  if (usageSource) {
    const desktop = readDesktopUsage(usageSource, now);
    if (!desktop.error) return desktop;
  }
  return { error: 'no-credentials' };
}
