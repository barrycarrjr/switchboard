import { readable, spentEvidence } from './lanes-util.js';

/**
 * pure status evaluation for a lane
 *
 * 'quota-unknown' is a signed-in account whose usage reading failed. It is deliberately
 * not the same as 'unknown', which means we cannot even say whether the account is signed
 * in. Failing to read the meter is not evidence the tank is empty, and the usage endpoint
 * fails often enough that treating it as empty took every Claude lane out at once over a
 * network hiccup. A metered lane has always worked this way; this makes a subscription
 * lane behave the same.
 *
 * A reading we could not refresh is still read rather than thrown away, but only in the
 * direction that stays true: see `spentEvidence`. Throwing it away is how an account that
 * was plainly out of quota came out as merely unreadable, and so stayed in the running.
 *
 * A stale verdict here is cleared by any successful reading, so this can hold an account
 * out no longer than the endpoint stays unreachable.
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

  const evidence = spentEvidence(snapshot, now);

  if (lane.billing === 'metered') {
    const policy = spendPolicies[lane.id];
    if (!policy || !policy.budget || policy.budget <= 0) {
      return { status: 'blocked', reason: 'Metered lane requires an active spend policy with remaining budget', resetsAt: null };
    }
    if (evidence.state === 'spent') {
      return { status: 'exhausted', reason: 'Metered quota exhausted', resetsAt: evidence.resetsAt };
    }
    return { status: 'available', reason: 'Metered API is available', resetsAt: null };
  }

  if (evidence.state === 'spent') {
    return { status: 'exhausted', reason: 'Subscription quota exhausted', resetsAt: evidence.resetsAt };
  }

  // It said the account was out, and that has run out of road: the window it described has
  // turned over, so what has been used since is anyone's guess. Not a reason to rule the
  // account out, and not a reason to claim it has room either.
  if (evidence.state === 'expired') {
    return { status: 'quota-unknown', reason: 'Signed in, but its usage is no longer known', resetsAt: null };
  }

  // Only a current reading may say an account has room. A stale one describes a moment
  // that every run since has moved on from, so it counts as nothing, and the lane drops to
  // the last-resort slot rather than being ruled out.
  if (evidence.state === 'clear' && readable(snapshot)) {
    return { status: 'available', reason: 'Subscription has capacity', resetsAt: null };
  }

  return { status: 'quota-unknown', reason: 'Signed in, but its usage could not be read', resetsAt: null };
}

/**
 * Whether a selection is solid enough to change the machine default, as opposed to being
 * worth trying for one run.
 *
 * These are not the same decision. Handing a run to an account we cannot vouch for costs
 * one failed run, and the next lane picks the work up. Changing the default writes
 * CLAUDE_CONFIG_DIR at user scope, so it silently redirects every terminal opened
 * afterwards and every agent anything on this machine spawns, and it stays that way until
 * something changes it back. A last-resort lane is fine for the first and much too thin
 * for the second.
 */
export function worthSwitchingTo(selected) {
  return Boolean(selected) && selected.status?.status === 'available';
}

/**
 * Whether a tool's machine default follows its lane order, so that choosing an account
 * by hand is not offered.
 *
 * With the watch on "Switch automatically", planDefaultSwitches keeps a tool that has
 * lanes on the first lane with room, so an account picked by hand is switched straight
 * back at the next pass, within five minutes. A switch offered in that state only
 * appears to work, and that is how it was found: the button did its job and the default
 * quietly went back. The Accounts page, the tray menu, the switch itself and
 * `switchboard use` all ask this one question, so none of them can offer what another
 * would undo.
 *
 * Nothing moves a choice made by hand when the watch only tells you or does nothing, or
 * when the tool has no lanes, so the switch stays on offer then, exactly as before.
 */
export function defaultFollowsLanes(settings, provider) {
  return settings?.quotaWatch === 'auto'
    && (settings.lanes ?? []).some((lane) => lane?.harness === provider);
}

/**
 * The same fact in words, for wherever a switch by hand would otherwise be offered. It
 * says how to get the choice back, because a control that disappears without saying
 * where it went reads as a fault.
 */
export function followsLanesNote(toolName) {
  return `New ${toolName} sessions follow your lane order while the watch is set to switch automatically. Reorder the lanes to change which account they use, or set "When an account runs out" to "Tell me" or "Do nothing" in the tray menu to choose one by hand.`;
}

/**
 * What `switchboard use` says after switching in that state anyway. Unlike the tray, a
 * terminal command cannot tell whether any watch is running to undo the switch, and no
 * command changes the watch setting, so refusing could leave a machine with no way to
 * switch from a terminal at all. It switches, and says what a running watch will do.
 */
