import { PROVIDERS } from './accounts.js';
import { hasHeadroom, readable, spentEvidence, turnoverRank } from './lanes-util.js';

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
 * Whether a tool's machine default is picked from its lanes by the watch, so that
 * choosing an account by hand is not offered.
 *
 * With the watch on "Switch automatically", planDefaultSwitches keeps a tool that has
 * lanes on the first lane with room, taken soonest weekly reset first (see
 * `ordersBySoonestReset`), so an account picked by hand is switched straight back at the
 * next pass, within five minutes. A switch offered in that state only appears to work,
 * and that is how it was found: the button did its job and the default quietly went
 * back. The Accounts page, the tray menu, the switch itself and `switchboard use` all ask
 * this one question, so none of them can offer what another would undo.
 *
 * Nothing moves a choice made by hand when the watch only tells you or does nothing, or
 * when the tool has no lanes, so the switch stays on offer then, exactly as before.
 */
export function defaultFollowsLanes(settings, provider) {
  return ordersBySoonestReset(settings)
    && (settings.lanes ?? []).some((lane) => lane?.harness === provider);
}

/**
 * Whether a tool whose default follows its lanes actually has accounts to rank by reset:
 * Switchboard reads its usage, and at least two accounts have subscription lanes. Only
 * then is "soonest weekly reset first" true of it. Gemini CLI and Qwen Code have no usage
 * reading, and a tool with one subscription account or only metered lanes has nothing to
 * rank, so for those the lane order decides on its own and the words say so, as before.
 * `accounts`, when given, is the registry: a lane whose account is gone can never be
 * picked, so it is not counted.
 */
export function ranksByReset(settings, provider, accounts = null) {
  if (!defaultFollowsLanes(settings, provider) || !PROVIDERS[provider]?.quota) return false;
  const registered = Array.isArray(accounts) ? new Set(accounts.map((a) => a.id)) : null;
  const ranked = new Set((settings.lanes ?? [])
    .filter((lane) => lane?.harness === provider && lane.billing !== 'metered')
    .filter((lane) => !registered || registered.has(lane.accountId))
    .map((lane) => lane.accountId));
  return ranked.size > 1;
}

/**
 * The same fact in words, for wherever a switch by hand would otherwise be offered. It
 * says how to get the choice back, because a control that disappears without saying
 * where it went reads as a fault. `byReset` is `ranksByReset` for the tool.
 *
 * `readsUsage` is false for a tool Switchboard reads no usage for (Gemini CLI, Qwen Code).
 * The watch has no reading to move such a default on, and keeps a default whose reading
 * merely failed where it is, so it never moves one between subscription accounts. It can
 * still move it onto a ready pay-per-use lane, which needs no reading, when the account in
 * use is signed out or has no subscription lane holding it where it is. Telling the user
 * to reorder the lanes, or that the watch would
 * move a hand pick back, sent them to change something that did nothing.
 */
export function followsLanesNote(toolName, byReset = true, readsUsage = true) {
  if (!readsUsage) {
    return `Switchboard reads no usage for ${toolName}, so while the watch is set to switch automatically it never moves new ${toolName} sessions between subscription accounts; it moves them only onto the first ready pay-per-use lane, and only when the account in use is signed out or has no subscription lane of its own. To choose an account by hand, set "When an account runs out" to "Tell me" or "Do nothing" in the tray menu.`;
  }
  return byReset
    ? `While the watch is set to switch automatically, new ${toolName} sessions use the first ready account in your lanes, taking subscription accounts soonest weekly reset first so quota is spent before it is lost. Your lane order decides everything else. To choose an account by hand, set "When an account runs out" to "Tell me" or "Do nothing" in the tray menu.`
    : `New ${toolName} sessions follow your lane order while the watch is set to switch automatically. Reorder the lanes to change which account they use, or set "When an account runs out" to "Tell me" or "Do nothing" in the tray menu to choose one by hand.`;
}

