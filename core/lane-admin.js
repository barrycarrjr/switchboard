import { PROVIDERS, antigravityAccount } from './accounts.js';
import { TOOLS } from './providers.js';
import os from 'node:os';
import path from 'node:path';
import { detectPresence } from './presence.js';
import { antigravityPresence } from './apps.js';
import { detectInstalled } from './providers.js';

/**
 * Editing the lane pool: the rules that decide what a lane may be, kept apart from
 * lanes.js, which only decides which existing lane gets the work.
 *
 * This lives in core because two surfaces edit the same pool and must agree about it.
 * The Lanes tab used to hold the only copy of these rules, written inline in the
 * renderer, so a lane added from a terminal could be a shape the app would never have
 * produced. Every function here is pure: settings in, new settings out, and the caller
 * decides when to save.
 */

/**
 * The vendor behind a harness. A lane carries both because a caller may ask for either
 * ("--provider claude" or "--provider anthropic"), and laneAnswersTo matches on both.
 * A harness with no separate vendor name answers to its own name only.
 */
const VENDORS = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  antigravity: 'google',
  copilot: 'github',
  junie: 'jetbrains',
  grok: 'xai',
  ollama: 'ollama',
};

export function vendorForHarness(harness) {
  const id = String(harness ?? '');
  return VENDORS[id] ?? id;
}

/**
 * How a lane pays. 'subscription' rides an account's plan allowance; 'metered' bills
 * per request, so lanes.js refuses to select it until a budget is set.
 */
export const BILLING_KINDS = ['subscription', 'metered'];

/** The default capability set. Kept as the app has always written it. */
const DEFAULT_CAPABILITIES = ['chat'];

/**
 * What is wrong with a lane someone asked for, or null when nothing is.
 *
 * A duplicate is refused rather than allowed to look harmless. Selection is
 * deterministic and walks the pool in order, so a second lane naming the same account
 * on the same billing can never be reached: the first one answers every time. Two of
 * them in the list reads as a spare, and it is not one.
 */
export function laneProblem({ accountId, billing } = {}, accounts = [], lanes = []) {
  if (typeof accountId !== 'string' || !accountId.trim()) return 'a lane needs an account id';
  const cleanId = accountId.trim();
  const account = accounts.find((a) => a.id === cleanId);
  if (!account) return `no registered account with id "${cleanId}"`;

  const provider = account.provider ?? account.harness;
  if (!PROVIDERS[provider] && !TOOLS.some((t) => t.id === provider)) return `provider "${provider}" is not supported`;

  const cleanBilling = String(billing ?? 'subscription').trim();
  if (!BILLING_KINDS.includes(cleanBilling)) {
    return `billing must be one of: ${BILLING_KINDS.join(', ')}`;
  }

  const duplicate = lanes.find((l) => l.accountId === cleanId && (l.billing ?? 'subscription') === cleanBilling);
  if (duplicate) {
    return `a ${cleanBilling} lane for "${account.label || cleanId}" already exists (${duplicate.id})`;
  }
  return null;
}

export function buildLane(account, billing, id) {
  const harness = account.provider ?? account.harness;
  return {
    id,
    harness,
    provider: vendorForHarness(harness),
    accountId: account.id,
    billing: String(billing ?? 'subscription').trim(),
    capabilities: [...DEFAULT_CAPABILITIES],
  };
}

export function nextLaneId(now = Date.now()) {
  return `lane-${now}`;
}

/**
 * Pure lane addition. Validates against the accounts and lanes it was handed, appends
 * the new lane at the lowest priority, and returns the next settings alongside the
 * created lane. Throws on validation failure so callers with no UI can let it surface.
 */
export function addLane(settings, { accountId, billing = 'subscription' } = {}, accounts = [], now = Date.now()) {
  const current = settings?.lanes ?? [];
  const problem = laneProblem({ accountId, billing }, accounts, current);
  if (problem) throw new Error(problem);

  const cleanId = accountId.trim();
  const account = accounts.find((a) => a.id === cleanId);
  const lane = buildLane(account, billing, nextLaneId(now));
  return {
    settings: { ...settings, lanes: [...current, lane] },
    lane,
  };
}

