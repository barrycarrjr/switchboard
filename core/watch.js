import { sharedProviderQuota } from './quota-cache.js';
import { activeAccount } from './accounts.js';
import { readUserEnv } from './env.js';
import { laneStatus, selectLane, worthSwitchingTo } from './lanes.js';
import { expiringWeek, hasHeadroom, isRunningOut, isSpent, latestReset, readable, tightestWindow } from './lanes-util.js';

export const SWITCH_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Collect a quota snapshot per Claude account. Reads, never acts.
 *
 * Through the shared cache, like every other caller that feeds a watch decision. Read
 * straight from the vendor, these snapshots would miss the turnover times a fallback
 * reading cannot state for itself, which is the one shape the decision layer cannot
 * defend against: it is a perfectly readable reading that has quietly lost the fact
 * the spend-down rests on. See inheritResetTimes.
 */
export async function snapshotQuotas({ accounts, usageSources = {}, fetchImpl = fetch, now = Date.now() }) {
  const snapshots = {};
  await Promise.all(accounts.filter((a) => a.provider === 'claude').map(async (a) => {
    snapshots[a.id] = await sharedProviderQuota(a, { usageSource: usageSources[a.id] ?? null, now, fetchImpl });
  }));
  return snapshots;
}

export { isSpent };

/**
 * The ambient-default decision. Pure: state in, decision out, so every case is
 * testable. It decides about the machine DEFAULT for new processes only; it knows
 * nothing about running tasks, by design.
 *
 * Decisions:
 *   {kind:'none'}                        nothing to do
 *   {kind:'pin-blocked'}                 switching is meaningless while a global token pins billing
 *   {kind:'switch'|'suggest', to, from, reason}   auto mode switches; notify mode suggests
 *   {kind:'exhausted', resetsAt}         everything readable is spent
 *
 * The trigger is running LOW, not being wholly out. Waiting for a full 100 meant the
 * default only ever moved once Claude Code was already refusing work, and the five-hour
 * window is what gets there first: it can sit at 95% while the weekly figure still reads
 * comfortable. See `HEADROOM_AT`. Coming back is a stricter test than leaving, so a
 * reading wobbling around the mark cannot walk the default back and forth: see
 * `HEADROOM_RETURNS_AT`.
 *
 * A second, independent trigger is another account's weekly window turning over soon
 * with quota still unspent. That quota is forfeited at the turnover, so it is spent
 * first even though the active account is perfectly healthy. See `expiringWeek`. Note
 * that with no lane pool there is no preferred account, so nothing brings the default
 * back afterwards: it stays where the last switch put it, exactly as it does after
 * every other switch this function makes. The round trip belongs to the lane path,
 * where lane order resumes once the window resets and stops qualifying.
 */