/**
 * What `switchboard use` says after switching in that state anyway. Unlike the tray, a
 * terminal command cannot tell whether any watch is running to undo the switch, and no
 * command changes the watch setting, so refusing could leave a machine with no way to
 * switch from a terminal at all. It switches, and says what a running watch will do.
 */
export function switchedAgainstLanesNote(toolName, byReset = true, readsUsage = true) {
  if (!readsUsage) {
    return `Note: Switchboard reads no usage for ${toolName}, so a running watch never moves new ${toolName} sessions between subscription accounts; it moves them only onto the first ready pay-per-use lane, and only when the account in use is signed out or has no subscription lane of its own.`;
  }
  return byReset
    ? `Note: ${toolName} has lanes and the watch is set to switch automatically, so if the tray app or "switchboard watch" is running, it will move new ${toolName} sessions at its next check to the first ready account in your lanes, taking subscription accounts soonest weekly reset first.`
    : `Note: ${toolName} has lanes and the watch is set to switch automatically, so if the tray app or "switchboard watch" is running, it will move new ${toolName} sessions back to the first ready account in your lane order at its next check. Reorder the lanes to change which account that is.`;
}

/**
 * Whether the lanes of one tool are taken soonest weekly reset first, rather than in the
 * order they were put in.
 *
 * A weekly window is use-it-or-lose-it: whatever is unspent when it turns over is gone.
 * Taking the account that turns over first means the least is lost across all of them.
 * This used to happen only on a window's last day, as a detour from lane order, so an
 * account resetting in two days still waited behind one resetting in six (seen
 * 2026-10-26: the account resetting Thursday sat behind the one resetting the following
 * Monday, only because it was lower in the list).
 *
 * Only on "Switch automatically", because that is the setting where Switchboard is asked
 * to manage the accounts. On "Tell me" and "Do nothing" a person is choosing, and the lane
 * order they set is followed as written. Read from the stored setting by `run` and
 * `dry-run`, so the order a run takes is the one the tray shows.
 */
export function ordersBySoonestReset(settings) {
  return settings?.quotaWatch === 'auto';
}

/** Which tool a lane belongs to, for grouping lanes that may trade places. */
function toolOf(lane) {
  return String(lane?.harness ?? '').toLowerCase();
}

/**
 * The lanes in the order they are tried when taken soonest weekly reset first.
 *
 * `context` is what `laneStatus` reads: `now`, `quotas`, `loginStates`, `cooldowns`.
 *
 * Only subscription lanes of the same tool trade places, and only among the positions that
 * tool's subscription lanes already hold. So the order as set still decides which tool
 * comes first and where a metered lane sits: a pay-per-use lane has nothing that expires,
 * and moving one would change what somebody pays.
 *
 * Within a tool, only a lane that can take work right now is ranked on its turnover (see
 * `weekTurnover`). Every other one (signed out, sign-in unreadable, on cooldown, spent,
 * usage unreadable, or no reset stated) follows the ranked ones in the order as set. A lane
 * that cannot run used to be ranked on its usage reading alone, which a signed-out account
 * still has, so it took its tool's first place, was skipped there, and the next place down
 * went to a metered lane or another tool while an account of the same tool had room.
 * Lanes that turn over together keep their order as set, so the order still breaks ties.
 *
 * `canRank` replaces "can take work right now" with a stricter test. The watch passes "has
 * room to take the machine default", so that the places ahead of a metered lane go to
 * accounts that can actually take the default, and the metered lane is never reached past
 * a subscription that could. `rankOf` replaces how a ranked lane's turnover is read.
 */
