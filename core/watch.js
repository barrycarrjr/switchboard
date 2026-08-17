import { accountQuota } from './quota.js';

export const SWITCH_COOLDOWN_MS = 10 * 60 * 1000;
const SPENT_AT = 100;   // a window is spent at 100%
const ROOM_BELOW = 95;  // a target must be comfortably below its limits

/** Collect a quota snapshot per Claude account. Reads, never acts. */
export async function snapshotQuotas({ accounts, usageSources = {}, fetchImpl = fetch, now = Date.now() }) {
  const snapshots = {};
  await Promise.all(accounts.filter((a) => a.provider === 'claude').map(async (a) => {
    snapshots[a.id] = await accountQuota(a.home, fetchImpl, usageSources[a.id] ?? null, now);
  }));
  return snapshots;
}

function pct(snapshot, key) {
  const w = snapshot?.windows?.find((x) => x.key === key);
  return w?.usedPercent ?? null;
}

function readable(snapshot) {
  return snapshot && !snapshot.error && !snapshot.stale;
}

export function isSpent(snapshot) {
  if (!readable(snapshot)) return null; // unknown, never assumed
  const session = pct(snapshot, 'session');
  const week = pct(snapshot, 'week');
  if (session == null && week == null) return null;
  return (session ?? 0) >= SPENT_AT || (week ?? 0) >= SPENT_AT;
}

function hasRoom(snapshot) {
  if (!readable(snapshot)) return false; // never switch TO an unknown
  const session = pct(snapshot, 'session');
  const week = pct(snapshot, 'week');
  if (session == null && week == null) return false;
  return (session ?? 0) < ROOM_BELOW && (week ?? 0) < ROOM_BELOW;
}

function earliestReset(snapshot, now) {
  const times = (snapshot?.windows ?? [])
    .filter((w) => (w.usedPercent ?? 0) >= SPENT_AT && w.resetsAt && w.resetsAt > now)
    .map((w) => w.resetsAt);
  return times.length ? Math.min(...times) : null;
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
export function decideDefaultSwitch({ mode, accounts, activeId, snapshots, now = Date.now(), lastSwitchAt = 0, pinPresent = false }) {
  if (mode !== 'notify' && mode !== 'auto') return { kind: 'none' };
  const claude = accounts.filter((a) => a.provider === 'claude');
  const active = claude.find((a) => a.id === activeId);
  if (!active || claude.length < 2) return { kind: 'none' };

  const activeSnapshot = snapshots[active.id];
  if (isSpent(activeSnapshot) !== true) return { kind: 'none' };

  if (pinPresent) return { kind: 'pin-blocked' };
  if (now - lastSwitchAt < SWITCH_COOLDOWN_MS) return { kind: 'none' };

  const target = claude
    .filter((a) => a.id !== active.id && hasRoom(snapshots[a.id]))
    .sort((x, y) => (pct(snapshots[x.id], 'week') ?? 0) - (pct(snapshots[y.id], 'week') ?? 0))[0];

  if (!target) {
    return { kind: 'exhausted', resetsAt: earliestReset(activeSnapshot, now) };
  }

  const reason = `${active.label} is out of quota; ${target.label} has room`;
  return { kind: mode === 'auto' ? 'switch' : 'suggest', to: target.id, from: active.id, reason };
}
