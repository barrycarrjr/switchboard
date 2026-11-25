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
  if (session == null && week == null) {
    if (snapshot?.windows?.length) {
      return snapshot.windows.some((w) => (w.usedPercent ?? 0) >= SPENT_AT);
    }
    return null;
  }
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

  const gatingKeys = GATING.some((k) => windows.some((x) => x.key === k))
    ? GATING
    : windows.map((x) => x.key);

  for (const key of gatingKeys) {
    const w = windows.find((x) => x.key === key);
    if (!w || w.usedPercent == null) continue;
    sawReadable = true;
    if (w.usedPercent < SPENT_AT) continue;
    if (w.resetsAt != null) {
      if (w.resetsAt > now) spent = true;
      else sawExpired = true; // the window turned over; what has been used since is unknown
      continue;
    }
    const lifetime = WINDOW_LIFETIME_MS[key] ?? (String(key).includes('5h') ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000);
    if (now - takenAt <= lifetime) spent = true;
    else sawExpired = true;
  }

  if (spent) return { state: 'spent', resetsAt: latestReset(snapshot, now) };
  if (sawExpired) return { state: 'expired', resetsAt: null };
  return { state: sawReadable ? 'clear' : 'none', resetsAt: null };
}

/**
 * How far under its limit a meter has to read before a hold placed on the vendor's own
 * refusal gives way to it.
 *
 * A refusal is harder evidence than a reading: it is the vendor saying no to a real run.
 * Usage in a window only climbs until the window turns over, so a meter that refused work
 * and now reads well under its limit was lowered by the vendor. A point or two under is
 * something else: the usage sources read that far apart for one and the same account (see
 * `HEADROOM_RETURNS_AT`), and letting a reading like that end the hold would lend the
 * account straight back into the refusal it was held for. So a meter counts as lifted
 * only under 97%, which leaves the same three-point band between the two answers.
 */
export const LIMIT_LIFTED_UNDER = SPENT_AT - 3;

/**
 * How far apart the vendor's two statements of one reset may be and still be one reset.
 * The refusal states it to the second and the usage reading to the millisecond (seen for
 * one weekly reset: 1795741200000 and 1795741199789), so the two never compare equal. A
 * minute is far wider than they differ by and far narrower than the gap between any two
 * windows of one account.
 */
const SAME_RESET_MS = 60 * 1000;

/**
 * How far ahead of `now` a reading's time may sit and still be believed. `now` is fixed
 * when a caller starts choosing a lane, and a reading fetched while it chooses is stamped
 * as it arrives, a moment later. A time further ahead than any fetch takes means the
 * clock has been set back since the reading was taken, and then nothing says whether it
 * came before the refusal or after it.
 */
const READING_LEAD_MS = 60 * 1000;

/** When a reading was taken, or null when it does not say. */
function takenAt(snapshot) {
  if (Number.isFinite(snapshot?.sampledAt)) return snapshot.sampledAt;
  return Number.isFinite(snapshot?.observedAt) ? snapshot.observedAt : null;
}

/**
 * Whether a reading shows that a limit the vendor refused a run for has since been lifted,
 * ahead of the time the vendor gave for it.
 *
 * `since` is when the refusal was reported and `until` is the reset time it stated. The
 * reading has to be a current one, has to say when it was taken, and has to have been
 * taken after the refusal and not after `now` (`READING_LEAD_MS` aside). An older one
 * describes the account before it was refused, and one with no time, or a time still to
 * come, cannot be placed either side of the refusal at all.
 *
 * Only the meters that turn over at `until` are asked, because that is the one way a
 * reading names the limit that was hit. There has to be at least one, and every one of
 * them has to read clear (`LIMIT_LIFTED_UNDER`), per-model meters included: those never
 * stop an account as a whole (see `GATING`), but one of them can be what refused the run,
 * and it turns over together with the weekly meter.
 *
 * Everything else leaves the hold alone, on purpose. A reading with no meter turning over
 * at `until` says nothing about the limit that was hit: that is a short hold placed for
 * some other failure, or a window the endpoint did not list, and a hold lifted on such a
 * reading would be lifted on every reading, which is no hold at all. The same goes for a
 * limit the vendor lifts by starting a fresh window with a new reset time. Nothing in the
 * reading can be tied to the refusal any more, so the hold runs to the time it was given,
 * as every hold did before this.
 */