export function soonestResetOrder(lanes = [], context = {}, { canRank = null, rankOf = null } = {}) {
  const { quotas = {}, now } = context;
  const slotsByTool = new Map();
  lanes.forEach((lane, index) => {
    if (lane?.billing === 'metered') return;
    if (!slotsByTool.has(toolOf(lane))) slotsByTool.set(toolOf(lane), []);
    slotsByTool.get(toolOf(lane)).push(index);
  });

  const rank = (lane) => {
    const eligible = canRank ? canRank(lane) : laneStatus(lane, { ...context, now }).status === 'available';
    if (!eligible) return null;
    return rankOf ? rankOf(lane) : turnoverRank(quotas[lane.accountId], now);
  };

  const ordered = [...lanes];
  for (const slots of slotsByTool.values()) {
    const ranked = slots
      .map((index) => ({ lane: lanes[index], index, at: rank(lanes[index]) }))
      // Unranked last, then soonest first, then the order as set. Three keys compared in
      // turn, so the comparison is consistent and the sort cannot come out differently
      // for the same readings.
      .sort((x, y) => (Number(x.at == null) - Number(y.at == null))
        || ((x.at ?? 0) - (y.at ?? 0))
        || (x.index - y.index));
    slots.forEach((slot, k) => { ordered[slot] = ranked[k].lane; });
  }
  return ordered;
}

/**
 * Whether a lane may take the machine default, as opposed to one run: room on both windows
 * (the default's own account judged on keeping it, every other on taking it; see
 * `hasHeadroom`), and able to run. A metered lane has a spend policy rather than a usage
 * meter, so it is judged on running alone.
 */
export function canTakeDefault(lane, context = {}, defaultAccountId = null) {
  if (laneStatus(lane, context).status !== 'available') return false;
  return lane.billing === 'metered'
    || hasHeadroom(context.quotas?.[lane.accountId], { holdsDefault: lane.accountId === defaultAccountId });
}

/**
 * Whether a reading shows an account too close to a limit to take the machine default,
 * which is why it is listed after accounts that reset later. Only from a reading that can
 * be trusted to say so: an unreadable one proves nothing either way. The tray menu and the
 * Accounts page both mark it, so neither list reads as out of order.
 */
export function tooFullForDefault(snapshot, holdsDefault = false) {
  return Boolean(readable(snapshot)) && !hasHeadroom(snapshot, { holdsDefault });
}

/**
 * The order the machine default is picked in on "Switch automatically": soonest reset
 * first, ranking only lanes that could take the default. A run counts any lane that can
 * run, because a run that hits the wall simply moves on; the default redirects every
 * terminal opened afterwards, so it waits for room. The watch and the lists in the tray
 * and on the Accounts page all use this one, so they cannot disagree about it.
 */
export function defaultOrder(lanes = [], context = {}, defaultAccountId = null) {
  return soonestResetOrder(lanes, context, { canRank: (lane) => canTakeDefault(lane, context, defaultAccountId) });
}

/**
 * The accounts of one tool in the order they would be used, for the tray menu and the
 * Accounts page to list them in: the order the default is picked in (`defaultOrder`), so
 * the account shown in use is the first one that can take it. Accounts with no lane come
 * after those with one, in the order given, since nothing would ever choose them on its
 * own. With nothing read yet, the lane order is all there is.
 *
 * A list in some other order beside a heading that says how the order is decided read as
 * though the rule was not being followed, which is how this was asked for: the tray listed
 * accounts as registered while the watch was picking them by reset.
 */
