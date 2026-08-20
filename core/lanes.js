import { isSpent, latestReset } from './lanes-util.js';

/**
 * pure status evaluation for a lane
 */
export function laneStatus(lane, { quotas = {}, loginStates = {}, spendPolicies = {}, now, cooldowns = {} } = {}) {
  if (!now) throw new Error('now is required');

  const login = loginStates[lane.accountId];
  if (!login || login.signedIn == null) {
    return { status: 'unknown', reason: 'Authentication state is unknown', resetsAt: null };
  }
  if (login.signedIn === false) {
    return { status: 'signed-out', reason: 'Account is signed out', resetsAt: null };
  }

  const cooldownReset = cooldowns[lane.id];
  if (cooldownReset && cooldownReset > now) {
    return { status: 'cooldown', reason: 'Lane is on cooldown', resetsAt: cooldownReset };
  }

  const snapshot = quotas[lane.accountId];

  if (lane.billing === 'metered') {
    const policy = spendPolicies[lane.id];
    if (!policy || !policy.budget || policy.budget <= 0) {
      return { status: 'blocked', reason: 'Metered lane requires an active spend policy with remaining budget', resetsAt: null };
    }
    if (isSpent(snapshot) === true) {
      return { status: 'exhausted', reason: 'Metered quota exhausted', resetsAt: latestReset(snapshot, now) };
    }
    return { status: 'available', reason: 'Metered API is available', resetsAt: null };
  }

  const spent = isSpent(snapshot);
  if (spent === true) {
    return { status: 'exhausted', reason: 'Subscription quota exhausted', resetsAt: latestReset(snapshot, now) };
  }
  
  if (spent === null) {
    return { status: 'unknown', reason: 'Quota state is unknown or unreadable', resetsAt: null };
  }

  return { status: 'available', reason: 'Subscription has capacity', resetsAt: null };
}

/**
 * Select the next healthy account or provider deterministically.
 */
export function selectLane(pool = [], context = {}) {
  const { requirements = {} } = context;

  for (const lane of pool) {
    if (requirements.harness && lane.harness !== requirements.harness) continue;
    if (requirements.provider && lane.provider !== requirements.provider) continue;
    if (requirements.capabilities) {
      const laneCaps = lane.capabilities || [];
      if (!requirements.capabilities.every(c => laneCaps.includes(c))) continue;
    }

    const stat = laneStatus(lane, context);
    if (stat.status === 'available') {
      return { lane, status: stat };
    }
  }
  return null;
}