export function limitLifted(snapshot, { since, until, now } = {}) {
  if (!readable(snapshot)) return false;
  if (!Number.isFinite(since) || !Number.isFinite(until) || !Number.isFinite(now)) return false;
  const at = takenAt(snapshot);
  if (at == null || at <= since || at > now + READING_LEAD_MS) return false;
  const named = (snapshot.windows ?? [])
    .filter((w) => Number.isFinite(w?.resetsAt) && Math.abs(w.resetsAt - until) <= SAME_RESET_MS);
  return named.length > 0
    && named.every((w) => w.usedPercent != null && w.usedPercent < LIMIT_LIFTED_UNDER);
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

const MINUTE_MS = 60 * 1000;

/**
 * When this account's weekly window turns over, for ranking accounts against each other:
 * the sooner it turns over, the sooner its unused quota is lost, so the sooner it should
 * be spent. Null when a current reading cannot say.
 *
 * Rounded to the minute. The vendor states the turnover to the millisecond, and two
 * readings of one and the same turnover differ in the last digits (seen on this machine:
 * 59:59.613 and 59:59.618 for two accounts whose weeks end together). Ranked raw, accounts
 * like that would swap places from one reading to the next and drag the machine default
 * with them. Rounded, they compare equal, and lane order settles it the same way every time.
 *
 * A week that has not started, or has turned over since the reading was taken, is a
 * whole week from its next turnover, which is later than any week already under way, so
 * it is given that. The vendor reports an unstarted week as nothing used and no turnover
 * at all, and a reading taken just before the turnover still names the moment that has
 * now passed. Read as "turnover unknown" instead, the account whose week had only just
 * begun was held on to as though its turnover might be the soonest, when it is the latest.
 *
 * An account that has hit a limit right now gets no turnover at all. It cannot take work
 * until a window turns over, so it waits behind every account that can, rather than
 * heading a list it would only be skipped in. Nor does one that has used some of its week
 * but whose reading states no turnover; `turnoverRank` says where that one goes.
 */
export function weekTurnover(snapshot, now, { evenIfSpent = false } = {}) {
  if (!readable(snapshot) || (!evenIfSpent && isSpent(snapshot) === true)) return null;
  const week = snapshot.windows?.find((w) => w.key === 'week');
  if (week?.usedPercent == null) return null;
  const startsAfresh = week.resetsAt ? week.resetsAt <= now : week.usedPercent === 0;
  const at = startsAfresh ? now + WINDOW_LIFETIME_MS.week : week.resetsAt;
  if (!at) return null;
  return Math.round(at / MINUTE_MS) * MINUTE_MS;
}

/**
 * Where an account goes when accounts are ranked by turnover: its `weekTurnover`, or, for
 * a week under way whose reading states no turnover, just ahead of a week that has only
 * begun. Such a week must turn over within seven days, so it is certain to lose its
 * remainder before a fresh one does, but nothing says how it compares with a turnover that
 * is stated, so it goes after those. Null when the account cannot be ranked at all.
 *
 * Kept apart from `weekTurnover` because nothing may be claimed from it: a notification
 * that says one reset comes "sooner" than another uses `weekTurnover`, which has no value
 * for a turnover nobody stated.
 *
 * `evenIfSpent` ranks a reading that says the account is out of quota, for a caller that
 * knows the limit has since lifted (see selectLaneAsNeeded) and will check before using it.
 */
export function turnoverRank(snapshot, now, { evenIfSpent = false } = {}) {
  const at = weekTurnover(snapshot, now, { evenIfSpent });
  if (at != null) return at;
  if (!readable(snapshot) || (!evenIfSpent && isSpent(snapshot) === true)) return null;
  const week = snapshot.windows?.find((w) => w.key === 'week');
  if (week?.usedPercent == null || week.resetsAt || week.usedPercent === 0) return null;
  return Math.round((now + WINDOW_LIFETIME_MS.week) / MINUTE_MS) * MINUTE_MS - MINUTE_MS;
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
