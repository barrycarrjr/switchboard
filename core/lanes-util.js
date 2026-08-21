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

/**
 * The only two meters that say whether an account may work at all.
 *
 * The reply also carries overage credits and per-model meters. Neither stops an account
 * working: credits are a billing figure, and Anthropic's own documentation is explicit
 * that hitting the Opus limit leaves you working on another model. Counting either one
 * would park an account whose actual usage is a few percent.
 */
const GATING = ['session', 'week'];

/**
 * How long a meter reading can still be true when the vendor did not say when the window
 * turns over. These are the published lengths of the windows themselves, used as an upper
 * bound: a weekly window cannot have reset within an hour, so an hour-old reading of it
 * is still the truth.
 */
export const WINDOW_LIFETIME_MS = {
  session: 5 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
};

/**
 * What a reading still proves about an account being out of quota, at time `now`.
 *
 *   'spent'   out of quota, with resetsAt when the vendor said when it returns
 *   'expired' it said out of quota, and that can no longer be relied on
 *   'clear'   a meter was readable and was not at the limit
 *   'none'    no meter to read
 *
 * Bad news and good news do not age the same way, which is the whole point of this. Usage
 * only climbs until a window turns over, so a reading of "out" stays true and needs no
 * age limit beyond the window itself, and Claude Code blocks its own requests until the
 * reset time on the same reasoning. A reading of "has room" is the opposite: it describes
 * a moment that any run since has moved on from. So an old reading is allowed to rule an
 * account out, and never to rule one in; that is left to `readable`, which only accepts a
 * current reading.
 *
 * The age is measured from `sampledAt`, when the reading carries one. That matters for
 * the Claude Desktop fallback, whose sample can be hours older than the moment we read
 * the file. A reading with no `sampledAt` was just fetched.
 */
export function spentEvidence(snapshot, now) {
  const windows = snapshot?.windows ?? [];
  const takenAt = snapshot?.sampledAt ?? now;
  let sawExpired = false;
  let sawReadable = false;
  let spent = false;

  for (const key of GATING) {
    const w = windows.find((x) => x.key === key);
    if (!w || w.usedPercent == null) continue;
    sawReadable = true;
    if (w.usedPercent < SPENT_AT) continue;
    if (w.resetsAt != null) {
      if (w.resetsAt > now) spent = true;
      else sawExpired = true; // the window turned over; what has been used since is unknown
      continue;
    }
    if (now - takenAt <= WINDOW_LIFETIME_MS[key]) spent = true;
    else sawExpired = true;
  }

  if (spent) return { state: 'spent', resetsAt: latestReset(snapshot, now) };
  if (sawExpired) return { state: 'expired', resetsAt: null };
  return { state: sawReadable ? 'clear' : 'none', resetsAt: null };
}