export function decideDefaultSwitch({ mode, accounts, activeId, snapshots, loginStates = null, now = Date.now(), lastSwitchAt = 0, pinPresent = false }) {
  if (mode !== 'notify' && mode !== 'auto') return { kind: 'none' };
  const claude = accounts.filter((a) => a.provider === 'claude');
  const active = claude.find((a) => a.id === activeId);
  if (!active || claude.length < 2) return { kind: 'none' };

  const activeSnapshot = snapshots[active.id];
  const runningOut = isRunningOut(activeSnapshot) === true;

  // Desktop can supply a truthful usage snapshot for an account whose CLI is signed
  // out. That is useful for display, but never enough to switch into it.
  const others = claude.filter((a) => (
    a.id !== active.id
    && (!loginStates || loginStates[a.id]?.signedIn === true)
  ));

  // Every candidate here is by definition not the account holding the default, so each
  // is judged at the return mark rather than the leave mark: an account has to have
  // dropped clear of the band, not merely be a point better than the one in place. Two
  // accounts hovering either side of 90% therefore stop trading the default between
  // them. See `HEADROOM_RETURNS_AT`.
  let eligible = others.filter((a) => hasHeadroom(snapshots[a.id]));

  // Unless the default has actually hit the wall, which is not a question the band was
  // ever meant to answer. The band exists to stop the default drifting between two
  // accounts that both still work; leaving it parked on one that has stopped working is
  // a worse outcome than the drift it prevents, and the reading it would turn on can be
  // three points of a five-hour window that refills of its own accord. So when the
  // default is spent and nothing has dropped clear of the band, the candidates are
  // judged at the leaving mark instead: the single line every account was held to
  // before the band existed. Anything under it still runs, and an account that runs
  // beats one that has hit the wall. The lane path has always answered this the same
  // way; see the `selectLane(providerLanes, ...)` fallback in planDefaultSwitches.
  if (!eligible.length && isSpent(activeSnapshot) === true) {
    eligible = others.filter((a) => isRunningOut(snapshots[a.id]) === false);
  }

  // Accounts about to forfeit quota, soonest turnover first because the first to turn
  // over has the least time left to spend it.
  const expiringTargets = eligible
    .map((a) => [a, expiringWeek(snapshots[a.id], now)])
    .filter(([, at]) => at != null)
    .sort((x, y) => x[1] - y[1]);

  // The second trigger, besides the active account running low: another account's
  // weekly window turns over soon with quota still unspent, which is quota about to
  // be lost. Leaving a HEALTHY default takes proof the candidate's turnover is
  // strictly sooner than the default's own, read from a CURRENT reading. Both halves
  // of that are anti-flap: with the comparison made against a missing reading, one
  // failed read of the default's meter would swing the default away and the next good
  // read would swing it back, once per cooldown for as long as the blips recur; and
  // with `<=` instead of `<`, two accounts whose weeks turn over at the same instant
  // would trade the default forever, each pass finding the other one "sooner".
  const activeWeekReset = readable(activeSnapshot)
    ? activeSnapshot.windows?.find((w) => w.key === 'week')?.resetsAt ?? null
    : null;
  const spendDown = activeWeekReset == null
    ? []
    : expiringTargets.filter(([, at]) => at < activeWeekReset).map(([a]) => a);

  if (!runningOut && !spendDown.length) return { kind: 'none' };

  // The running-out gate is running-LOW, not empty, so the renderers need to know
  // which of the two is being reported: telling someone their account "is out of
  // quota" while it is still working is a false alarm about the wrong problem. A
  // spend-down that a pin happens to block is not worth an alarm at all: nothing is
  // wrong with the active account, and nothing was going to stop working.
  if (pinPresent) {
    return runningOut
      ? { kind: 'pin-blocked', spent: isSpent(activeSnapshot) === true }
      : { kind: 'none' };
  }
  // A stamp in the FUTURE means the clock that wrote it was wrong (VM resume, clock
  // correction), and treating the negative age as inside the cooldown would suppress
  // every switch for the whole skew, with nothing rewriting the stamp in the
  // meantime. Expired, not inside: the next applied switch re-stamps with the
  // corrected clock. Same guard as the lane-token freshness window in lane-tokens.js.
  const sinceSwitch = now - lastSwitchAt;
  if (sinceSwitch >= 0 && sinceSwitch < SWITCH_COOLDOWN_MS) return { kind: 'none' };

  // A running-low default leaves regardless, so its target skips the active-turnover
  // comparison: an account about to forfeit quota outranks everything else, and
  // otherwise the ranking is by whichever window is fullest, not by the weekly one. An
  // account can be idle for the week and nearly out of its five-hour window, and
  // ranking on the week alone put exactly that account at the front of the queue.
  const target = runningOut
    ? expiringTargets[0]?.[0]
      ?? eligible.sort((x, y) => (tightestWindow(snapshots[x.id]) ?? 0) - (tightestWindow(snapshots[y.id]) ?? 0))[0]
    : spendDown[0];

  if (!target) {
    // Nowhere to go. Say "out of quota" only when that is literally true; an account
    // that is merely running low is still working, and calling it exhausted would send
    // an alarm about something the user can do nothing about and does not yet need to.
    return isSpent(activeSnapshot) === true
      ? { kind: 'exhausted', resetsAt: latestReset(activeSnapshot, now) }
      : { kind: 'none' };
  }

  // The reason names the trigger. An active account running low is the more pressing
  // of the two, so it wins the sentence even when the target was picked for its
  // expiring week.
  const state = isSpent(activeSnapshot) === true ? 'is out of quota' : 'is nearly out of quota';
  const reason = runningOut
    ? `${active.label} ${state}; ${target.label} has room`
    : `${target.label} has unused quota that expires soon; spending it down before ${active.label}`;
  return { kind: mode === 'auto' ? 'switch' : 'suggest', to: target.id, from: active.id, reason };
}

