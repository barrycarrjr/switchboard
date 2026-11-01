import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { loadRegistry, activeAccount, PROVIDERS } from './accounts.js';
import { accountLoginState } from './doctor.js';
import { loadSettings, saveSettings } from './settings.js';
import { laneStatus, narrowPool, ordersBySoonestReset, selectLaneAsNeeded, soonestResetOrder } from './lanes.js';
import { markLaneTokenDead } from './lane-admin.js';
import { laneTokenFor, laneTokenIdentityMatches } from './lane-tokens.js';
import { readClaudeAccountIdentity, toEpochMs } from './quota.js';
import { lastSharedQuota, sharedProviderQuota } from './quota-cache.js';
import { matchT3Colors, readT3Instances } from './t3colors.js';
import {
  DEFAULT_GATEWAY_PORT,
  DEFAULT_GATEWAY_SCOPE,
  GATEWAY_SCOPES,
  classifyRemoteAddress,
  detectGatewayHostIp,
  listGatewayKeys,
  normalizeGatewayPort,
  normalizeGatewayScope,
  normalizeGatewaySettings,
  normalizeRemoteAddress,
  recordGatewayKeyUse,
  verifyGatewayKey,
} from './gateway-keys.js';

export const GATEWAY_CONTRACT_VERSION = 1;

export const UPSTREAM_TARGETS = {
  claude: 'https://api.anthropic.com',
  codex: 'https://api.openai.com',
};

const MAX_EVENTS = 50;
const DEFAULT_FAILOVER_COOLDOWN_MS = 5 * 60 * 1000;
const SETUP_TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Determine which route a request path belongs to:
 * - 'info'   -> GET /v1/info
 * - 'status' -> GET /v1/switchboard/status or /v1/switchboard/routes
 * - 'lease'  -> GET or POST /v1/lease
 * - 'report' -> POST /v1/lease/report
 * - 'claude' -> POST /v1/messages (metered pass-through only)
 * - 'codex'  -> POST /v1/responses or /v1/chat/completions (metered pass-through only)
 */
export function routeVendorForPath(urlPath) {
  const clean = String(urlPath ?? '').split('?')[0];
  if (clean === '/v1/info') return 'info';
  if (clean === '/v1/switchboard/status' || clean === '/v1/switchboard/routes') return 'status';
  if (clean === '/v1/lease') return 'lease';
  if (clean === '/v1/lease/report') return 'report';
  if (clean.startsWith('/v0/management/')) return 'management';
  if (
    clean === '/v1/messages'
    || clean.startsWith('/v1/messages/')
    || clean.startsWith('/api/event_logging/')
  ) {
    return 'claude';
  }
  if (
    clean === '/v1/responses'
    || clean.startsWith('/v1/responses/')
    || clean === '/v1/chat/completions'
    || clean.startsWith('/v1/chat/completions/')
    || clean === '/v1/models'
    || clean.startsWith('/v1/models/')
  ) {
    return 'codex';
  }
  return null;
}

/**
 * Enumerate the host addresses a worker can use to reach the gateway for a given port.
 */
export function collectBoundAddresses(port = DEFAULT_GATEWAY_PORT, interfaces = os.networkInterfaces()) {
  const localhost = `http://127.0.0.1:${port}`;
  let wsl = null;
  const lan = [];
  const all = [localhost];

  for (const [name, list] of Object.entries(interfaces ?? {})) {
    for (const addr of list ?? []) {
      const fam = addr?.family === 4 || addr?.family === 'IPv4';
      if (!fam || addr.internal) continue;
      const ip = String(addr.address ?? '').trim();
      const kind = classifyRemoteAddress(ip);
      const url = `http://${ip}:${port}`;
      if (kind === 'wsl') {
        if (!wsl || /wsl/i.test(name)) wsl = url;
        if (!all.includes(url)) all.push(url);
      } else if (kind === 'lan') {
        if (!lan.includes(url)) lan.push(url);
        if (!all.includes(url)) all.push(url);
      }
    }
  }

  return {
    localhost,
    wsl: wsl ?? localhost,
    lan,
    all,
  };
}

/**
 * Read a metered API key from an account's config folder when billing === 'metered'.
 * Subscription OAuth tokens are never read here.
 */