/**
 * Pure lane removal. Drops the lane and any spend policy, cooldown, or lane token
 * filed under that id, and throws if the id names nothing in the pool.
 */
export function removeLane(settings, laneId) {
  const current = settings?.lanes ?? [];
  if (!current.some((l) => l.id === laneId)) {
    throw new Error(`no lane with id "${laneId}"`);
  }
  const lanes = current.filter((l) => l.id !== laneId);
  const spendPolicies = { ...(settings?.spendPolicies ?? {}) };
  delete spendPolicies[laneId];
  const cooldowns = { ...(settings?.cooldowns ?? {}) };
  delete cooldowns[laneId];
  const laneTokens = { ...(settings?.laneTokens ?? {}) };
  delete laneTokens[laneId];
  return { ...settings, lanes, spendPolicies, cooldowns, laneTokens };
}

/**
 * Pure lane reordering. Accepts an array of lane ids representing the new order.
 * Any lanes omitted from the new order are kept at the end in their original relative
 * order, so a partial list never deletes a lane by accident.
 */
export function reorderLanes(settings, orderedIds) {
  const current = settings?.lanes ?? [];
  const seen = new Set();
  const next = [];
  for (const id of orderedIds ?? []) {
    if (seen.has(id)) continue;
    const lane = current.find((l) => l.id === id);
    if (lane) {
      next.push(lane);
      seen.add(id);
    }
  }
  for (const lane of current) {
    if (!seen.has(lane.id)) next.push(lane);
  }
  return { ...settings, lanes: next };
}

/** Which ids in a caller's list do not match any lane in the pool. */
export function unknownLaneIds(settings, ids) {
  const known = new Set((settings?.lanes ?? []).map((l) => l.id));
  return (ids ?? []).filter((id) => !known.has(id));
}

/**
 * Pure budget edit. A positive number sets the monthly spend cap in whole dollars;
 * null or empty string removes it so the lane reverts to unbudgeted.
 */
export function setLaneBudget(settings, laneId, budget) {
  const current = settings?.lanes ?? [];
  if (!current.some((l) => l.id === laneId)) {
    throw new Error(`no lane with id "${laneId}"`);
  }
  const spendPolicies = { ...(settings?.spendPolicies ?? {}) };
  if (budget == null || budget === '') {
    delete spendPolicies[laneId];
    return { ...settings, spendPolicies };
  }
  const n = Number(budget);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error('budget must be a dollar amount greater than zero');
  }
  spendPolicies[laneId] = { budget: Math.floor(n) };
  return { ...settings, spendPolicies };
}

/**
 * Pure lane-token storage. Associates a minted CLI session token with a lane so that
 * switchboard run can inject it into a child terminal without modifying the user's
 * primary credentials. Clears any dead mark from an earlier run.
 */
export function setLaneToken(settings, laneId, { token, accountId, mintedAt, organizationUuid, accountUuid } = {}) {
  const current = settings?.lanes ?? [];
  if (!current.some((l) => l.id === laneId)) {
    throw new Error(`no lane with id "${laneId}"`);
  }
  if (typeof token !== 'string' || !token.trim()) throw new Error('lane token must be a non-empty string');
  if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('lane token needs the account id it belongs to');
  const minted = Number(mintedAt);
  if (!Number.isFinite(minted) || minted <= 0) throw new Error('lane token needs the time it was minted');

  const entry = { token: token.trim(), accountId: accountId.trim(), mintedAt: minted };
  if (organizationUuid !== undefined) {
    if (typeof organizationUuid !== 'string' || !organizationUuid.trim()) {
      throw new Error('lane token organization uuid must be a non-empty string');
    }
    entry.organizationUuid = organizationUuid.trim();
  }
  if (accountUuid !== undefined && accountUuid !== null) {
    if (typeof accountUuid !== 'string' || !accountUuid.trim()) {
      throw new Error('lane token account uuid must be a non-empty string');
    }
    entry.accountUuid = accountUuid.trim();
  }

  const laneTokens = { ...(settings?.laneTokens ?? {}) };
  laneTokens[laneId] = entry;
  return { ...settings, laneTokens };
}

