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
 * Take a lane out of the pool, along with the two things filed under its id. Leaving
 * either behind would silently apply to the next lane to reuse the id.
 */
export function removeLane(settings, laneId) {
  const lanes = settings.lanes ?? [];
  if (!lanes.some((l) => l.id === laneId)) throw new Error(`no lane with id "${laneId}"`);
  const spendPolicies = { ...(settings.spendPolicies ?? {}) };
  const cooldowns = { ...(settings.cooldowns ?? {}) };
  delete spendPolicies[laneId];
  delete cooldowns[laneId];
  return { ...settings, lanes: lanes.filter((l) => l.id !== laneId), spendPolicies, cooldowns };
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
