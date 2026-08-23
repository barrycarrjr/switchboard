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

/**
 * Percent-only conversion to a 0-100 integer, shared by every usage source here.
 *
 * Every source reports percentages, never 0-1 fractions: the usage endpoint sends
 * "utilization": 1.0 for an account that has used ONE percent, and says so twice in
 * the same reply ("limits":[{"kind":"weekly_all","percent":1}]). Reading a value of
 * 1 or less as a fraction therefore turns 1% into 100%, which shows a healthy account
 * as "limit reached" and lets the quota watch switch away from it. Verified against a
 * live response on 2026-08-21.
 */
export function toExactPercent(value) {
  if (value == null || Number.isNaN(Number(value))) return null;
  return Math.max(0, Math.min(100, Math.round(Number(value))));
}

/** For the one genuine ratio in this file: extra-usage credits spent over the cap. */
export function fractionToPercent(fraction) {
  if (fraction == null || Number.isNaN(Number(fraction))) return null;
  return toExactPercent(Number(fraction) * 100);
}

/** Normalize a reset timestamp (epoch seconds, epoch ms, or ISO string) to epoch ms. */
export function toEpochMs(value) {
  if (value == null) return null;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The window each entry of the endpoint's `limits` array describes. The keys are the
 * contract the rest of the app reads by name (see core/lanes-util.js), so a limit that
 * is not one of these may never take their key.
 */
const LIMIT_KINDS = {
  session: ['session', 'Session (5h)'],
  weekly_all: ['week', 'Week (all models)'],
  weekly_opus: ['week_opus', 'Week (Opus)'],
  weekly_sonnet: ['week_sonnet', 'Week (Sonnet)'],
};

function humanKind(kind) {
  const text = String(kind ?? '').replace(/_/g, ' ').trim();
  return text ? text[0].toUpperCase() + text.slice(1) : 'Usage';
}

/**
 * One entry of the `limits` array. An unfamiliar kind is still a real limit, so it is
 * named from what the reply itself says rather than dropped; `used` keeps every key
 * distinct so one window can never overwrite another.
 */
function limitWindow(limit, used) {
  if (!limit || limit.percent == null) return null;
  const model = typeof limit.scope?.model?.display_name === 'string' && limit.scope.model.display_name.length
    ? limit.scope.model.display_name
    : null;
  let [key, label] = LIMIT_KINDS[limit.kind] ?? [];
  if (!key) {
    const slug = String(model ?? limit.kind ?? 'usage').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    key = (String(limit.kind ?? '').startsWith('weekly') ? `week_${slug}` : slug) || 'usage';
    label = model ? `Week (${model})` : humanKind(limit.kind);
  }
  while (used.has(key)) key += '2';
  used.add(key);
  return { key, label, usedPercent: toExactPercent(limit.percent), resetsAt: toEpochMs(limit.resets_at) };
}

/**
 * Map the usage endpoint's body into display windows. Pure, so it is testable and so a
 * silent change in the (undocumented) endpoint shows up as nulls, never as invented data.
 *
 * `limits` is preferred because it states each window's kind and integer percent
 * outright; the named objects are the older shape and are read only when it is absent.
 */
export function mapUsage(body) {
  const windows = [];
  const used = new Set();
  const push = (key, label, w) => {
    if (!w) return;
    used.add(key);
    windows.push({ key, label, usedPercent: toExactPercent(w.utilization), resetsAt: toEpochMs(w.resets_at) });
  };
  if (Array.isArray(body.limits) && body.limits.length > 0) {
    for (const limit of body.limits) {
      const window = limitWindow(limit, used);
      if (window) windows.push(window);
    }
  } else {
    push('session', 'Session (5h)', body.five_hour);
    push('week', 'Week (all models)', body.seven_day);
    push('week_sonnet', 'Week (Sonnet)', body.seven_day_sonnet);
    push('week_opus', 'Week (Opus)', body.seven_day_opus);
  }
  const extra = body.extra_usage;
  if (extra) {
    const enabled = extra.is_enabled !== false;
    const used_credits = Number(extra.used_credits);
    const limit = Number(extra.monthly_limit);
    const share = extra.utilization != null
      ? toExactPercent(extra.utilization)
      : (limit > 0 ? fractionToPercent(used_credits / limit) : null);
    windows.push({
      key: 'extra',
      label: 'Extra usage',
      usedPercent: enabled ? share : null,
      resetsAt: null,
      // the endpoint reports cents
      valueLabel: enabled && Number.isFinite(used_credits) && Number.isFinite(limit)
        ? `$${(used_credits / 100).toFixed(2)} / $${(limit / 100).toFixed(2)}`
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
 * Which account a Claude Desktop profile folder is signed in as, read from the
 * organization stamped on its newest usage sample. Identity only: no percentages and
 * no credentials, and nothing is inferred from the folder's name or its position on
 * disk, so an unsampled profile answers "unknown" rather than guessing.
 */
export function readDesktopOrganization(profileDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(profileDir, 'plan-usage-history.json'), 'utf8'));
    const samples = Array.isArray(parsed?.samples) ? parsed.samples : [];
    const newest = samples.reduce((best, sample) => {
      if (!sample || typeof sample.t !== 'number' || typeof sample.org !== 'string' || !sample.org) return best;
      return !best || sample.t > best.t ? sample : best;
    }, null);
    return newest?.org ?? null;
  } catch {
    return null;
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
      return { windows: await fetchClaudeQuota(token, fetchImpl), source: 'token', vendor: 'Anthropic' };
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
 * Two sources, same ladder as Claude. The account's own ChatGPT sign-in can ask
 * OpenAI what it has spent, which is a live answer costing nothing. When that is
 * refused (a token the CLI has not refreshed in a while) or the machine is offline,
 * the CLI's own session log still holds every rate-limit reply it has received, so
 * the newest one is a real answer with a real timestamp. A snapshot is worth more
 * than a blank card as long as its age is shown rather than passed off as live.
 * ------------------------------------------------------------------------- */

const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

/** How old a session snapshot may be before it is called stale rather than current. */
export const CODEX_STALE_MS = 24 * 60 * 60 * 1000;

const CODEX_TAIL_BYTES = 256 * 1024;
const CODEX_FILES_SCANNED = 8;

/**
 * Read the ChatGPT access token from a Codex config home, transiently. The token is
 * returned to the caller for one request and never stored, logged or rewritten: the
 * CLI owns auth.json, and refreshing it here could rotate the refresh token out from
 * under the CLI and sign the account out. An expired token is left to expire.
 */
export function readCodexAuth(home) {
  try {
    const tokens = JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))?.tokens;
    const token = tokens?.access_token;
    if (typeof token !== 'string' || token.length === 0) return null;
    return {
      token,
      accountId: typeof tokens.account_id === 'string' && tokens.account_id.length > 0 ? tokens.account_id : null,
    };
  } catch {
    return null;
  }
}

// Codex reports 6.0 meaning six percent, so it shares toExactPercent above.

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
    // A window whose length the vendor did not state is not filed as a week anyway:
    // the lane rules read these keys by name, so a guess there becomes a wrong rule.
    const known = Number.isFinite(minutes) && minutes > 0;
    let key = !known ? 'usage' : minutes <= 1440 ? 'session' : 'week';
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

/**
 * The live endpoint and the session log describe the same windows in different units:
 * the endpoint counts seconds and calls the reset `reset_at`, the log counts minutes
 * and calls it `resets_at`. Normalizing here means one mapper, one set of window keys
 * and one label table serve both, so the card cannot say two different things
 * depending on which source answered.
 */
export function codexLiveRateLimits(body) {
  const window = (w) => {
    if (!w || w.used_percent == null) return null;
    const seconds = Number(w.limit_window_seconds);
    return {
      used_percent: w.used_percent,
      window_minutes: Number.isFinite(seconds) && seconds > 0 ? seconds / 60 : null,
      resets_at: w.reset_at ?? null,
    };
  };
  const limit = body?.rate_limit ?? {};
  return {
    primary: window(limit.primary_window),
    secondary: window(limit.secondary_window),
    credits: body?.credits ?? null,
    plan_type: body?.plan_type ?? null,
  };
}

/**
 * Ask OpenAI what this Codex sign-in has spent. Throws on any non-OK response, and on
 * a reply carrying no recognizable window, so that callers fall back to the last
 * session snapshot instead of showing an empty card as though it were a reading.
 */
export async function fetchCodexQuota(auth, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const headers = { authorization: `Bearer ${auth.token}`, originator: 'codex_cli_rs' };
    if (auth.accountId) headers['chatgpt-account-id'] = auth.accountId;
    const resp = await fetchImpl(CODEX_USAGE_URL, { headers, signal: controller.signal });
    if (!resp.ok) {
      const err = new Error(`codex usage endpoint returned ${resp.status}`);
      err.status = resp.status;
      throw err;
    }
    const body = await resp.json();
    const windows = mapCodexRateLimits(codexLiveRateLimits(body));
    if (windows.length === 0) throw new Error('codex usage endpoint returned no recognized window');
    return { windows, plan: body?.plan_type ?? null };
  } finally {
    clearTimeout(timer);
  }
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
 * The snapshot source: the newest rate-limit reply this account's own session logs
 * hold. Never throws; an account that has not run yet reports that, rather than zero.
 */
export function codexSessionQuota(home, now = Date.now()) {
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
 * Quota for one registered Codex account. Never throws; unknown is reported, not
 * guessed. Ladder: the account's own ChatGPT sign-in, then the newest session
 * snapshot (kept, but labelled with why it is standing in), then honest
 * unavailability. A live reading that fails must never erase a snapshot that exists.
 */
export async function codexAccountQuota(home, fetchImpl = fetch, now = Date.now()) {
  const auth = readCodexAuth(home);
  let tokenError = null;
  if (auth) {
    try {
      const live = await fetchCodexQuota(auth, fetchImpl);
      return { windows: live.windows, source: 'token', plan: live.plan, vendor: 'OpenAI' };
    } catch (e) {
      // 401/403 means the stored token is stale; the CLI refreshes it on its next
      // real use, which is why the card says to run Codex once. 429 means we asked
      // too often. Everything else (offline, endpoint moved) is plain unavailable.
      if (e.status === 401 || e.status === 403) tokenError = { error: 'auth' };
      else if (e.status === 429) tokenError = { error: 'rate-limited' };
      else tokenError = { error: 'unavailable' };
    }
  }
  const snapshot = codexSessionQuota(home, now);
  if (!snapshot.error) return tokenError ? { ...snapshot, fallbackReason: tokenError.error } : snapshot;
  return tokenError ?? snapshot;
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
  if (provider === 'codex') return codexAccountQuota(home, fetchImpl, now);
  return { error: 'unsupported' };
}
