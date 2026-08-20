import { accountQuota } from './quota.js';
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
