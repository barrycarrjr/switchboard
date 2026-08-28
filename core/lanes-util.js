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

/**
 * How far a window has to fall before an account counts as somewhere to send the default
 * again, once it has already been passed over for being too full.
 *
 * `HEADROOM_AT` used to answer in both directions, so one mark decided both when the
 * default left an account and when it was allowed back. A reading sitting either side of
 * that mark then moved the default on every pass. The two usage sources do not always
 * agree to the point: the live endpoint and the Claude Desktop sample can read a couple
 * of percent apart for the same account, which is enough to cross a single mark back and
 * forth for hours. Simulated on readings straddling 90% five minutes apart, that came to
 * dozens of default changes a day, each one rewriting the machine default for every
 * terminal opened afterwards.
 *
 * So leaving and returning are asked different questions, and the gap between the two
 * answers is the dead band. An account gives up the default at `HEADROOM_AT` exactly as
 * before, and takes it back only once it has dropped clear to here. A reading anywhere in
 * between leaves the default where it already is. Three points is wider than the sources
 * disagree by and small enough that an account which has genuinely recovered is preferred
 * again well inside one window.
 */
export const HEADROOM_RETURNS_AT = { session: 87, week: 92 };

/**
 * How close a weekly turnover has to be before an account's unused quota counts as
 * about to be lost.
 *
 * A subscription window is use-it-or-lose-it: whatever is unspent when the week turns
 * over is simply gone. When one account's week ends tonight and another's runs until
 * Monday, new work should go to the one about to forfeit its remainder, even though it
 * is not the preferred account. A day is enough notice to actually spend a remainder
 * and short enough that the preference is only ever overridden on the window's last
 * day. Only the weekly window counts: a five-hour window refills so often that its
 * remainder is never worth chasing.
 */
export const SPEND_DOWN_HORIZON_MS = 24 * 60 * 60 * 1000;

/**
 * When this account's weekly window turns over soon enough that its unused quota is
 * about to be lost: the turnover time. Null otherwise.
 *
 * Everything here must be provable from a current reading. Headroom, because an
 * account without room has nothing left to spend. A reported weekly percentage,
 * because "unused quota" cannot be claimed about a meter that was not read. And a
 * turnover time in the future, because one in the past describes a week that has
 * already ended.
 *
 * `options` is passed straight to `hasHeadroom`, so an account already holding the
 * default is judged on whether it is keeping it rather than on whether it is worth
 * taking. Without that, an account parked here by a previous spend-down would stop
 * counting as expiring the moment it crossed the return mark, and the default would
 * leave mid-window for a lane further up the order, which is the round trip the whole
 * spend-down detour exists to avoid.
 */
export function expiringWeek(snapshot, now, options) {
  if (!hasHeadroom(snapshot, options)) return null;
  const week = snapshot.windows.find((w) => w.key === 'week');
  if (week?.usedPercent == null || !week.resetsAt || week.resetsAt <= now) return null;
  return week.resetsAt - now <= SPEND_DOWN_HORIZON_MS ? week.resetsAt : null;
}

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
 *
 * `holdsDefault` says whether the machine default already points at this account, and it
 * is what turns the two marks into one dead band instead of two unrelated rules. The
 * account holding the default is judged at `HEADROOM_AT`, so it keeps the default until
 * it really is near its limit; every other account is judged at `HEADROOM_RETURNS_AT`, so
 * taking the default off somebody takes more than a reading a percent or two the far side
 * of the same line. See `HEADROOM_RETURNS_AT`.
 */
export function hasHeadroom(snapshot, { holdsDefault = false } = {}) {
  if (!readable(snapshot)) return false;
  const windows = gatingWindows(snapshot);
  if (!windows.length) return false;
  const marks = holdsDefault ? HEADROOM_AT : HEADROOM_RETURNS_AT;
  return windows.every(([key, used]) => used < marks[key]);
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
