import { PROVIDERS } from './accounts.js';

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
const VENDORS = { claude: 'anthropic', codex: 'openai', gemini: 'google' };

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
  const account = accounts.find((a) => a.id === accountId);
  if (!account) return `no registered account with id "${accountId}"`;
  if (!PROVIDERS[account.provider]) return `account "${accountId}" names an unknown tool: ${account.provider}`;
  if (!BILLING_KINDS.includes(billing)) return `billing must be one of: ${BILLING_KINDS.join(', ')}`;
  if (lanes.some((l) => l.accountId === accountId && l.billing === billing)) {
    return `a ${billing} lane for "${accountId}" already exists, and a second one could never be selected`;
  }
  return null;
}

/** The lane an account maps to. Pure, so the id is the caller's to decide. */
export function buildLane(account, billing, id) {
  return {
    id,
    harness: account.provider,
    provider: vendorForHarness(account.provider),
    accountId: account.id,
    billing,
    capabilities: [...DEFAULT_CAPABILITIES],
  };
}

/** The id a new lane gets. Kept in the app's existing shape so old lanes still read. */
export function nextLaneId(now = Date.now()) {
  return `lane-${now}`;
}

/**
 * Add a lane to the end of the pool, which is the lowest priority. Throws on anything
 * laneProblem refuses, so no caller has to remember to check first.
 */
export function addLane(settings, { accountId, billing = 'subscription' } = {}, accounts = [], now = Date.now()) {
  const lanes = settings.lanes ?? [];
  const problem = laneProblem({ accountId, billing }, accounts, lanes);
  if (problem) throw new Error(problem);
  const account = accounts.find((a) => a.id === accountId);
  const lane = buildLane(account, billing, nextLaneId(now));
  return { settings: { ...settings, lanes: [...lanes, lane] }, lane };
}

/**
 * Take a lane out of the pool, along with the three things filed under its id. Leaving
 * any of them behind would silently apply to the next lane to reuse the id, and for the
 * token that means a reused id inheriting an old account's credential.
 */
export function removeLane(settings, laneId) {
  const lanes = settings.lanes ?? [];
  if (!lanes.some((l) => l.id === laneId)) throw new Error(`no lane with id "${laneId}"`);
  const spendPolicies = { ...(settings.spendPolicies ?? {}) };
  const cooldowns = { ...(settings.cooldowns ?? {}) };
  const laneTokens = { ...(settings.laneTokens ?? {}) };
  delete spendPolicies[laneId];
  delete cooldowns[laneId];
  delete laneTokens[laneId];
  return { ...settings, lanes: lanes.filter((l) => l.id !== laneId), spendPolicies, cooldowns, laneTokens };
}

/** Lane ids in a list that name no lane. Empty when they all do. */
export function unknownLaneIds(settings, laneIds = []) {
  const known = new Set((settings.lanes ?? []).map((l) => l.id));
  return laneIds.filter((id) => !known.has(id));
}

/**
 * Reorder the pool. Ids not mentioned keep their relative order at the end rather than
 * being dropped: a partial list is a partial instruction, never a deletion.
 */
export function reorderLanes(settings, laneIds = []) {
  const lanes = settings.lanes ?? [];
  const ordered = [];
  for (const id of laneIds) {
    const found = lanes.find((l) => l.id === id);
    if (found && !ordered.includes(found)) ordered.push(found);
  }
  for (const lane of lanes) {
    if (!ordered.includes(lane)) ordered.push(lane);
  }
  return { ...settings, lanes: ordered };
}

/**
 * Set or clear what a metered lane may spend. Null clears it, which blocks the lane:
 * a metered lane with no budget is deliberately unselectable rather than unlimited.
 */
export function setLaneBudget(settings, laneId, budget) {
  const lanes = settings.lanes ?? [];
  if (!lanes.some((l) => l.id === laneId)) throw new Error(`no lane with id "${laneId}"`);
  const spendPolicies = { ...(settings.spendPolicies ?? {}) };
  if (budget === null || budget === undefined) {
    delete spendPolicies[laneId];
    return { ...settings, spendPolicies };
  }
  const amount = Number(budget);
  if (!Number.isFinite(amount) || amount <= 0) throw new Error('a budget must be a number greater than zero');
  spendPolicies[laneId] = { budget: amount };
  return { ...settings, spendPolicies };
}

/**
 * Store the token a lane hands to automation. The token rides ALONGSIDE the folder
 * sign-in, never instead of it: lane selection still needs the folder signed in, and
 * this entry only tells automation to authenticate without touching that login. The
 * account id is stored with it so a later check can name which account the token was
 * minted for, the minting login's identity uuids are stamped on so the token stops
 * being handed out once the folder is signed in as someone else, and storing a fresh
 * entry drops any dead mark from a previous one.
 */
export function setLaneToken(settings, laneId, entry = {}) {
  const lanes = settings.lanes ?? [];
  if (!lanes.some((l) => l.id === laneId)) throw new Error(`no lane with id "${laneId}"`);
  if (typeof entry.token !== 'string' || !entry.token.trim()) throw new Error('a lane token must be a non-empty string');
  if (typeof entry.accountId !== 'string' || !entry.accountId.trim()) throw new Error('a lane token needs the account id it was minted for');
  const mintedAt = Number(entry.mintedAt);
  if (!Number.isFinite(mintedAt) || mintedAt <= 0) throw new Error('a lane token needs the time it was minted');
  const stored = { token: entry.token, accountId: entry.accountId, mintedAt };
  // The identity stamp is not required here, but an unstamped entry is refused by the
  // identity gate (no legitimately minted entry lacks one), and a stamp that is
  // present must be usable: a malformed one stored silently would read back as "no
  // stamp" and be refused the same way, hiding the real problem.
  if (entry.organizationUuid != null) {
    if (typeof entry.organizationUuid !== 'string' || !entry.organizationUuid.trim()) throw new Error('an identity stamp needs a non-empty organization uuid');
    stored.organizationUuid = entry.organizationUuid;
  }
  if (entry.accountUuid != null) {
    if (typeof entry.accountUuid !== 'string' || !entry.accountUuid.trim()) throw new Error('an identity stamp needs a non-empty account uuid');
    stored.accountUuid = entry.accountUuid;
  }
  const laneTokens = { ...(settings.laneTokens ?? {}) };
  laneTokens[laneId] = stored;
  return { ...settings, laneTokens };
}

/**
 * Delete a stored lane token. Keyed on the entry rather than the lane, so a token left
 * behind by settings edited outside the app can still be removed by hand.
 */
export function removeLaneToken(settings, laneId) {
  const laneTokens = { ...(settings.laneTokens ?? {}) };
  if (!laneTokens[laneId]) throw new Error(`no lane token for "${laneId}"`);
  delete laneTokens[laneId];
  return { ...settings, laneTokens };
}

/**
 * Mark a stored token as no longer honoured. The entry is kept rather than deleted so
 * the Health tab can say WHY automation reverted to folder mode and what to run; only
 * minting a fresh token (or removing the entry) clears the mark.
 */
export function markLaneTokenDead(settings, laneId, reason, now = Date.now()) {
  const laneTokens = { ...(settings.laneTokens ?? {}) };
  const entry = laneTokens[laneId];
  if (!entry) throw new Error(`no lane token for "${laneId}"`);
  const clean = String(reason ?? '').trim();
  if (!clean) throw new Error('a dead token needs the reason it died');
  laneTokens[laneId] = { ...entry, dead: true, deadReason: clean, checkedAt: now };
  return { ...settings, laneTokens };
}