/** Drops a lane token, leaving the lane unprovisioned. */
export function removeLaneToken(settings, laneId) {
  const laneTokens = { ...(settings?.laneTokens ?? {}) };
  if (!laneTokens[laneId]) throw new Error(`no lane token for "${laneId}"`);
  delete laneTokens[laneId];
  return { ...settings, laneTokens };
}

/** Marks a lane token unusable without deleting it, so a human can see why it stopped working. */
export function markLaneTokenDead(settings, laneId, reason, now = Date.now()) {
  const laneTokens = { ...(settings.laneTokens ?? {}) };
  const entry = laneTokens[laneId];
  if (!entry) throw new Error(`no lane token for "${laneId}"`);
  const clean = String(reason ?? '').trim();
  if (!clean) throw new Error('a dead token needs the reason it died');
  laneTokens[laneId] = { ...entry, dead: true, deadReason: clean, checkedAt: now };
  return { ...settings, laneTokens };
}

/**
 * Resolves all available accounts for lanes, including multi-account registered ones
 * and single-sign-in / installed CLI tools (Antigravity, Copilot, Junie, etc.).
 */
export async function resolveAllAccounts(registry, {
  presenceImpl,
  presenceFn,
  antigravityImpl,
  antigravityFn,
  installedImpl,
  installedFn,
} = {}) {
  const getPresence = presenceImpl || presenceFn || detectPresence;
  const getAntigravity = antigravityImpl || antigravityFn || antigravityPresence;
  const getInstalled = installedImpl || installedFn || detectInstalled;

  const accounts = [...(registry?.accounts || [])];
  const seenIds = new Set(accounts.map((a) => a.id));
  const seenProviders = new Set(accounts.map((a) => a.provider));

  // 1. Antigravity
  try {
    const ag = await getAntigravity();
    if (ag && (ag.signedIn || ag.cliInstalled || ag.appInstalled)) {
      if (!seenIds.has('antigravity') && !seenProviders.has('antigravity')) {
        const label = ag.who
          ? `Antigravity (${ag.who}${ag.plan ? `, ${ag.plan}` : ''})`
          : 'Antigravity';
        accounts.push({
          ...antigravityAccount(),
          label,
          singleSignIn: true,
          login: {
            signedIn: Boolean(ag.signedIn),
            level: ag.signedIn ? 'ok' : 'warn',
            detail: ag.signedIn ? (ag.plan ? `Signed in (${ag.plan})` : 'Signed in') : 'Not signed in',
          },
        });
        seenIds.add('antigravity');
        seenProviders.add('antigravity');
      }
    }
  } catch { /* ignore */ }

  // 2. Presence tools (Junie, Copilot CLI, Gemini CLI)
  try {
    const presences = await getPresence();
    for (const p of presences || []) {
      if (p.id in PROVIDERS) continue;
      if (seenIds.has(p.id) || seenProviders.has(p.id)) continue;
      if (p.signedIn || p.cliInstalled) {
        const label = p.who ? `${p.name || p.id} (${p.who})` : (p.name || p.id);
        accounts.push({
          id: p.id,
          label,
          provider: p.id,
          home: typeof p.home === 'function' ? p.home() : path.join(os.homedir(), `.${p.id}`),
          singleSignIn: true,
          login: {
            signedIn: Boolean(p.signedIn),
            level: p.signedIn ? 'ok' : 'warn',
            detail: p.signedIn ? 'Signed in' : (p.cliInstalled ? 'CLI installed' : 'Not signed in'),
          },
        });
        seenIds.add(p.id);
        seenProviders.add(p.id);
      }
    }
  } catch { /* ignore */ }

  // 3. Installed CLI tools (Grok, Ollama, etc.)
  try {
    const installed = await getInstalled();
    for (const tool of installed || []) {
      if (tool.id in PROVIDERS) continue;
      if (seenIds.has(tool.id) || seenProviders.has(tool.id)) continue;
      if (tool.installed) {
        accounts.push({
          id: tool.id,
          label: tool.name || tool.id,
          provider: tool.id,
          home: path.join(os.homedir(), `.${tool.id}`),
          singleSignIn: true,
          login: {
            signedIn: true,
            level: 'ok',
            detail: 'Installed',
          },
        });
        seenIds.add(tool.id);
        seenProviders.add(tool.id);
      }
    }
  } catch { /* ignore */ }

  return accounts;
}
