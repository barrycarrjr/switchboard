export const SPENT_AT = 100;

export function pct(snapshot, key) {
  const w = snapshot?.windows?.find((x) => x.key === key);
  return w?.usedPercent ?? null;
}

export function readable(snapshot) {
  return snapshot && !snapshot.error && !snapshot.stale;
}

export function isSpent(snapshot) {
  if (!readable(snapshot)) return null;
  const session = pct(snapshot, 'session');
  const week = pct(snapshot, 'week');
  if (session == null && week == null) return null;
  return (session ?? 0) >= SPENT_AT || (week ?? 0) >= SPENT_AT;
}

export function latestReset(snapshot, now) {
  const times = (snapshot?.windows ?? [])
    .filter((w) => (w.usedPercent ?? 0) >= SPENT_AT && w.resetsAt && w.resetsAt > now)
    .map((w) => w.resetsAt);
  return times.length ? Math.max(...times) : null;
}
