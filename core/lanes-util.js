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

/**
 * How full a window may get before an account stops being somewhere to send new work.
 *
 * `SPENT_AT` above answers a different question: whether an account can run at all. That
 * is the right test for one run (a lane at 97% still works, and the run that finally hits
 * the wall simply falls over to the next lane), and the wrong test for the machine
 * default, which redirects every terminal opened afterwards and stays put until something
 * moves it.
 *
 * Waiting for a full 100 meant the default was only ever moved once Claude Code had
 * already started refusing work, and it meant the default could be handed to an account
 * with minutes left in its five-hour window. The five-hour window is the one that bites
 * in practice: it is the smallest, it fills fastest, and it can sit at 90-odd percent
 * while the weekly figure still reads comfortable, which is exactly the state that looks
 * healthy and is not.
 *
 * So the default moves early, and only to somewhere with real room left. The numbers are
 * deliberately different per window: 10% of a five-hour window is a few minutes of heavy
 * use, while 5% of a weekly window is most of a working day.
 */
export const HEADROOM_AT = { session: 90, week: 95 };

/** The gating windows a snapshot actually reported, as [key, percent] pairs. */
function gatingWindows(snapshot) {
  return GATING
    .map((key) => [key, pct(snapshot, key)])
    .filter(([, used]) => used != null);
}

/**
 * The fullest gating window, which is what ranking candidates should compare. Ranking on
 * the weekly figure alone put an account with a nearly-spent five-hour window ahead of a
 * genuinely idle one, because the weekly number said nothing about the window that was
 * about to stop the work.
 */
export function tightestWindow(snapshot) {
  const used = gatingWindows(snapshot).map(([, value]) => value);
  return used.length ? Math.max(...used) : null;
}

/**
 * Whether an account has room to spare on every gating window. Unreadable is never room:
 * a reading we do not have cannot vouch for anything, and pointing the whole machine at
 * an account on that basis is the very thing `worthSwitchingTo` exists to prevent.
 */
export function hasHeadroom(snapshot) {
  if (!readable(snapshot)) return false;
  const windows = gatingWindows(snapshot);
  if (!windows.length) return false;
  return windows.every(([key, used]) => used < HEADROOM_AT[key]);
}

/**
 * Whether an account is close enough to a limit that new work should go elsewhere. Null
 * when there is nothing readable to say so, so an unreadable account is never pushed off
 * the default on a guess.
 */
export function isRunningOut(snapshot) {
  if (!readable(snapshot)) return null;
  const windows = gatingWindows(snapshot);
  if (!windows.length) return null;
  return windows.some(([key, used]) => used >= HEADROOM_AT[key]);
}