/**
 * The whole watch decision, for every tool with registered accounts.
 *
 * The tray app held the only copy of this loop, so nothing outside the desktop could
 * take the same decision, and a headless machine could not watch quota at all. It is
 * pure: readings in, decisions out. Nothing here changes the machine, notifies anyone
 * or reads a file, so the tray renders the result as notifications and `switchboard
 * watch` prints it, and neither can drift from the other.
 *
 * Each decision names its provider, because a machine can have several tools whose
 * accounts run out independently:
 *   {kind:'pin-blocked', provider}                     an override makes switching unreliable
 *   {kind:'exhausted', provider, resetsAt}             nothing readable has room
 *   {kind:'switch'|'suggest', provider, to, from, reason}
 */
export function planDefaultSwitches({
  settings,
  registry,
  snapshots = {},
  loginStates = {},
  pinPresent = false,
  now = Date.now(),
  // Which account is the default right now is read from the persisted environment.
  // Injectable so the decision can be tested without the machine's own settings.
  envReader = readUserEnv,
} = {}) {
  const decisions = [];
  const mode = settings?.quotaWatch;
  if (mode !== 'notify' && mode !== 'auto') return decisions;

  const accounts = registry?.accounts ?? [];
  const lanes = settings.lanes ?? [];

  for (const provider of new Set(accounts.map((a) => a.provider))) {
    const active = activeAccount(registry, provider, envReader);
    const providerLanes = lanes.filter((l) => l.harness === provider);

    // A configured pool is the whole answer for its tool: it names the order somebody
    // chose, so the legacy Claude-only reasoning below must not second-guess it.
    if (providerLanes.length) {
      const context = {
        now,
        loginStates,
        quotas: snapshots,
        spendPolicies: settings.spendPolicies ?? {},
        cooldowns: settings.cooldowns ?? {},
        requirements: { harness: provider },
      };

      // Lane order still decides; usage decides which lanes are in the running at all.
      // A lane whose five-hour window is nearly gone is a fine place to send one run
      // (it works, and a run that hits the wall falls over to the next lane), and a bad
      // place to point every terminal on the machine. Without this, the top lane took
      // the default back the moment it dropped under a full 100, which is how a default
      // landed on an account with minutes left in its window and everything stopped.
      // A metered lane has a spend policy rather than a usage meter, so it is judged by
      // `laneStatus` alone and never filtered out here for want of a reading.
      //
      // The lane holding the default is judged on whether it is still keeping it, and
      // every other lane on whether it has dropped clear enough to take it, which is
      // what leaves a dead band between the two. This path is where a single mark hurt
      // most: lane order pulls the default back to the top lane the instant that lane
      // looks roomy again, so a top lane reading either side of 90% took the default,
      // gave it up and took it back all day. See `HEADROOM_RETURNS_AT`.
      const roomy = providerLanes.filter((l) => (
        l.billing === 'metered'
        || hasHeadroom(snapshots[l.accountId], { holdsDefault: l.accountId === active?.id })
      ));

      // A lane whose weekly window turns over soon with quota still unspent jumps the
      // queue: that quota is forfeited at the turnover, while the preferred lane keeps
      // whatever this detour leaves it. Soonest-first when several qualify, since the
      // first to turn over has the least time left to spend. Once the window resets it
      // stops qualifying and lane order takes the default back, so the detour undoes
      // itself. A metered lane is pay-per-use and has nothing that expires. Reordering
      // rather than overriding, so a spend-down lane that turns out to be signed out or
      // on cooldown still falls through to the ordinary order.
      const expiring = roomy
        .filter((l) => l.billing !== 'metered')
        .map((l) => [l, expiringWeek(snapshots[l.accountId], now, { holdsDefault: l.accountId === active?.id })])
        .filter(([, at]) => at != null)
        .sort((x, y) => x[1] - y[1])
        .map(([l]) => l);
      const pool = [...expiring, ...roomy.filter((l) => !expiring.includes(l))];

      let selected = selectLane(pool, context);
      // Nothing has room and the default is genuinely spent: take the ordinary pick,
      // because any account that still runs beats one that has hit the wall.
      if (!selected && isSpent(snapshots[active?.id]) === true) selected = selectLane(providerLanes, context);

      // What plain lane order would have chosen, had no lane jumped the queue. Every
      // pre-existing behavior is judged against this rather than against `selected`,
      // so the reorder can add a switch without silently changing what the watch
      // would have said about the machine anyway. Same fallback as above, because
      // `pool` is only a reordering of `roomy`: when one is empty so is the other.
      let plainPick = selectLane(roomy, context);
      if (!plainPick && isSpent(snapshots[active?.id]) === true) plainPick = selectLane(providerLanes, context);

      // Only a lane we can actually vouch for may take over the machine default. A
      // last-resort lane is one whose usage could not be read, and pointing every new
      // terminal on the machine at an account on that basis is far more than the one
      // run the last-resort slot was meant to cover.
      if (!worthSwitchingTo(selected) || !active || selected.lane.accountId === active.id) continue;

      // A default whose meter or sign-in state merely failed to read is not moved.
      // There is no evidence anything is wrong with it, and acting anyway made every
      // read blip a round trip: the failed read swung the default to the next lane,
      // the recovered read swung it back, once per cooldown for as long as the blips
      // lasted. Only for the absences, though: a signed-out, cooling-down, or provably
      // spent default still hands over, because those are readings, not the absence of
      // one. 'unknown' (sign-in unreadable) counts as an absence the same way
      // 'quota-unknown' does; the credentials file is briefly unparseable during the
      // CLI's own token refresh, which is a blip, not a state.
      const activeLane = providerLanes.find((l) => l.accountId === active.id);
      if (activeLane && ['unknown', 'quota-unknown'].includes(laneStatus(activeLane, context).status)) continue;

      // A switch that exists only because of the spend-down reorder, as opposed to one
      // lane order wanted anyway. It decides the reason below: when a lane jumped the
      // queue, calling it the highest lane with room would be false.
      const spendDownOnly = expiring.includes(selected.lane) && selected.lane !== plainPick?.lane;

      if (provider === 'claude' && pinPresent) {
        // Whether the pin blocked something that was going to happen regardless. Asking
        // "is this a spend-down?" is the wrong question and got this wrong: when the
        // default sits on neither the plain pick nor the expiring lane, a lane-priority
        // switch was independently wanted and blocked, and reading the switch as a
        // spend-down silenced that alarm for the whole expiring day, including for a
        // default that was signed out. Only a pin that blocks nothing but the detour is
        // worth no alarm: nothing is wrong with the default and nothing was going to
        // stop working.
        const pinBlockedARealSwitch = worthSwitchingTo(plainPick) && plainPick.lane.accountId !== active.id;
        if (pinBlockedARealSwitch) decisions.push({ kind: 'pin-blocked', provider, spent: isSpent(snapshots[active.id]) === true });
        continue;
      }
      // Future stamp reads as an expired cooldown, same as decideDefaultSwitch above.
      const sinceAuto = now - (settings.lastAutoSwitchAt ?? 0);
      if (sinceAuto >= 0 && sinceAuto < SWITCH_COOLDOWN_MS) continue;

      decisions.push({
        kind: mode === 'auto' ? 'switch' : 'suggest',
        provider,
        to: selected.lane.accountId,
        from: active.id,
        reason: spendDownOnly
          ? `${selected.lane.id} has unused quota that expires soon; spending it down before ${active.label}`
          : isRunningOut(snapshots[active.id]) === true
            ? `${active.label} is close to its limit; ${selected.lane.id} is the highest ${provider} lane with room`
            : `Lane priority dictates ${selected.lane.id} is the highest healthy ${provider} account`,
      });
      continue;
    }

    // No pool for this tool. Claude alone has a usage reading good enough to decide on
    // without one; every other tool waits until somebody defines lanes.
    if (provider !== 'claude') continue;
    const decision = decideDefaultSwitch({
      mode,
      accounts,
      activeId: active?.id ?? null,
      snapshots,
      loginStates,
      now,
      lastSwitchAt: settings.lastAutoSwitchAt ?? 0,
      pinPresent,
    });
    if (decision.kind !== 'none') decisions.push({ ...decision, provider: 'claude' });
  }

  return decisions;
}