export function readMeteredApiKey(provider, account, readFile = fs.readFileSync) {
  if (!account?.home) return null;
  if (provider === 'codex') {
    try {
      const parsed = JSON.parse(readFile(path.join(account.home, 'auth.json'), 'utf8'));
      const key = typeof parsed?.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.trim()
        ? parsed.OPENAI_API_KEY.trim()
        : null;
      return key ? { envVar: 'OPENAI_API_KEY', token: key } : null;
    } catch {
      return null;
    }
  }
  if (provider === 'claude') {
    try {
      const parsed = JSON.parse(readFile(path.join(account.home, '.credentials.json'), 'utf8'));
      const key = typeof parsed?.apiKey === 'string' && parsed.apiKey.trim()
        ? parsed.apiKey.trim()
        : null;
      return key ? { envVar: 'ANTHROPIC_API_KEY', token: key } : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Inspect whether a lane has a usable credential for the broker to hand to a worker.
 * - Claude subscription lane: requires a live, identity-matched setup-token from settings.laneTokens
 *   (unless allowFolder === true for a same-machine Windows caller).
 * - Codex subscription lane: returns the account's identity and codexHomeName (never copies auth.json).
 * - Metered lane: requires a valid API key in the account folder.
 */
export function inspectLaneLeaseCredential(lane, account, settings = {}, { allowFolder = false } = {}) {
  if (!lane || !account) {
    return { ready: false, tokenStatus: 'missing-account', env: {} };
  }
  const provider = String(lane.harness || account.provider || '').toLowerCase();

  if (lane.billing === 'metered') {
    const metered = readMeteredApiKey(provider, account);
    if (!metered) {
      return { ready: false, tokenStatus: 'missing-api-key', env: {} };
    }
    return {
      ready: true,
      tokenStatus: 'metered-key',
      env: { [metered.envVar]: metered.token },
      token: metered.token,
      tokenExpiresAt: null,
    };
  }

  if (provider === 'claude') {
    const tokenEntry = (settings?.laneTokens ?? {})[lane.id];
    const token = laneTokenFor(settings, lane.id);
    if (token) {
      const identity = readClaudeAccountIdentity(account.home);
      if (!laneTokenIdentityMatches(tokenEntry, identity)) {
        return { ready: false, tokenStatus: 'identity-mismatch', env: {} };
      }
      const mintedAt = Number(tokenEntry?.mintedAt) || null;
      const tokenExpiresAt = mintedAt ? new Date(mintedAt + SETUP_TOKEN_LIFETIME_MS).toISOString() : null;
      return {
        ready: true,
        tokenStatus: 'ready',
        env: { CLAUDE_CODE_OAUTH_TOKEN: token },
        token,
        tokenExpiresAt,
      };
    }
    if (tokenEntry?.dead) {
      return {
        ready: false,
        tokenStatus: 'dead',
        deadReason: tokenEntry.deadReason || 'revoked or expired',
        env: {},
      };
    }
    if (allowFolder && account.home) {
      return {
        ready: true,
        tokenStatus: 'folder-only',
        env: { CLAUDE_CONFIG_DIR: account.home },
        tokenExpiresAt: null,
      };
    }
    return {
      ready: false,
      tokenStatus: 'needs-setup-token',
      env: {},
    };
  }

  if (provider === 'codex') {
    return {
      ready: true,
      tokenStatus: 'worker-local-login',
      env: {},
      codexHomeName: path.basename(account.home || `.codex-${account.id}`),
      tokenExpiresAt: null,
    };
  }

  return {
    ready: true,
    tokenStatus: 'ready',
    env: {},
    tokenExpiresAt: null,
  };
}

/**
 * Compute session and weekly headroom (0-100 remaining percentage) and earliest reset ISO
 * timestamp from a quota reading.
 */
export function computeQuotaHeadroom(quota, cooldownUntil = null, now = Date.now()) {
  const windows = Array.isArray(quota?.windows) ? quota.windows : [];
  const sessionWin = windows.find((w) => w.key === 'session');
  const weekWin = windows.find((w) => w.key === 'week');

  const sessionUsed = sessionWin?.usedPercent != null ? Number(sessionWin.usedPercent) : null;
  const weekUsed = weekWin?.usedPercent != null ? Number(weekWin.usedPercent) : null;

  const headroom = {
    session: sessionUsed != null && Number.isFinite(sessionUsed) ? Math.max(0, Math.min(100, 100 - sessionUsed)) : null,
    weekly: weekUsed != null && Number.isFinite(weekUsed) ? Math.max(0, Math.min(100, 100 - weekUsed)) : null,
  };

  const resetCandidates = [];
  if (typeof cooldownUntil === 'number' && cooldownUntil > now) resetCandidates.push(cooldownUntil);
  for (const w of windows) {
    const r = toEpochMs(w?.resetsAt);
    if (typeof r === 'number' && r > now) resetCandidates.push(r);
  }
  resetCandidates.sort((a, b) => a - b);
  const earliestMs = resetCandidates[0] ?? null;

  return {
    headroom,
    sessionUsed,
    weekUsed,
    resetsAtMs: earliestMs,
    resetsAt: earliestMs ? new Date(earliestMs).toISOString() : null,
  };
}

function defaultVendorColor(vendor) {
  return vendor === 'claude' ? '#2563eb' : '#10a37f';
}

function safeMatchT3Colors(registry) {
  try {
    return matchT3Colors(registry, readT3Instances());
  } catch {
    return {};
  }
}

export function binaryForHarness(harness) {
  const clean = String(harness ?? '').toLowerCase();
  if (clean === 'antigravity') return 'agy';
  return clean || 'claude';
}

/**
 * Evaluate and rank all candidate lanes for a provider/request, returning both the selected
 * leaseable lane and full diagnostic metadata for the Gateway tab and /v1/lease.
 */
export async function selectBrokerLease({
  provider = 'claude',
  account = null,
  harnesses = null,
  excludeLanes = [],
  allowFolder = false,
  registry = loadRegistry(),
  settings = loadSettings(),
  now = Date.now(),
  fetchImpl = fetch,
} = {}) {
  const allLanes = settings?.lanes ?? [];
  const excludedSet = new Set(Array.isArray(excludeLanes) ? excludeLanes : []);
  const matchingLanes = narrowPool(allLanes, { account, provider, harnesses })
    .filter((lane) => !excludedSet.has(lane.id));

  if (allLanes.length === 0) {
    return {
      ok: false,
      contract: GATEWAY_CONTRACT_VERSION,
      reason: 'no-lanes-configured',
      message: 'No lanes are configured in Switchboard.',
      retryAfterSeconds: null,
      resetsAt: null,
      candidates: [],
    };
  }

  if (matchingLanes.length === 0) {
    return {
      ok: false,
      contract: GATEWAY_CONTRACT_VERSION,
      reason: 'no-matching-lanes',
      message: 'No configured lanes match the requested provider or harness.',
      retryAfterSeconds: null,
      resetsAt: null,
      candidates: [],
    };
  }

  const accounts = registry?.accounts ?? [];
  const t3Colors = safeMatchT3Colors(registry);
  const loginStates = {};
  const quotas = {};

  const readAccount = async (accountId) => {
    const acc = accounts.find((a) => a.id === accountId);
    if (!acc) return {};
    const login = accountLoginState(acc, now);
    loginStates[accountId] = login;
    const cached = lastSharedQuota(acc.id);
    if (cached) {
      quotas[accountId] = cached;
      return { login, quota: cached };
    }
    if (!PROVIDERS[acc.provider]?.quota) return { login };
    const quota = await sharedProviderQuota(acc, {
      fetchImpl,
      usageSource: settings?.usageSources?.[acc.id] ?? null,
      now,
    });
    quotas[accountId] = quota;
    return { login, quota };
  };

  // Read every candidate's account state so we can compute accurate candidatesRemaining,
  // headroom, and earliest resetsAt across the pool.
  await Promise.all([...new Set(matchingLanes.map((l) => l.accountId))].map(readAccount));

  const context = {
    now,
    loginStates,
    quotas,
    spendPolicies: settings?.spendPolicies ?? {},
    cooldowns: settings?.cooldowns ?? {},
    requirements: { provider },
  };

  const orderedLanes = ordersBySoonestReset(settings)
    ? soonestResetOrder(matchingLanes, context)
    : [...matchingLanes];

  const candidates = orderedLanes.map((lane) => {
    const acc = accounts.find((a) => a.id === lane.accountId);
    const stat = laneStatus(lane, context);
    const cred = inspectLaneLeaseCredential(lane, acc, settings, { allowFolder });
    const cooldownUntil = settings?.cooldowns?.[lane.id] ?? null;
    const qInfo = computeQuotaHeadroom(quotas[lane.accountId], cooldownUntil, now);
    const usableStat = stat.status === 'available' || stat.status === 'quota-unknown';
    const leaseable = usableStat && cred.ready;
    return {
      lane,
      account: acc,
      stat,
      cred,
      qInfo,
      leaseable,
      color: acc?.color || (acc ? t3Colors[acc.id] : null) || defaultVendorColor(lane.harness),
    };
  });

  // Prefer 'available' lanes over 'quota-unknown' fallback lanes, matching selectLane.
  const availableReady = candidates.filter((c) => c.leaseable && c.stat.status === 'available');
  const fallbackReady = candidates.filter((c) => c.leaseable && c.stat.status === 'quota-unknown');
  const readyList = [...availableReady, ...fallbackReady];

  if (readyList.length === 0) {
    const missingTokenOnly = candidates.some(
      (c) => (c.stat.status === 'available' || c.stat.status === 'quota-unknown')
        && (c.cred.tokenStatus === 'needs-setup-token' || c.cred.tokenStatus === 'dead'),
    );
    const resetTimes = candidates
      .map((c) => toEpochMs(c.stat.resetsAt) ?? c.qInfo.resetsAtMs)
      .filter((t) => typeof t === 'number' && t > now)
      .sort((a, b) => a - b);
    const earliestResetMs = resetTimes[0] ?? null;
    const retryAfterSeconds = earliestResetMs
      ? Math.max(1, Math.ceil((earliestResetMs - now) / 1000))
      : 300;

    return {
      ok: false,
      contract: GATEWAY_CONTRACT_VERSION,
      reason: missingTokenOnly ? 'needs-setup-token' : 'no-healthy-lane',
      message: missingTokenOnly
        ? 'Healthy Claude lanes exist, but none have a live setup-token minted yet. Run: switchboard lane-token <laneId>'
        : 'No healthy lane is currently available.',
      retryAfterSeconds,
      resetsAt: earliestResetMs ? new Date(earliestResetMs).toISOString() : null,
      candidates,
    };
  }

  const chosen = readyList[0];
  const candidatesRemaining = Math.max(0, readyList.length - 1);
  const leaseId = 'lease_' + crypto.randomBytes(10).toString('hex');
  const harness = String(chosen.lane.harness || chosen.account?.provider || provider).toLowerCase();

  const lease = {
    ok: true,
    contract: GATEWAY_CONTRACT_VERSION,
    leaseId,
    laneId: chosen.lane.id,
    accountId: chosen.lane.accountId,
    accountLabel: chosen.account?.label ?? chosen.lane.accountId,
    accountColor: chosen.color,
    provider: chosen.lane.provider || harness,
    harness,
    binary: binaryForHarness(harness),
    billing: chosen.lane.billing || 'subscription',
    env: chosen.cred.env,
    ...(chosen.cred.codexHomeName ? { codexHomeName: chosen.cred.codexHomeName } : {}),
    tokenExpiresAt: chosen.cred.tokenExpiresAt ?? null,
    resetsAt: chosen.qInfo.resetsAt,
    headroom: chosen.qInfo.headroom,
    candidatesRemaining,
  };

  return {
    ...lease,
    candidates,
  };
}

/**
 * Summarize the active routing state for both Claude and Codex so the Gateway tab's
 * compact "Routing right now" strip can show the active lane, standby count, and whether
 * any Claude lane needs a setup-token minted.
 */
export async function resolveGatewayRoutes({
  registry = loadRegistry(),
  settings = loadSettings(),
  now = Date.now(),
  fetchImpl = fetch,
} = {}) {
  const [claudeSel, codexSel] = await Promise.all([
    selectBrokerLease({ provider: 'claude', registry, settings, now, fetchImpl }),
    selectBrokerLease({ provider: 'codex', registry, settings, now, fetchImpl }),
  ]);

  const summarize = (vendor, sel) => {
    const candidates = sel.candidates ?? [];
    const ready = candidates.filter((c) => c.leaseable);
    const primary = ready[0] ?? candidates[0] ?? null;
    const standby = ready.slice(1);
    const needsSetupTokenLanes = candidates
      .filter((c) => c.cred?.tokenStatus === 'needs-setup-token' || c.cred?.tokenStatus === 'dead')
      .map((c) => ({
        laneId: c.lane.id,
        accountId: c.lane.accountId,
        accountLabel: c.account?.label ?? c.lane.accountId,
        tokenStatus: c.cred.tokenStatus,
        deadReason: c.cred.deadReason ?? null,
      }));

    if (!primary) {
      // Check if there is an active account on the Accounts tab with no lane configured yet
      const fallbackAcc = activeAccount(registry, vendor);
      return {
        vendor,
        label: vendor === 'claude' ? 'Claude Code' : 'Codex',
        pathHint: '/v1/lease (' + vendor + ')',
        primary: fallbackAcc
          ? {
            accountId: fallbackAcc.id,
            accountLabel: fallbackAcc.label,
            color: fallbackAcc.color || defaultVendorColor(vendor),
            laneId: null,
            signedIn: accountLoginState(fallbackAcc, now)?.signedIn === true,
            tokenStatus: vendor === 'claude' ? 'no-lane' : 'worker-local-login',
            sessionPct: null,
            weekPct: null,
          }
          : null,
        standbyCount: 0,
        standbyLabels: [],
        totalCandidates: 0,
        needsSetupTokenLanes,
      };
    }

    return {
      vendor,
      label: vendor === 'claude' ? 'Claude Code' : 'Codex',
      pathHint: '/v1/lease (' + vendor + ')',
      primary: {
        accountId: primary.lane.accountId,
        accountLabel: primary.account?.label ?? primary.lane.accountId,
        color: primary.color,
        laneId: primary.lane.id,
        signedIn: primary.stat.status !== 'signed-out',
        leaseable: primary.leaseable,
        tokenStatus: primary.cred.tokenStatus,
        sessionPct: primary.qInfo.sessionUsed,
        weekPct: primary.qInfo.weekUsed,
        headroom: primary.qInfo.headroom,
        resetsAt: primary.qInfo.resetsAt,
      },
      standbyCount: standby.length,
      standbyLabels: standby.map((s) => s.account?.label ?? s.lane.accountId),
      totalCandidates: candidates.length,
      needsSetupTokenLanes,
    };
  };

  return {
    claude: summarize('claude', claudeSel),
    codex: summarize('codex', codexSel),
  };
}

/**
 * Apply a worker's POST /v1/lease/report outcome to settings.
 * Pure function: returns { settings, action, cooldownUntil, deadMarked }.
 */
export function applyLeaseReport(settings, report = {}, now = Date.now()) {
  const laneId = String(report?.laneId ?? '').trim();
  const outcome = String(report?.outcome ?? 'ok').trim().toLowerCase();
  const reason = String(report?.reason ?? '').trim();

  if (!laneId) {
    throw new Error('laneId is required in /v1/lease/report');
  }
  const laneExists = (settings?.lanes ?? []).some((l) => l.id === laneId);
  if (!laneExists) {
    throw new Error(`unknown laneId "${laneId}"`);
  }

  // 'ok' or 'error' (crash, kill, timeout) never penalizes or cools down the lane.
  if (outcome === 'ok' || outcome === 'error') {
    return {
      settings,
      action: 'none',
      cooldownUntil: null,
      deadMarked: false,
    };
  }

  if (outcome === 'exhausted' || outcome === 'rate-limited') {
    const parsedReset = toEpochMs(report?.resetsAt);
    const cooldownUntil = (typeof parsedReset === 'number' && parsedReset > now)
      ? parsedReset
      : now + DEFAULT_FAILOVER_COOLDOWN_MS;
    const cooldowns = { ...(settings?.cooldowns ?? {}), [laneId]: cooldownUntil };
    return {
      settings: { ...settings, cooldowns },
      action: 'cooldown',
      cooldownUntil,
      deadMarked: false,
    };
  }

  if (outcome === 'auth-failed') {
    // A Codex worker reporting that it has no local login for this account skips the lane
    // for that caller without cooling the lane down or marking any token dead.
    if (reason === 'no-local-login') {
      return {
        settings,
        action: 'skip-lane',
        excludeLaneId: laneId,
        cooldownUntil: null,
        deadMarked: false,
      };
    }

    if (settings?.laneTokens?.[laneId]) {
      const deadReason = reason || 'rejected during leased worker run';
      const next = markLaneTokenDead(settings, laneId, deadReason, now);
      return {
        settings: next,
        action: 'token-marked-dead',
        cooldownUntil: null,
        deadMarked: true,
      };
    }

    const cooldownUntil = now + DEFAULT_FAILOVER_COOLDOWN_MS;
    const cooldowns = { ...(settings?.cooldowns ?? {}), [laneId]: cooldownUntil };
    return {
      settings: { ...settings, cooldowns },
      action: 'cooldown',
      cooldownUntil,
      deadMarked: false,
    };
  }

  throw new Error(`unknown report outcome "${outcome}". Expected ok, exhausted, rate-limited, auth-failed, or error`);
}

function decodeJwtPayload(jwt) {
  if (typeof jwt !== 'string') return null;
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Read non-secret display metadata (email, workspace id, plan type) from an account's local
 * config folder for the read-only /v0/management/auth-files T3 Hub adapter.
 */
export function readAccountManagementMeta(account, readFile = fs.readFileSync) {
  if (!account?.home) {
    return { email: account?.label || account?.id || 'unknown', planType: null, workspaceId: null };
  }
  if (account.provider === 'claude') {
    try {
      const parsed = JSON.parse(readFile(path.join(account.home, '.claude.json'), 'utf8'));
      const oauth = parsed?.oauthAccount ?? {};
      const email = typeof oauth.emailAddress === 'string' && oauth.emailAddress.trim()
        ? oauth.emailAddress.trim()
        : (account.label || account.id);
      return { email, planType: null, workspaceId: null };
    } catch {
      return { email: account.label || account.id, planType: null, workspaceId: null };
    }
  }
  if (account.provider === 'codex') {
    try {
      const parsed = JSON.parse(readFile(path.join(account.home, 'auth.json'), 'utf8'));
      const tokens = parsed?.tokens ?? {};
      const idClaims = decodeJwtPayload(tokens.id_token) ?? {};
      const accessClaims = decodeJwtPayload(tokens.access_token) ?? {};
      const authClaim = idClaims['https://api.openai.com/auth']
        ?? accessClaims['https://api.openai.com/auth']
        ?? {};
      const profileClaim = accessClaims['https://api.openai.com/profile'] ?? {};
      const email = (typeof idClaims.email === 'string' && idClaims.email.trim())
        || (typeof profileClaim.email === 'string' && profileClaim.email.trim())
        || account.label
        || account.id;
      const workspaceId = (typeof authClaim.chatgpt_account_id === 'string' && authClaim.chatgpt_account_id.trim())
        || (typeof tokens.account_id === 'string' && tokens.account_id.trim())
        || null;
      const planType = (typeof authClaim.chatgpt_plan_type === 'string' && authClaim.chatgpt_plan_type.trim())
        || null;
      return { email, planType, workspaceId };
    } catch {
      return { email: account.label || account.id, planType: null, workspaceId: null };
    }
  }
  return { email: account.label || account.id, planType: null, workspaceId: null };
}

/**
 * Build the /v0/management/auth-files response payload from Switchboard's local registry.
 * Purely read-only metadata; no credentials or tokens are ever included.
 */
export function buildManagementAuthFiles({
  registry = loadRegistry(),
  now = Date.now(),
  readFile = fs.readFileSync,
} = {}) {
  const files = [];
  for (const acc of registry?.accounts ?? []) {
    if (acc.provider !== 'claude' && acc.provider !== 'codex') continue;
    const login = accountLoginState(acc, now);
    const meta = readAccountManagementMeta(acc, readFile);
    const entry = {
      id: acc.id,
      auth_index: acc.id,
      provider: acc.provider,
      email: meta.email || acc.label || acc.id,
      disabled: login?.signedIn === false,
    };
    if (acc.provider === 'codex' && (meta.workspaceId || meta.planType)) {
      entry.id_token = {
        ...(meta.workspaceId ? { chatgpt_account_id: meta.workspaceId } : {}),
        ...(meta.planType ? { plan_type: meta.planType, chatgpt_plan_type: meta.planType } : {}),
      };
    }
    files.push(entry);
  }
  return { files };
}

function toIsoStringOrNull(value) {
  const ms = toEpochMs(value);
  return typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function toEpochSecondsOrNull(value) {
  const ms = toEpochMs(value);
  return typeof ms === 'number' && Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * Synthesize a /v0/management/api-call response purely from Switchboard's own local quota
 * cache (sharedProviderQuota / lastSharedQuota), without proxying or spoofing upstream calls.
 */
export async function handleManagementApiCall({
  authIndex,
  url,
  registry = loadRegistry(),
  settings = loadSettings(),
  now = Date.now(),
  fetchImpl = fetch,
  readFile = fs.readFileSync,
} = {}) {
  const cleanId = String(authIndex ?? '').trim();
  const targetUrl = String(url ?? '').trim();
  const acc = (registry?.accounts ?? []).find((a) => a.id === cleanId);
  if (!acc) {
    return {
      status_code: 404,
      body: JSON.stringify({ error: `Unknown account "${cleanId}"` }),
    };
  }

  if (targetUrl.includes('/backend-api/wham/rate-limit-reset-credits')) {
    return {
      status_code: 200,
      body: JSON.stringify({ credits: [] }),
    };
  }

  let quota = lastSharedQuota(acc.id);
  if (!quota && PROVIDERS[acc.provider]?.quota) {
    quota = await sharedProviderQuota(acc, {
      fetchImpl,
      usageSource: settings?.usageSources?.[acc.id] ?? null,
      now,
    });
  }

  const windows = Array.isArray(quota?.windows) ? quota.windows : [];
  const sessionWin = windows.find((w) => w.key === 'session');
  const weekWin = windows.find((w) => w.key === 'week');

  if (acc.provider === 'claude' || targetUrl.includes('/api/oauth/usage')) {
    const fiveHour = sessionWin && sessionWin.usedPercent != null
      ? { utilization: Number(sessionWin.usedPercent), resets_at: toIsoStringOrNull(sessionWin.resetsAt) }
      : null;
    const sevenDay = weekWin && weekWin.usedPercent != null
      ? { utilization: Number(weekWin.usedPercent), resets_at: toIsoStringOrNull(weekWin.resetsAt) }
      : null;
    const limits = [];
    for (const w of windows) {
      if (!w || typeof w.key !== 'string' || !w.key.startsWith('week_') || w.usedPercent == null) continue;
      const modelDisplay = w.key === 'week_sonnet'
        ? 'Sonnet'
        : w.key === 'week_opus'
          ? 'Opus'
          : (w.label || w.key.replace(/^week_/, ''));
      limits.push({
        kind: 'weekly_scoped',
        percent: Number(w.usedPercent),
        resets_at: toIsoStringOrNull(w.resetsAt),
        scope: { model: { display_name: modelDisplay } },
      });
    }
    return {
      status_code: 200,
      body: JSON.stringify({
        five_hour: fiveHour,
        seven_day: sevenDay,
        limits,
      }),
    };
  }

  if (acc.provider === 'codex' || targetUrl.includes('/backend-api/wham/usage')) {
    const meta = readAccountManagementMeta(acc, readFile);
    const primaryWindow = sessionWin && sessionWin.usedPercent != null
      ? {
        used_percent: Number(sessionWin.usedPercent),
        reset_at: toEpochSecondsOrNull(sessionWin.resetsAt),
        limit_window_seconds: 18000,
      }
      : null;
    const secondaryWindow = weekWin && weekWin.usedPercent != null
      ? {
        used_percent: Number(weekWin.usedPercent),
        reset_at: toEpochSecondsOrNull(weekWin.resetsAt),
        limit_window_seconds: 604800,
      }
      : null;
    return {
      status_code: 200,
      body: JSON.stringify({
        plan_type: meta.planType || 'plus',
        rate_limit: {
          primary_window: primaryWindow,
          secondary_window: secondaryWindow,
        },
      }),
    };
  }

  return {
    status_code: 400,
    body: JSON.stringify({ error: `Unsupported management api-call URL "${targetUrl}"` }),
  };
}

/**
 * Extract the caller's presented sb-key-... token from x-api-key or Authorization: Bearer.
 */
export function extractPresentedKey(headers = {}) {
  const apiKey = headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.trim()) {
    return apiKey.trim();
  }
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (match) return match[1].trim();
  }
  return '';
}

/**
 * Build outgoing upstream headers for a metered API key pass-through request.
 * Subscription OAuth tokens are never passed through here.
 */
export function buildUpstreamHeaders(incomingHeaders = {}, vendor, token, upstreamHost) {
  const out = {};
  const strip = new Set([
    'host',
    'connection',
    'keep-alive',
    'proxy-authenticate',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
    'x-api-key',
    'authorization',
    'origin',
    'sec-fetch-mode',
    'sec-fetch-site',
    'sec-fetch-dest',
  ]);

  for (const [rawKey, value] of Object.entries(incomingHeaders ?? {})) {
    if (value === undefined) continue;
    const key = rawKey.toLowerCase();
    if (strip.has(key)) continue;
    out[rawKey] = value;
  }

  out.host = upstreamHost;
  if (vendor === 'claude') {
    out['x-api-key'] = token;
    const hasVersion = Object.keys(out).some((k) => k.toLowerCase() === 'anthropic-version');
    if (!hasVersion) out['anthropic-version'] = '2023-06-01';
  } else {
    out.authorization = `Bearer ${token}`;
  }

  return out;
}

function readRequestBody(req, maxBytes = 32 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(Object.assign(new Error('Request body exceeds maximum gateway limit'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJsonBody(buf) {
  if (!buf || buf.length === 0) return {};
  try {
    const parsed = JSON.parse(buf.toString('utf8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    throw Object.assign(new Error('Request body is not valid JSON'), { status: 400 });
  }
}

function forwardUpstreamOnce({ targetBaseUrl, method, urlPath, headers, body, requestFn = null }) {
  return new Promise((resolve, reject) => {
    const targetUrl = new URL(urlPath, targetBaseUrl);
    const isHttps = targetUrl.protocol === 'https:';
    const requester = requestFn ?? (isHttps ? https.request : http.request);

    const reqHeaders = { ...headers };
    if (body && body.length > 0) {
      reqHeaders['content-length'] = String(body.length);
    } else {
      delete reqHeaders['content-length'];
    }

    const upstreamReq = requester(
      targetUrl,
      {
        method,
        headers: reqHeaders,
        timeout: 120_000,
      },
      (upstreamRes) => {
        resolve(upstreamRes);
      },
    );

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy(new Error('Upstream request timed out'));
    });
    upstreamReq.on('error', (err) => {
      reject(err);
    });

    if (body && body.length > 0) {
      upstreamReq.write(body);
    }
    upstreamReq.end();
  });
}

function shouldFailoverStatus(status) {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 529;
}

function sendJson(res, status, payload, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

/**
 * Create a self-contained Switchboard Gateway & Lease Broker server.
 * Supports:
 * - GET /v1/info
 * - GET / POST /v1/lease
 * - POST /v1/lease/report
 * - GET /v1/switchboard/status
 * - POST /v1/messages & /v1/responses (strictly for metered API-key lanes)
 */
export function createGatewayServer({
  getSettings = loadSettings,
  setSettings = saveSettings,
  getRegistry = loadRegistry,
  upstreamTargets = UPSTREAM_TARGETS,
  requestFn = null,
  fetchImpl = fetch,
  nowFn = () => Date.now(),
} = {}) {
  let server = null;
  let listeningPort = null;
  let listeningHost = null;
  const sockets = new Set();
  const events = [];

  function pushEvent(ev) {
    events.unshift(ev);
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  }

  async function handleRequest(req, res) {
    const now = nowFn();
    const remoteAddress = normalizeRemoteAddress(req.socket?.remoteAddress ?? '');
    const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 120);
    const method = String(req.method ?? 'GET').toUpperCase();
    const urlPath = String(req.url ?? '/');

    // Reject browser-originated requests outright (no CORS, no browser probing).
    if (req.headers.origin) {
      pushEvent({
        time: now,
        keyId: null,
        keyLabel: 'browser-rejected',
        remoteAddress,
        method,
        path: urlPath,
        userAgent,
        vendor: null,
        accountId: null,
        accountLabel: null,
        laneId: null,
        failoverFromLaneId: null,
        status: 403,
        outcome: 'Browser Origin blocked',
      });
      return sendJson(res, 403, {
        ok: false,
        error: {
          type: 'forbidden',
          message: 'Browser requests are not permitted on the Switchboard Gateway.',
        },
      });
    }

    const settings = getSettings();
    const presentedToken = extractPresentedKey(req.headers);
    const verification = verifyGatewayKey(settings, presentedToken, remoteAddress);
    if (!verification.ok) {
      pushEvent({
        time: now,
        keyId: verification.keyId ?? null,
        keyLabel: verification.keyLabel ?? 'unverified',
        remoteAddress,
        method,
        path: urlPath,
        userAgent,
        vendor: null,
        accountId: null,
        accountLabel: null,
        laneId: null,
        failoverFromLaneId: null,
        status: verification.status,
        outcome: verification.reason,
      });
      return sendJson(res, verification.status, {
        ok: false,
        error: {
          type: verification.status === 401 ? 'authentication_error' : 'permission_error',
          message: verification.message,
        },
      });
    }

    const routeKind = routeVendorForPath(urlPath);
    if (!routeKind) {
      pushEvent({
        time: now,
        keyId: verification.key.id,
        keyLabel: verification.key.label,
        remoteAddress,
        method,
        path: urlPath,
        userAgent,
        vendor: null,
        accountId: null,
        accountLabel: null,
        laneId: null,
        failoverFromLaneId: null,
        status: 404,
        outcome: 'Unsupported route',
      });
      return sendJson(res, 404, {
        ok: false,
        error: {
          type: 'not_found_error',
          message: `Switchboard Gateway does not route ${urlPath}. Use /v1/info, /v1/lease, /v1/lease/report, or metered /v1/messages and /v1/responses.`,
        },
      });
    }

    const registry = getRegistry();

    // 1. GET /v1/info
    if (routeKind === 'info') {
      const gw = normalizeGatewaySettings(settings.gateway);
      const activePort = listeningPort ?? gw.port ?? DEFAULT_GATEWAY_PORT;
      const addresses = collectBoundAddresses(activePort);
      return sendJson(res, 200, {
        ok: true,
        contract: GATEWAY_CONTRACT_VERSION,
        port: activePort,
        scope: gw.scope,
        bindHost: listeningHost ?? (gw.scope === 'localhost' ? '127.0.0.1' : '0.0.0.0'),
        displayHost: detectGatewayHostIp(gw.scope),
        addresses,
      });
    }

    // 2. GET /v1/switchboard/status
    if (routeKind === 'status') {
      const routes = await resolveGatewayRoutes({ registry, settings, now, fetchImpl });
      pushEvent({
        time: now,
        keyId: verification.key.id,
        keyLabel: verification.key.label,
        remoteAddress,
        method,
        path: urlPath,
        userAgent,
        vendor: 'status',
        accountId: null,
        accountLabel: 'Gateway Status',
        laneId: null,
        failoverFromLaneId: null,
        status: 200,
        outcome: '200 OK',
      });
      return sendJson(res, 200, { ok: true, contract: GATEWAY_CONTRACT_VERSION, routes });
    }

    // 3. GET or POST /v1/lease
    if (routeKind === 'lease') {
      let params = {};
      if (method === 'POST') {
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          params = parseJsonBody(rawBody);
        } catch (err) {
          return sendJson(res, err.status || 400, {
            ok: false,
            error: { type: 'invalid_request_error', message: String(err.message || err) },
          });
        }
      } else {
        const parsedUrl = new URL(urlPath, 'http://127.0.0.1');
        params = {
          provider: parsedUrl.searchParams.get('provider') || parsedUrl.searchParams.get('harness') || 'claude',
          account: parsedUrl.searchParams.get('account') || null,
          harnesses: parsedUrl.searchParams.get('harnesses')
            ? parsedUrl.searchParams.get('harnesses').split(',').map((s) => s.trim()).filter(Boolean)
            : null,
          excludeLanes: parsedUrl.searchParams.get('excludeLanes')
            ? parsedUrl.searchParams.get('excludeLanes').split(',').map((s) => s.trim()).filter(Boolean)
            : [],
          allowFolder: parsedUrl.searchParams.get('allowFolder') === 'true',
        };
      }

      const wantedProvider = params.provider || params.harness || 'claude';
      const allowFolder = Boolean(params.allowFolder) && classifyRemoteAddress(remoteAddress) === 'localhost';
      const result = await selectBrokerLease({
        provider: wantedProvider,
        account: params.account || null,
        harnesses: Array.isArray(params.harnesses) ? params.harnesses : null,
        excludeLanes: Array.isArray(params.excludeLanes) ? params.excludeLanes : [],
        allowFolder,
        registry,
        settings,
        now,
        fetchImpl,
      });

      if (!result.ok) {
        pushEvent({
          time: now,
          keyId: verification.key.id,
          keyLabel: verification.key.label,
          remoteAddress,
          method,
          path: urlPath,
          userAgent,
          vendor: wantedProvider,
          accountId: null,
          accountLabel: null,
          laneId: null,
          failoverFromLaneId: null,
          status: 503,
          outcome: result.reason,
        });
        const extraHeaders = result.retryAfterSeconds != null
          ? { 'retry-after': String(result.retryAfterSeconds) }
          : {};
        return sendJson(res, 503, {
          ok: false,
          contract: GATEWAY_CONTRACT_VERSION,
          reason: result.reason,
          message: result.message,
          retryAfterSeconds: result.retryAfterSeconds,
          resetsAt: result.resetsAt,
        }, extraHeaders);
      }

      if (method === 'POST') {
        try {
          const latest = getSettings();
          const updated = recordGatewayKeyUse(latest, verification.key.id, {
            accountId: result.accountId,
            laneId: result.laneId,
            now,
          });
          setSettings(updated);
        } catch {
          // best-effort usage counter update
        }
      }

      pushEvent({
        time: now,
        keyId: verification.key.id,
        keyLabel: verification.key.label,
        remoteAddress,
        method,
        path: urlPath,
        userAgent,
        vendor: result.provider,
        accountId: result.accountId,
        accountLabel: result.accountLabel,
        accountColor: result.accountColor,
        laneId: result.laneId,
        failoverFromLaneId: null,
        status: 200,
        outcome: `Leased (${result.laneId})`,
      });

      const { candidates: _internal, accountColor: _color, ...publicLease } = result;
      return sendJson(res, 200, publicLease);
    }

    // 4. POST /v1/lease/report
    if (routeKind === 'report') {
      if (method !== 'POST') {
        return sendJson(res, 405, {
          ok: false,
          error: { type: 'method_not_allowed', message: 'Use POST for /v1/lease/report' },
        });
      }
      let bodyObj;
      try {
        const rawBody = await readRequestBody(req, 64 * 1024);
        bodyObj = parseJsonBody(rawBody);
      } catch (err) {
        return sendJson(res, err.status || 400, {
          ok: false,
          error: { type: 'invalid_request_error', message: String(err.message || err) },
        });
      }

      try {
        const latest = getSettings();
        const applied = applyLeaseReport(latest, bodyObj, now);
        if (applied.settings !== latest) {
          setSettings(applied.settings);
        }
        const lane = (latest.lanes ?? []).find((l) => l.id === bodyObj.laneId);
        const acc = registry.accounts.find((a) => a.id === lane?.accountId);
        const isFailoverTrigger = applied.action === 'cooldown' || applied.action === 'token-marked-dead' || applied.action === 'skip-lane';
        pushEvent({
          time: now,
          keyId: verification.key.id,
          keyLabel: verification.key.label,
          remoteAddress,
          method,
          path: urlPath,
          userAgent,
          vendor: lane?.harness ?? null,
          accountId: acc?.id ?? lane?.accountId ?? null,
          accountLabel: acc?.label ?? lane?.accountId ?? null,
          laneId: bodyObj.laneId,
          failoverFromLaneId: isFailoverTrigger ? bodyObj.laneId : null,
          failoverFromLabel: isFailoverTrigger ? (acc?.label ?? bodyObj.laneId) : null,
          status: 200,
          outcome: `Report: ${bodyObj.outcome || 'ok'}${applied.action !== 'none' ? ` (${applied.action})` : ''}`,
        });
        return sendJson(res, 200, {
          ok: true,
          contract: GATEWAY_CONTRACT_VERSION,
          leaseId: bodyObj.leaseId ?? null,
          laneId: bodyObj.laneId,
          action: applied.action,
          cooldownUntil: applied.cooldownUntil ? new Date(applied.cooldownUntil).toISOString() : null,
          deadMarked: applied.deadMarked,
          ...(applied.excludeLaneId ? { excludeLaneId: applied.excludeLaneId } : {}),
        });
      } catch (err) {
        return sendJson(res, 400, {
          ok: false,
          error: { type: 'invalid_request_error', message: String(err.message || err) },
        });
      }
    }

    // 4b. Read-only T3 Hub management adapter (/v0/management/*)
    // Serves account list and cached quota snapshots locally without proxying upstream calls.
    if (routeKind === 'management') {
      const cleanPath = urlPath.split('?')[0];
      const registry = getRegistry();

      if (cleanPath === '/v0/management/auth-files' && method === 'GET') {
        const payload = buildManagementAuthFiles({ registry, now });
        pushEvent({
          time: now,
          keyId: verification.key.id,
          keyLabel: verification.key.label,
          remoteAddress,
          method,
          path: cleanPath,
          userAgent,
          vendor: null,
          accountId: null,
          accountLabel: null,
          laneId: null,
          failoverFromLaneId: null,
          status: 200,
          outcome: `T3 Hub (${payload.files.length} accounts)`,
        });
        return sendJson(res, 200, payload);
      }

      if (cleanPath === '/v0/management/api-call' && method === 'POST') {
        let bodyObj;
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          bodyObj = parseJsonBody(rawBody);
        } catch (err) {
          return sendJson(res, err.status || 400, {
            ok: false,
            error: { type: 'invalid_request_error', message: String(err.message || err) },
          });
        }
        const apiRes = await handleManagementApiCall({
          authIndex: bodyObj.auth_index,
          url: bodyObj.url,
          registry,
          settings,
          now,
          fetchImpl,
        });
        const acc = (registry?.accounts ?? []).find((a) => a.id === bodyObj.auth_index);
        pushEvent({
          time: now,
          keyId: verification.key.id,
          keyLabel: verification.key.label,
          remoteAddress,
          method,
          path: cleanPath,
          userAgent,
          vendor: acc?.provider ?? null,
          accountId: acc?.id ?? null,
          accountLabel: acc?.label ?? bodyObj.auth_index ?? null,
          accountColor: acc?.color ?? null,
          laneId: null,
          failoverFromLaneId: null,
          status: 200,
          outcome: `T3 Hub quota (${acc?.label ?? bodyObj.auth_index ?? 'account'})`,
        });
        return sendJson(res, 200, apiRes);
      }

      if (cleanPath === '/v0/management/reset-quota' && method === 'POST') {
        let bodyObj = {};
        try {
          const rawBody = await readRequestBody(req, 64 * 1024);
          bodyObj = parseJsonBody(rawBody);
        } catch {
          bodyObj = {};
        }
        const targetAccId = String(bodyObj.auth_index ?? '').trim();
        const latest = getSettings();
        const nextCooldowns = { ...(latest.cooldowns ?? {}) };
        let cleared = 0;
        for (const lane of latest.lanes ?? []) {
          if (!targetAccId || lane.accountId === targetAccId) {
            if (nextCooldowns[lane.id] != null) {
              delete nextCooldowns[lane.id];
              cleared += 1;
            }
          }
        }
        if (cleared > 0) {
          setSettings({ ...latest, cooldowns: nextCooldowns });
        }
        return sendJson(res, 200, { ok: true, cleared });
      }

      return sendJson(res, 404, {
        ok: false,
        error: { type: 'not_found_error', message: `Unknown management endpoint "${cleanPath}"` },
      });
    }

    // 5. Metered-only pass-through (/v1/messages for claude, /v1/responses for codex).
    // Subscription lanes are never proxied here so consumer OAuth headers are never rewritten.
    const vendor = routeKind;
    const meteredPool = narrowPool(settings?.lanes ?? [], { provider: vendor })
      .filter((l) => l.billing === 'metered');

    if (meteredPool.length === 0) {
      pushEvent({
        time: now,
        keyId: verification.key.id,
        keyLabel: verification.key.label,
        remoteAddress,
        method,
        path: urlPath,
        userAgent,
        vendor,
        accountId: null,
        accountLabel: null,
        laneId: null,
        failoverFromLaneId: null,
        status: 400,
        outcome: 'Use /v1/lease for subscription lanes',
      });
      return sendJson(res, 400, {
        ok: false,
        error: {
          type: 'invalid_request_error',
          message: `Pass-through on ${urlPath} is only enabled for metered API-key lanes. For subscription lanes, request a credential lease from POST /v1/lease so the native CLI connects directly to the vendor.`,
        },
      });
    }

    let body;
    try {
      body = await readRequestBody(req);
    } catch (err) {
      const code = err?.status || 400;
      return sendJson(res, code, {
        ok: false,
        error: { type: 'invalid_request_error', message: String(err?.message || err) },
      });
    }

    const sel = await selectBrokerLease({
      provider: vendor,
      registry,
      settings: { ...settings, lanes: meteredPool },
      now,
      fetchImpl,
    });
    const readyCandidates = (sel.candidates ?? []).filter((c) => c.leaseable && c.cred.token);

    if (readyCandidates.length === 0) {
      pushEvent({
        time: now,
        keyId: verification.key.id,
        keyLabel: verification.key.label,
        remoteAddress,
        method,
        path: urlPath,
        userAgent,
        vendor,
        accountId: null,
        accountLabel: null,
        laneId: null,
        failoverFromLaneId: null,
        status: 503,
        outcome: `No ready metered ${vendor} lane`,
      });
      return sendJson(res, 503, {
        ok: false,
        error: {
          type: 'service_unavailable',
          message: sel.message || `No metered ${vendor} lane with remaining budget and API key is available.`,
        },
      });
    }

    const targetBaseUrl = upstreamTargets[vendor] || UPSTREAM_TARGETS[vendor];
    const upstreamHost = new URL(targetBaseUrl).host;

    let chosen = readyCandidates[0];
    let failoverFrom = null;
    let upstreamRes = null;

    for (let attempt = 0; attempt < Math.min(readyCandidates.length, 2); attempt += 1) {
      const candidate = readyCandidates[attempt];
      chosen = candidate;
      const outHeaders = buildUpstreamHeaders(req.headers, vendor, candidate.cred.token, upstreamHost);
      try {
        const resAttempt = await forwardUpstreamOnce({
          targetBaseUrl,
          method,
          urlPath,
          headers: outHeaders,
          body,
          requestFn,
        });

        if (
          attempt === 0
          && readyCandidates.length > 1
          && shouldFailoverStatus(resAttempt.statusCode)
        ) {
          resAttempt.resume();
          failoverFrom = candidate;
          if (candidate.lane?.id) {
            try {
              const latest = getSettings();
              const cooldowns = { ...(latest.cooldowns ?? {}), [candidate.lane.id]: now + DEFAULT_FAILOVER_COOLDOWN_MS };
              setSettings({ ...latest, cooldowns });
            } catch {
              // best-effort cooldown update
            }
          }
          continue;
        }

        upstreamRes = resAttempt;
        break;
      } catch (err) {
        if (attempt === 0 && readyCandidates.length > 1) {
          failoverFrom = candidate;
          continue;
        }
        pushEvent({
          time: now,
          keyId: verification.key.id,
          keyLabel: verification.key.label,
          remoteAddress,
          method,
          path: urlPath,
          userAgent,
          vendor,
          accountId: candidate.lane.accountId,
          accountLabel: candidate.account?.label ?? candidate.lane.accountId,
          laneId: candidate.lane.id,
          failoverFromLaneId: failoverFrom?.lane?.id ?? null,
          status: 502,
          outcome: 'Upstream error',
        });
        return sendJson(res, 502, {
          ok: false,
          error: {
            type: 'bad_gateway',
            message: `Upstream ${vendor} request failed: ${String(err?.message || err)}`,
          },
        });
      }
    }

    const statusCode = upstreamRes?.statusCode ?? 502;
    try {
      const latest = getSettings();
      const updated = recordGatewayKeyUse(latest, verification.key.id, {
        accountId: chosen.lane.accountId,
        laneId: chosen.lane.id,
        now,
      });
      setSettings(updated);
    } catch {
      // best-effort usage counter update
    }

    const chosenLabel = chosen.account?.label ?? chosen.lane.accountId;
    const failoverLabel = failoverFrom ? (failoverFrom.account?.label ?? failoverFrom.lane.accountId) : null;
    const outcome = failoverFrom
      ? `Failover (${failoverLabel} -> ${chosenLabel})`
      : `${statusCode} ${statusCode >= 200 && statusCode < 300 ? 'OK' : 'Upstream'}`;

    pushEvent({
      time: now,
      keyId: verification.key.id,
      keyLabel: verification.key.label,
      remoteAddress,
      method,
      path: urlPath,
      userAgent,
      vendor,
      accountId: chosen.lane.accountId,
      accountLabel: chosenLabel,
      accountColor: chosen.color,
      laneId: chosen.lane.id,
      failoverFromLaneId: failoverFrom?.lane?.id ?? null,
      failoverFromLabel: failoverLabel,
      status: statusCode,
      outcome,
    });

    const responseHeaders = { ...upstreamRes.headers };
    delete responseHeaders['transfer-encoding'];
    responseHeaders['x-switchboard-account'] = chosen.lane.accountId;
    if (chosen.lane?.id) responseHeaders['x-switchboard-lane'] = chosen.lane.id;
    if (failoverFrom) responseHeaders['x-switchboard-failover-from'] = failoverFrom.lane.accountId;

    res.writeHead(statusCode, responseHeaders);
    upstreamRes.pipe(res);
  }

  async function start({ port = null, scope = null } = {}) {
    const current = getSettings();
    const gw = normalizeGatewaySettings(current.gateway);
    const targetPort = port != null ? normalizeGatewayPort(port) : gw.port;
    const targetScope = scope != null ? normalizeGatewayScope(scope) : gw.scope;
    const bindHost = targetScope === 'localhost' ? '127.0.0.1' : '0.0.0.0';

    if (server && listeningPort === targetPort && listeningHost === bindHost) {
      return status();
    }
    if (server) {
      await stop();
    }

    await new Promise((resolve, reject) => {
      const srv = http.createServer((req, res) => {
        handleRequest(req, res).catch((err) => {
          if (!res.headersSent) {
            sendJson(res, 500, {
              ok: false,
              error: { type: 'internal_error', message: String(err?.message || err) },
            });
          } else {
            res.end();
          }
        });
      });

      srv.on('connection', (socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });

      const onError = (err) => {
        srv.removeListener('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        srv.removeListener('error', onError);
        server = srv;
        const addr = srv.address();
        listeningPort = typeof addr === 'object' && addr ? addr.port : targetPort;
        listeningHost = bindHost;
        resolve();
      };

      srv.once('error', onError);
      srv.once('listening', onListening);
      srv.listen(targetPort, bindHost);
    });

    return status();
  }

  async function stop() {
    if (!server) return status();
    const srv = server;
    server = null;
    listeningPort = null;
    listeningHost = null;
    for (const socket of sockets) {
      try { socket.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
    await new Promise((resolve) => {
      srv.close(() => resolve());
    });
    return status();
  }

  async function status() {
    const settings = getSettings();
    const registry = getRegistry();
    const gw = normalizeGatewaySettings(settings.gateway);
    const activePort = listeningPort ?? gw.port ?? DEFAULT_GATEWAY_PORT;
    const displayHost = detectGatewayHostIp(gw.scope);
    const addresses = collectBoundAddresses(activePort);
    const routes = await resolveGatewayRoutes({ registry, settings, now: nowFn(), fetchImpl });
    const keys = listGatewayKeys(settings, nowFn()).map((k) => {
      const acc = registry.accounts.find((a) => a.id === k.lastAccountId);
      return {
        ...k,
        lastAccountLabel: acc?.label ?? k.lastAccountId ?? null,
        lastAccountColor: acc?.color ?? null,
      };
    });
    return {
      contract: GATEWAY_CONTRACT_VERSION,
      running: Boolean(server),
      enabled: gw.enabled,
      port: activePort,
      scope: gw.scope,
      scopes: GATEWAY_SCOPES,
      bindHost: listeningHost ?? (gw.scope === 'localhost' ? '127.0.0.1' : '0.0.0.0'),
      displayHost,
      endpointUrl: `http://${displayHost}:${activePort}`,
      localhostUrl: `http://127.0.0.1:${activePort}`,
      addresses,
      routes,
      keys,
      events: [...events],
    };
  }

  return {
    start,
    stop,
    status,
    isRunning: () => Boolean(server),
    events: () => [...events],
  };
}
