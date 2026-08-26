import { accountQuota } from './quota.js';
import { activeAccount } from './accounts.js';
import { readUserEnv } from './env.js';
import { selectLane, worthSwitchingTo } from './lanes.js';
import { isSpent, latestReset, pct, readable, SPENT_AT } from './lanes-util.js';

export const SWITCH_COOLDOWN_MS = 10 * 60 * 1000;
const ROOM_BELOW = 95;  // a target must be comfortably below its limits

/** Collect a quota snapshot per Claude account. Reads, never acts. */
export async function snapshotQuotas({ accounts, usageSources = {}, fetchImpl = fetch, now = Date.now() }) {
  const snapshots = {};
  await Promise.all(accounts.filter((a) => a.provider === 'claude').map(async (a) => {
    snapshots[a.id] = await accountQuota(a.home, fetchImpl, usageSources[a.id] ?? null, now);
  }));
  return snapshots;
}

export { isSpent };

function hasRoom(snapshot) {
  if (!readable(snapshot)) return false; // never switch TO an unknown
  const session = pct(snapshot, 'session');
  const week = pct(snapshot, 'week');
  if (session == null && week == null) return false;
  return (session ?? 0) < ROOM_BELOW && (week ?? 0) < ROOM_BELOW;
}

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
 */
export function decideDefaultSwitch({ mode, accounts, activeId, snapshots, loginStates = null, now = Date.now(), lastSwitchAt = 0, pinPresent = false }) {
  if (mode !== 'notify' && mode !== 'auto') return { kind: 'none' };
  const claude = accounts.filter((a) => a.provider === 'claude');
  const active = claude.find((a) => a.id === activeId);
  if (!active || claude.length < 2) return { kind: 'none' };

  const activeSnapshot = snapshots[active.id];
  if (isSpent(activeSnapshot) !== true) return { kind: 'none' };

  if (pinPresent) return { kind: 'pin-blocked' };
  if (now - lastSwitchAt < SWITCH_COOLDOWN_MS) return { kind: 'none' };

  const target = claude
    .filter((a) => (
      a.id !== active.id
      && hasRoom(snapshots[a.id])
      // Desktop can supply a truthful usage snapshot for an account whose CLI is
      // signed out. That is useful for display, but never enough to switch into it.
      && (!loginStates || loginStates[a.id]?.signedIn === true)
    ))
    .sort((x, y) => (pct(snapshots[x.id], 'week') ?? 0) - (pct(snapshots[y.id], 'week') ?? 0))[0];

  if (!target) {
    return { kind: 'exhausted', resetsAt: latestReset(activeSnapshot, now) };
  }

  const reason = `${active.label} is out of quota; ${target.label} has room`;
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
      const selected = selectLane(providerLanes, {
        now,
        loginStates,
        quotas: snapshots,
        spendPolicies: settings.spendPolicies ?? {},
        cooldowns: settings.cooldowns ?? {},
        requirements: { harness: provider },
      });

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
        reason: `Lane priority dictates ${selected.lane.id} is the highest healthy ${provider} account`,
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