export function accountUseOrder(accounts = [], lanes = [], provider, context = {}, defaultAccountId = null) {
  const mine = accounts.filter((a) => a.provider === provider);
  const ids = [];
  for (const lane of defaultOrder(lanes.filter((l) => l?.harness === provider), context, defaultAccountId)) {
    if (!ids.includes(lane.accountId) && mine.some((a) => a.id === lane.accountId)) ids.push(lane.accountId);
  }
  return [...ids.map((id) => mine.find((a) => a.id === id)), ...mine.filter((a) => !ids.includes(a.id))];
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
 * Whether a caller's requirements allow a lane at all, before its account is looked at.
 * One test for selectLane and selectLaneAsNeeded, so they cannot disagree about which lanes
 * are in the running.
 */
function meetsRequirements(lane, requirements = {}) {
  if (requirements.harness && lane.harness !== requirements.harness) return false;
  if (requirements.provider && !laneAnswersTo(lane, requirements.provider)) return false;
  if (requirements.capabilities) {
    const laneCaps = lane.capabilities || [];
    if (!requirements.capabilities.every(c => laneCaps.includes(c))) return false;
  }
  return true;
}

/**
 * Select the next healthy account or provider deterministically.
 */
export function selectLane(pool = [], context = {}) {
  const { requirements = {} } = context;
  let fallback = null;

  for (const lane of pool) {
    if (!meetsRequirements(lane, requirements)) continue;

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

/**
 * selectLane, reading each account only when its lane comes up.
 *
 * selectLane wants every account's sign-in and usage in hand before it starts, and reading
 * them is the slow part: a usage reading older than the shared cache allows means asking
 * the vendor, and for Antigravity it means starting the `agy` CLI twice. `dry-run` and
 * `run` used to read every lane's account first, one after another, so naming the lane at
 * the top of the list waited on lanes far below it. The Slack bridge allows `dry-run`
 * eight seconds, and about one of its checks in ten ran past that (diagnosed 2026-09-25):
 * the bridge then ran the work unbrokered and logged that no lane was available, while
 * the first lane had room all along.
 *
 * Nothing below the first lane with room can change the answer, because selectLane returns
 * that lane without looking further. So the lanes are walked in order, an account is read
 * the first time one of its lanes comes up, and the walk stops at the first lane with room.
 * Only when no lane has room is every account read, since the last resort (a lane whose
 * meter could not be read) is only chosen once all of them have been seen.
 *
 * `readAccount(accountId)` resolves to `{ login, quota }` for one account, either of which
 * may be missing. The answer is always the one selectLane gives with every account read up
 * front.
 *
 * With `bySoonestReset` the walk is over `soonestResetOrder` instead. A tool can only be
 * ranked once every account with a subscription lane in it has been looked at, so the
 * first time the walk reaches one of a tool's places, all of them are looked at together
 * and that tool's places are settled for good. A tool the walk never reaches is never
 * looked at.
 *
 * `peekAccount(accountId)` is that look, when given: `{ login, quota }` from what is
 * already on the machine, never the vendor. Ranking needs only when each week turns over,
 * and a reading of that stays true until the moment passes, however old it is. Reading
 * every account of a tool live instead meant an account whose usage call was failing or
 * slow was asked, and waited on, by every `dry-run`, even though a failed reading is never
 * ranked anyway; that is the eight-second wait this walk was written to get rid of. The
 * lanes the walk actually reaches are still read in full, as above, and when a full reading
 * finds that a lane the look ranked cannot run after all, the rest of its tool is ranked
 * again on what is now known before the walk moves on. An account whose call is failing is
 * therefore asked only when its last good reading makes it the best candidate. Without
 * `peekAccount` the full reading is used for both, and the answer is the one selectLane
 * gives over `soonestResetOrder` with everything read up front.
 */
export async function selectLaneAsNeeded(pool = [], context = {}, readAccount = async () => ({}), { bySoonestReset = false, peekAccount = null } = {}) {
  const candidates = pool.filter((lane) => meetsRequirements(lane, context.requirements));
  const known = { ...context, loginStates: { ...context.loginStates }, quotas: { ...context.quotas } };
  // One read per account, shared by everyone waiting on it.
  const reads = new Map();
  const readOnce = (accountId) => {
    if (!reads.has(accountId)) {
      reads.set(accountId, (async () => {
        const { login, quota } = (await readAccount(accountId)) ?? {};
        if (login !== undefined) known.loginStates[accountId] = login;
        if (quota !== undefined) known.quotas[accountId] = quota;
      })());
    }
    return reads.get(accountId);
  };
  const peeked = { ...context, loginStates: { ...context.loginStates }, quotas: { ...context.quotas } };
  const look = peekAccount
    ? async (accountId) => {
      const { login, quota } = (await peekAccount(accountId)) ?? {};
      if (login !== undefined) peeked.loginStates[accountId] = login;
      if (quota !== undefined) peeked.quotas[accountId] = quota;
    }
    : readOnce;
  const rankedOn = peekAccount ? peeked : known;
  // A look can be hours old. One that says an account is out of quota until a time that
  // has since passed is not evidence it is still out, only that it was: ranked as unknown,
  // it fell behind every other account and was never read again until they all ran out,
  // while its limit had long lifted. So such an account is ranked on its week as though
  // the limit had lifted, and the full reading the walk takes before using it settles it.
  // A limit still in force, a sign-out or a cooldown still keep it out of the ranking.
  const lookRanking = {
    canRank: (lane) => {
      const status = laneStatus(lane, peeked).status;
      if (status === 'available') return true;
      return status === 'quota-unknown' && spentEvidence(peeked.quotas[lane.accountId], peeked.now).state === 'expired';
    },
    rankOf: (lane) => turnoverRank(peeked.quotas[lane.accountId], peeked.now, { evenIfSpent: true }),
  };

  const walk = [...candidates];
  const settled = new Set();
  // Lanes whose full reading has been weighed at the place they held, so a place is looked
  // at again only when a lane not yet weighed has moved into it.
  const examined = new Set();
  const subscriptionOf = (tool) => (lane) => lane.billing !== 'metered' && toolOf(lane) === tool;
  for (let i = 0; i < candidates.length; i++) {
    const place = candidates[i];
    if (bySoonestReset && place.billing !== 'metered' && !settled.has(toolOf(place))) {
      const tool = toolOf(place);
      settled.add(tool);
      await Promise.all([...new Set(candidates.filter(subscriptionOf(tool)).map((l) => l.accountId))].map(look));
      const ranked = soonestResetOrder(candidates, rankedOn, peekAccount ? lookRanking : {});
      candidates.forEach((lane, j) => { if (subscriptionOf(tool)(lane)) walk[j] = ranked[j]; });
    }
    await readOnce(walk[i].accountId);

    // The look said this lane could run, and the full reading says it cannot (it filled up
    // since the cached reading, or its call is failing). Ranked on what is now known, it
    // falls behind the rest of its tool, so the tool's later places are ranked again from
    // here and this place is looked at once more with whoever now holds it. Moving straight
    // on would hand the place after it to whatever sits there, a metered lane or another
    // tool, while an account of this tool had room.
    if (bySoonestReset && peekAccount && walk[i].billing !== 'metered'
      && laneStatus(walk[i], known).status !== 'available' && !examined.has(walk[i])) {
      examined.add(walk[i]);
      const tool = toolOf(walk[i]);
      const places = candidates.map((_, j) => j).filter((j) => j >= i && subscriptionOf(tool)(candidates[j]));
      const asSet = places.map((j) => walk[j]).sort((x, y) => candidates.indexOf(x) - candidates.indexOf(y));
      // What has been read in full is judged on that; the rest on its look, as before.
      const fullyRead = (lane) => reads.has(lane.accountId);
      const reranked = soonestResetOrder(asSet, known, {
        canRank: (lane) => (fullyRead(lane) ? laneStatus(lane, known).status === 'available' : lookRanking.canRank(lane)),
        rankOf: (lane) => (fullyRead(lane) ? turnoverRank(known.quotas[lane.accountId], known.now) : lookRanking.rankOf(lane)),
      });
      places.forEach((j, k) => { walk[j] = reranked[k]; });
      if (!examined.has(walk[i])) { i -= 1; continue; }
    }
    examined.add(walk[i]);

    // Judged over the lanes walked so far and no further. A lane further down can share an
    // account that has now been read, and must not win over a lane between the two that
    // has not been read yet.
    const picked = selectLane(walk.slice(0, i + 1), known);
    if (picked?.status.status === 'available') return picked;
  }
  return selectLane(walk, known);
}
