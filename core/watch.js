import { accountQuota } from './quota.js';
import { activeAccount } from './accounts.js';
import { readUserEnv } from './env.js';
import { selectLane, worthSwitchingTo } from './lanes.js';
import { hasHeadroom, isRunningOut, isSpent, latestReset, tightestWindow } from './lanes-util.js';

export const SWITCH_COOLDOWN_MS = 10 * 60 * 1000;

/** Collect a quota snapshot per Claude account. Reads, never acts. */
export async function snapshotQuotas({ accounts, usageSources = {}, fetchImpl = fetch, now = Date.now() }) {
  const snapshots = {};
  await Promise.all(accounts.filter((a) => a.provider === 'claude').map(async (a) => {
    snapshots[a.id] = await accountQuota(a.home, fetchImpl, usageSources[a.id] ?? null, now);
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
 * comfortable. See `HEADROOM_AT`.
 */
export function decideDefaultSwitch({ mode, accounts, activeId, snapshots, loginStates = null, now = Date.now(), lastSwitchAt = 0, pinPresent = false }) {
  if (mode !== 'notify' && mode !== 'auto') return { kind: 'none' };
  const claude = accounts.filter((a) => a.provider === 'claude');
  const active = claude.find((a) => a.id === activeId);
  if (!active || claude.length < 2) return { kind: 'none' };

  const activeSnapshot = snapshots[active.id];
  if (isRunningOut(activeSnapshot) !== true) return { kind: 'none' };

  if (pinPresent) return { kind: 'pin-blocked' };
  if (now - lastSwitchAt < SWITCH_COOLDOWN_MS) return { kind: 'none' };

  const target = claude
    .filter((a) => (
      a.id !== active.id
      && hasHeadroom(snapshots[a.id])
      // Desktop can supply a truthful usage snapshot for an account whose CLI is
      // signed out. That is useful for display, but never enough to switch into it.
      && (!loginStates || loginStates[a.id]?.signedIn === true)
    ))
    // Ranked by whichever window is fullest, not by the weekly one. An account can be
    // idle for the week and nearly out of its five-hour window, and ranking on the week
    // alone put exactly that account at the front of the queue.
    .sort((x, y) => (tightestWindow(snapshots[x.id]) ?? 0) - (tightestWindow(snapshots[y.id]) ?? 0))[0];

  if (!target) {
    // Nowhere to go. Say "out of quota" only when that is literally true; an account
    // that is merely running low is still working, and calling it exhausted would send
    // an alarm about something the user can do nothing about and does not yet need to.
    return isSpent(activeSnapshot) === true
      ? { kind: 'exhausted', resetsAt: latestReset(activeSnapshot, now) }
      : { kind: 'none' };
  }

  const state = isSpent(activeSnapshot) === true ? 'is out of quota' : 'is nearly out of quota';
  const reason = `${active.label} ${state}; ${target.label} has room`;
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
      const roomy = providerLanes.filter((l) => l.billing === 'metered' || hasHeadroom(snapshots[l.accountId]));

      let selected = selectLane(roomy, context);
      // Nothing has room and the default is genuinely spent: take the ordinary pick,
      // because any account that still runs beats one that has hit the wall.
      if (!selected && isSpent(snapshots[active?.id]) === true) selected = selectLane(providerLanes, context);

      // Only a lane we can actually vouch for may take over the machine default. A
      // last-resort lane is one whose usage could not be read, and pointing every new
      // terminal on the machine at an account on that basis is far more than the one
      // run the last-resort slot was meant to cover.
      if (!worthSwitchingTo(selected) || !active || selected.lane.accountId === active.id) continue;

      if (provider === 'claude' && pinPresent) {
        decisions.push({ kind: 'pin-blocked', provider });
        continue;
      }
      if (now - (settings.lastAutoSwitchAt ?? 0) < SWITCH_COOLDOWN_MS) continue;

      decisions.push({
        kind: mode === 'auto' ? 'switch' : 'suggest',
        provider,
        to: selected.lane.accountId,
        from: active.id,
        reason: isRunningOut(snapshots[active.id]) === true
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