export function switchedAgainstLanesNote(toolName) {
  return `Note: ${toolName} has lanes and the watch is set to switch automatically, so if the tray app or "switchboard watch" is running, it will move new ${toolName} sessions back to the first ready account in your lane order at its next check. Reorder the lanes to change which account that is.`;
}

/**
 * The three ways lane selection can come up empty. They are kept apart because a caller
 * does something different about each: configure lanes, correct the request, or wait.
 *
 * Reading as one message is how this went unnoticed for a day. A caller asking for a
 * provider name no lane carries was told "no lane is currently available", which sounds
 * like a busy machine, so it fell back quietly instead of reporting a mistake.
 */
export const NO_LANES_CONFIGURED = 'No lanes are configured.';
export const NO_LANES_MATCH = 'No configured lanes match the criteria.';
export const NO_LANE_AVAILABLE = 'No lane is currently available.';

/** Which of those three a failed selection was, given the pool before and after filtering. */
export function selectionFailure(allLanes = [], matchingLanes = []) {
  if (!allLanes.length) return NO_LANES_CONFIGURED;
  if (!matchingLanes.length) return NO_LANES_MATCH;
  return NO_LANE_AVAILABLE;
}

/**
 * Whether a lane answers to a name a caller asked for.
 *
 * A lane carries two names for the same thing: the harness that runs it ("claude") and
 * the vendor behind it ("anthropic"). Everywhere else the command line says "provider" it
 * means the harness, because that is what `switchboard add` and `switchboard accounts`
 * use, so `--provider claude` matched nothing at all and callers fell back silently. Both
 * names are accepted here, and they cannot collide: no vendor shares a name with a
 * harness.
 */
export function laneAnswersTo(lane, wanted) {
  const name = String(wanted ?? '').trim().toLowerCase();
  if (!name) return true;
  return String(lane?.provider ?? '').toLowerCase() === name
    || String(lane?.harness ?? '').toLowerCase() === name;
}

/**
 * The lanes a caller is willing and able to use, in the order the owner put them.
 *
 * `dry-run` and `run` both start here, and that is the point of it living in one place:
 * `dry-run` exists to tell a caller what `run` is about to do, so the two may never narrow
 * the pool differently.
 *
 * `harnesses` is the list of tools the caller can build a command line for, or null when
 * it can drive anything. Dropping the rest here, before selection, is what lets lanes sit
 * in any order. It used to be decided after selection instead: the first healthy lane won
 * whatever its tool, and a caller that could not drive it either gave up on the pool or,
 * on a failover, had the run ended under it ("refusing to guess") while a lane it could
 * have used sat one place lower. The owner's order then had to be arranged around what
 * each caller happened to support, which is backwards.
 */
export function narrowPool(lanes = [], { account = null, provider = null, harnesses = null } = {}) {
  const drivable = Array.isArray(harnesses) ? harnesses.map((h) => String(h).toLowerCase()) : null;
  return lanes
    .filter((l) => !account || l.accountId === account)
    .filter((l) => laneAnswersTo(l, provider))
    .filter((l) => !drivable || drivable.includes(String(l?.harness ?? '').toLowerCase()));
}

/**
 * The lanes `narrowPool` left out only because the caller cannot drive their tool. Said
 * once at the start of a run, so a lane that never gets work has a reason on record
 * instead of looking broken.
 */
export function lanesCallerCannotDrive(lanes = [], { account = null, provider = null, harnesses = null } = {}) {
  if (!Array.isArray(harnesses)) return [];
  const kept = new Set(narrowPool(lanes, { account, provider, harnesses }).map((l) => l.id));
  return narrowPool(lanes, { account, provider }).filter((l) => !kept.has(l.id));
}

/**
 * Select the next healthy account or provider deterministically.
 */
export function selectLane(pool = [], context = {}) {
  const { requirements = {} } = context;
  let fallback = null;

  for (const lane of pool) {
    if (requirements.harness && lane.harness !== requirements.harness) continue;
    if (requirements.provider && !laneAnswersTo(lane, requirements.provider)) continue;
    if (requirements.capabilities) {
      const laneCaps = lane.capabilities || [];
      if (!requirements.capabilities.every(c => laneCaps.includes(c))) continue;
    }

    const stat = laneStatus(lane, context);
    if (stat.status === 'available') {
      return { lane, status: stat };
    }
    // A lane whose usage could not be read is a last resort, never a first choice: it is
    // held back until every lane has been looked at, so any lane with a good reading
    // wins. If it does turn out to be spent, the run fails on the limit and falls over to
    // the next lane, which is a better outcome than refusing to start at all.
    if (stat.status === 'quota-unknown' && !fallback) {
      fallback = { lane, status: stat };
    }
  }
  return fallback;
}
