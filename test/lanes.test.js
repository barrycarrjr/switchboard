import test from 'node:test';
import assert from 'node:assert/strict';
import { laneStatus, selectLane, laneAnswersTo, selectionFailure, worthSwitchingTo, NO_LANES_CONFIGURED, NO_LANES_MATCH, NO_LANE_AVAILABLE } from '../core/lanes.js';
import { expiringWeek, hasHeadroom, isRunningOut, spentEvidence, tightestWindow, SPEND_DOWN_HORIZON_MS, WINDOW_LIFETIME_MS } from '../core/lanes-util.js';

function makeLane(id, accountId, billing = 'subscription') {
  return {
    id,
    harness: 'claude',
    provider: 'anthropic',
    accountId,
    billing,
    capabilities: ['chat'],
  };
}

test('laneStatus reports unknown for missing auth', () => {
  const lane = makeLane('l1', 'a1');
  const ctx = { now: 1000 };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'unknown');
  assert.equal(stat.reason, 'Authentication state is unknown');
});

test('laneStatus reports signed-out', () => {
  const lane = makeLane('l1', 'a1');
  const ctx = {
    now: 1000,
    loginStates: { a1: { signedIn: false } },
  };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'signed-out');
});

test('laneStatus reports cooldown', () => {
  const lane = makeLane('l1', 'a1');
  const ctx = {
    now: 1000,
    loginStates: { a1: { signedIn: true } },
    cooldowns: { l1: 2000 },
  };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'cooldown');
  assert.equal(stat.resetsAt, 2000);
});

// An unreadable meter and an unknown sign-in used to be the same answer, so a network
// hiccup on the usage endpoint took every Claude lane out at once.
test('laneStatus separates an unreadable meter from an unknown sign-in', () => {
  const lane = makeLane('l1', 'a1');
  const ctx = {
    now: 1000,
    loginStates: { a1: { signedIn: true } },
    quotas: { a1: { error: 'fetch failed' } },
  };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'quota-unknown');
  assert.equal(stat.reason, 'Signed in, but its usage could not be read');
  assert.notEqual(laneStatus(lane, { now: 1000 }).status, stat.status, 'an account we cannot vouch for is a different case');
});

test('laneStatus reports available for good subscription quota', () => {
  const lane = makeLane('l1', 'a1');
  const ctx = {
    now: 1000,
    loginStates: { a1: { signedIn: true } },
    quotas: {
      a1: {
        windows: [{ key: 'session', usedPercent: 50 }],
      },
    },
  };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'available');
});

test('laneStatus reports exhausted and returns latest reset time', () => {
  const lane = makeLane('l1', 'a1');
  const ctx = {
    now: 1000,
    loginStates: { a1: { signedIn: true } },
    quotas: {
      a1: {
        windows: [
          { key: 'session', usedPercent: 100, resetsAt: 5000 },
          { key: 'week', usedPercent: 100, resetsAt: 8000 }
        ],
      },
    },
  };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'exhausted');
  assert.equal(stat.resetsAt, 8000);
});

test('laneStatus blocks metered lane without spend policy', () => {
  const lane = makeLane('l2', 'a2', 'metered');
  const ctx = {
    now: 1000,
    loginStates: { a2: { signedIn: true } },
    quotas: {},
  };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'blocked');
});

test('laneStatus reports available for metered with spend policy budget', () => {
  const lane = makeLane('l2', 'a2', 'metered');
  const ctx = { 
    now: 1000,
    loginStates: { a2: { signedIn: true } },
    spendPolicies: { l2: { budget: 10 } },
    quotas: {} 
  };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'available');
});

test('selectLane filters by capabilities and harness', () => {
  const lane1 = makeLane('l1', 'a1');
  lane1.capabilities = ['chat'];
  lane1.harness = 'claude';
  
  const lane2 = makeLane('l2', 'a2');
  lane2.capabilities = ['chat', 'edit'];
  lane2.harness = 't3';

  const pool = [lane1, lane2];
  
  const ctx = {
    now: 1000,
    loginStates: {
      a1: { signedIn: true },
      a2: { signedIn: true },
    },
    quotas: {
      a1: { windows: [{ key: 'session', usedPercent: 50 }] },
      a2: { windows: [{ key: 'session', usedPercent: 50 }] },
    },
    requirements: {
      capabilities: ['edit'],
      harness: 't3'
    }
  };

  const selected = selectLane(pool, ctx);
  assert.ok(selected);
  assert.equal(selected.lane.id, 'l2');
});

test('selectLane returns first available lane', () => {
  const pool = [
    makeLane('l1', 'a1'), // exhausted
    makeLane('l2', 'a2'), // unknown auth
    makeLane('l3', 'a3', 'metered'), // available
  ];
  const ctx = {
    now: 1000,
    loginStates: {
      a1: { signedIn: true },
      a3: { signedIn: true },
    }, // a2 is unknown
    spendPolicies: { l3: { budget: 100 } },
    quotas: {
      a1: { windows: [{ key: 'session', usedPercent: 100 }] },
      a2: { stale: true },
    },
  };

  const selected = selectLane(pool, ctx);
  assert.ok(selected);
  assert.equal(selected.lane.id, 'l3');
  assert.equal(selected.status.status, 'available');
});

test('selectLane returns null if no available lanes', () => {
  const pool = [
    makeLane('l1', 'a1'), // signed-out
    makeLane('l2', 'a2'), // unknown auth
  ];
  const ctx = {
    now: 1000,
    loginStates: { a1: { signedIn: false } },
    quotas: {}, // a2 is unknown
  };

  const selected = selectLane(pool, ctx);
  assert.equal(selected, null);
});

// ---- Naming a lane on the command line ----

// A lane carries two names for one thing: the harness that runs it and the vendor behind
// it. `switchboard add` and `switchboard accounts` both speak in harnesses, so callers
// passed --provider claude, which matched nothing at all and fell back silently. The
// Slack bridge and Paperclip were both doing this against a machine with three healthy
// lanes configured.
function mixedPool() {
  const claudeLane = makeLane('l1', 'a1');
  const codexLane = makeLane('l2', 'a2');
  codexLane.harness = 'codex';
  codexLane.provider = 'openai';
  return [claudeLane, codexLane];
}

function healthyContext(requirements) {
  return {
    now: 1000,
    loginStates: { a1: { signedIn: true }, a2: { signedIn: true } },
    quotas: {
      a1: { windows: [{ key: 'session', usedPercent: 10 }] },
      a2: { windows: [{ key: 'session', usedPercent: 10 }] },
    },
    requirements,
  };
}

test('a lane answers to its harness name and to its vendor name', () => {
  const lane = makeLane('l1', 'a1');
  assert.ok(laneAnswersTo(lane, 'claude'), 'the harness that runs it');
  assert.ok(laneAnswersTo(lane, 'anthropic'), 'the vendor behind it');
  assert.ok(laneAnswersTo(lane, 'Anthropic'), 'case is not a filter');
  assert.ok(laneAnswersTo(lane, ''), 'asking for nothing in particular matches');
  assert.ok(laneAnswersTo(lane, null), 'and so does asking for nothing at all');
  assert.ok(!laneAnswersTo(lane, 'openai'), 'a different vendor does not match');
  assert.ok(!laneAnswersTo(lane, 'codex'), 'nor a different harness');
});

test('--provider claude selects the claude lane, which it never used to', () => {
  const selected = selectLane(mixedPool(), healthyContext({ provider: 'claude' }));
  assert.ok(selected, 'a healthy claude lane must be selectable by the name callers use');
  assert.equal(selected.lane.id, 'l1');
});

test('--provider anthropic keeps working', () => {
  const selected = selectLane(mixedPool(), healthyContext({ provider: 'anthropic' }));
  assert.equal(selected.lane.id, 'l1');
});

test('either name for the other lane picks the other lane', () => {
  assert.equal(selectLane(mixedPool(), healthyContext({ provider: 'codex' })).lane.id, 'l2');
  assert.equal(selectLane(mixedPool(), healthyContext({ provider: 'openai' })).lane.id, 'l2');
});

test('a name that belongs to nothing still selects nothing', () => {
  assert.equal(selectLane(mixedPool(), healthyContext({ provider: 'gemini' })), null);
});

test('the harness requirement is unchanged by any of this', () => {
  assert.equal(selectLane(mixedPool(), healthyContext({ harness: 'codex' })).lane.id, 'l2');
  assert.equal(selectLane(mixedPool(), healthyContext({ harness: 'claude', provider: 'openai' })), null, 'both must agree');
});

// ---- Telling the three empty answers apart ----

// These strings are a contract: callers read them to decide whether to configure lanes,
// correct the request, or wait and retry. A caller that passed a provider name no lane
// carried was told "no lane is currently available", read it as a busy machine, and fell
// back silently for a full day.
test('an unconfigured machine says so plainly', () => {
  assert.equal(selectionFailure([], []), NO_LANES_CONFIGURED);
});

test('a filter that excludes every lane is a different answer from a busy machine', () => {
  const lanes = mixedPool();
  assert.equal(selectionFailure(lanes, []), NO_LANES_MATCH);
  assert.notEqual(NO_LANES_MATCH, NO_LANE_AVAILABLE);
  assert.notEqual(NO_LANES_MATCH, NO_LANES_CONFIGURED);
});

test('lanes that matched but are all spent is the third answer', () => {
  const lanes = mixedPool();
  assert.equal(selectionFailure(lanes, lanes), NO_LANE_AVAILABLE);
});

test('an empty machine reports being empty even when a filter was given', () => {
  assert.equal(selectionFailure([], []), NO_LANES_CONFIGURED, 'the absence of lanes comes first');
});

// ---- An account whose usage could not be read is a last resort, not a dead lane ----

function poolWithUnreadable() {
  const unreadable = makeLane('l1', 'a1');
  const good = makeLane('l2', 'a2');
  return { unreadable, good, pool: [unreadable, good] };
}

function contextFor({ readable = [], unreadable = [], signedOut = [], now = 1000 } = {}) {
  const loginStates = {};
  const quotas = {};
  for (const id of readable) {
    loginStates[id] = { signedIn: true };
    quotas[id] = { windows: [{ key: 'session', usedPercent: 10 }] };
  }
  for (const id of unreadable) {
    loginStates[id] = { signedIn: true };
    quotas[id] = { error: 'fetch failed' };
  }
  for (const id of signedOut) loginStates[id] = { signedIn: false };
  return { now, loginStates, quotas };
}

test('a lane with a good reading wins, even when the unreadable one comes first', () => {
  const { pool } = poolWithUnreadable();
  const selected = selectLane(pool, contextFor({ unreadable: ['a1'], readable: ['a2'] }));
  assert.equal(selected.lane.id, 'l2', 'a known-good lane is always the first choice');
});

test('an unreadable meter is used when nothing better is left', () => {
  const { pool } = poolWithUnreadable();
  const selected = selectLane(pool, contextFor({ unreadable: ['a1'], signedOut: ['a2'] }));
  assert.equal(selected.lane.id, 'l1', 'better to try than to refuse to start');
  assert.equal(selected.status.status, 'quota-unknown', 'and the answer says why it was chosen');
});

test('the first unreadable lane is the one held back, not the last', () => {
  const pool = [makeLane('l1', 'a1'), makeLane('l2', 'a2')];
  const selected = selectLane(pool, contextFor({ unreadable: ['a1', 'a2'] }));
  assert.equal(selected.lane.id, 'l1', 'pool order still decides between equals');
});

// The fallback is only for accounts we know are signed in. An account we cannot vouch for
// at all stays unselectable: there is no evidence it would work.
test('an account whose sign-in is unknown is still never selected', () => {
  const pool = [makeLane('l1', 'a1')];
  assert.equal(selectLane(pool, { now: 1000 }), null);
});

test('a signed-out account is still never selected', () => {
  const pool = [makeLane('l1', 'a1')];
  assert.equal(selectLane(pool, contextFor({ signedOut: ['a1'] })), null);
});

test('a lane on cooldown is not resurrected by an unreadable meter', () => {
  const pool = [makeLane('l1', 'a1')];
  const ctx = { ...contextFor({ unreadable: ['a1'] }), cooldowns: { l1: 5000 } };
  assert.equal(selectLane(pool, ctx), null, 'cooldown is a deliberate hold, not a missing reading');
});

test('the filter still applies to a last-resort lane', () => {
  const pool = [makeLane('l1', 'a1')];
  const ctx = contextFor({ unreadable: ['a1'] });
  assert.ok(selectLane(pool, { ...ctx, requirements: { provider: 'claude' } }), 'matching name, so it is offered');
  assert.equal(selectLane(pool, { ...ctx, requirements: { provider: 'openai' } }), null, 'wrong name, so it is not');
});

// ---- What a reading we could not refresh still proves ----
//
// Anthropic's usage endpoint rate-limits its own callers: a probe on 2026-08-21 returned
// HTTP 429 with retry-after: 0 and no rate-limit headers at all. Switchboard then falls
// back to Claude Desktop's usage history, which records percentages and a sample time but
// never a reset time. That reading used to be discarded for being over fifteen minutes
// old, which turned "this account is plainly out of quota" into "we cannot tell", and a
// lane we cannot tell about stays in the running.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = 1_000_000_000_000;

/** The shape Claude Desktop's fallback produces: percentages, a sample time, no resets. */
function desktopReading({ session = 0, week = 0, agoMs = 0 }) {
  return {
    source: 'desktop',
    fallbackReason: 'rate-limited',
    stale: agoMs > 15 * 60 * 1000,
    sampledAt: NOW - agoMs,
    windows: [
      { key: 'session', label: 'Session (5h)', usedPercent: session, resetsAt: null },
      { key: 'week', label: 'Week (all models)', usedPercent: week, resetsAt: null },
    ],
  };
}

function statusWith(snapshot) {
  return laneStatus(makeLane('l1', 'a1'), {
    now: NOW,
    loginStates: { a1: { signedIn: true } },
    quotas: { a1: snapshot },
  });
}

test('an old reading that says the account is out still says it is out', () => {
  // The exact state on this machine: week 100%, sampled 153 minutes ago, no reset time.
  const stat = statusWith(desktopReading({ week: 100, agoMs: 153 * 60 * 1000 }));
  assert.equal(stat.status, 'exhausted', 'a weekly window cannot have refilled in two and a half hours');
});

test('a weekly reading stops being evidence once the window itself could have turned over', () => {
  const stat = statusWith(desktopReading({ week: 100, agoMs: 8 * DAY }));
  assert.equal(stat.status, 'quota-unknown', 'past a week we can no longer say');
  assert.notEqual(stat.status, 'exhausted', 'and must not park the account forever');
});

test('a session reading is trusted for hours, not days', () => {
  assert.equal(statusWith(desktopReading({ session: 100, agoMs: 2 * HOUR })).status, 'exhausted');
  assert.equal(statusWith(desktopReading({ session: 100, agoMs: 6 * HOUR })).status, 'quota-unknown');
});

// Dropped deliberately: an old reading may rule an account out, never rule it in. It
// describes a moment that every run since has moved on from.
test('an old reading that says there is room counts for nothing', () => {
  const stat = statusWith(desktopReading({ session: 10, week: 20, agoMs: 40 * 60 * 1000 }));
  assert.equal(stat.status, 'quota-unknown', 'usable as a last resort, never presented as healthy');
  assert.notEqual(stat.status, 'available');
});

test('a current reading that says there is room is still just available', () => {
  const stat = statusWith(desktopReading({ session: 10, week: 20, agoMs: 60 * 1000 }));
  assert.equal(stat.status, 'available');
});

test('the clock is when the reading was taken, not when we read the file', () => {
  const old = desktopReading({ week: 100, agoMs: 6 * DAY });
  assert.equal(statusWith(old).status, 'exhausted', 'six days is inside a weekly window');
  const undated = { ...old, sampledAt: undefined };
  assert.equal(statusWith(undated).status, 'exhausted', 'a reading with no sample time was just fetched');
});

test('a limit whose reset time has passed no longer rules the account out', () => {
  const stat = statusWith({
    windows: [
      { key: 'session', usedPercent: 100, resetsAt: NOW - HOUR },
      { key: 'week', usedPercent: 3, resetsAt: NOW + DAY },
    ],
  });
  assert.equal(stat.status, 'quota-unknown', 'the window turned over, so what has been used since is unknown');
  assert.notEqual(stat.status, 'available', 'and we cannot claim room we did not observe');
});

test('a limit with a reset time still ahead rules it out at any age', () => {
  const stat = statusWith({
    stale: true,
    sampledAt: NOW - 30 * DAY,
    windows: [{ key: 'week', usedPercent: 100, resetsAt: NOW + 2 * DAY }],
  });
  assert.equal(stat.status, 'exhausted', 'the vendor said when it comes back, so age is irrelevant');
  assert.equal(stat.resetsAt, NOW + 2 * DAY, 'and that time is passed on');
});

// Anthropic bills overage credits separately from the usage windows, and documents that a
// per-model limit leaves other models working. Counting either as "out of quota" would
// park an account whose weekly usage is a couple of percent.
test('a full overage credit meter does not put an account out of quota', () => {
  const stat = statusWith({
    windows: [
      { key: 'session', usedPercent: 0, resetsAt: NOW + HOUR },
      { key: 'week', usedPercent: 2, resetsAt: NOW + DAY },
      { key: 'extra', label: 'Extra usage', usedPercent: 100, resetsAt: null },
    ],
  });
  assert.equal(stat.status, 'available');
});

test('a full per-model limit does not put an account out of quota', () => {
  const stat = statusWith({
    windows: [
      { key: 'session', usedPercent: 5, resetsAt: NOW + HOUR },
      { key: 'week', usedPercent: 30, resetsAt: NOW + DAY },
      { key: 'week_opus', usedPercent: 100, resetsAt: NOW + 2 * DAY },
      { key: 'week_fable', usedPercent: 100, resetsAt: null },
    ],
  });
  assert.equal(stat.status, 'available', 'one model being capped is not the account being out');
});

test('an error with no reading at all is still just unknown', () => {
  assert.equal(statusWith({ error: 'rate-limited' }).status, 'quota-unknown');
  assert.equal(statusWith(undefined).status, 'quota-unknown');
});

// ---- The evidence function on its own ----

test('spentEvidence names which of the four cases it is in', () => {
  assert.equal(spentEvidence(desktopReading({ week: 100, agoMs: HOUR }), NOW).state, 'spent');
  assert.equal(spentEvidence(desktopReading({ week: 100, agoMs: 8 * DAY }), NOW).state, 'expired');
  assert.equal(spentEvidence(desktopReading({ week: 4, agoMs: HOUR }), NOW).state, 'clear');
  assert.equal(spentEvidence({ error: 'rate-limited' }, NOW).state, 'none');
  assert.equal(spentEvidence(undefined, NOW).state, 'none');
});

test('the window lengths are the published ones, not invented', () => {
  assert.equal(WINDOW_LIFETIME_MS.session, 5 * HOUR, 'Anthropic publishes a five-hour session window');
  assert.equal(WINDOW_LIFETIME_MS.week, 7 * DAY, 'and a seven-day weekly window');
});

// ---- What it does to lane selection ----

test('a lane held out by an old reading is not selected while a healthy one exists', () => {
  const outOfQuota = makeLane('l1', 'a1');
  const healthy = makeLane('l2', 'a2');
  const selected = selectLane([outOfQuota, healthy], {
    now: NOW,
    loginStates: { a1: { signedIn: true }, a2: { signedIn: true } },
    quotas: {
      a1: desktopReading({ week: 100, agoMs: 153 * 60 * 1000 }),
      a2: { windows: [{ key: 'session', usedPercent: 12, resetsAt: NOW + HOUR }, { key: 'week', usedPercent: 3, resetsAt: NOW + 7 * DAY }] },
    },
  });
  assert.equal(selected.lane.id, 'l2');
});

// Before this rule the reading was discarded, the lane read as merely unreadable, and the
// last-resort slot then handed the run to an account with nothing left for days.
test('a lane held out by an old reading is not selected even when it is the only one', () => {
  const selected = selectLane([makeLane('l1', 'a1')], {
    now: NOW,
    loginStates: { a1: { signedIn: true } },
    quotas: { a1: desktopReading({ week: 100, agoMs: 153 * 60 * 1000 }) },
  });
  assert.equal(selected, null, 'better to say there is no lane than to burn a run proving it');
});

// ---- Changing the machine default is a higher bar than picking a lane for one run ----
//
// `setActive` writes CLAUDE_CONFIG_DIR at user scope, so a switch redirects every terminal
// opened afterwards and every agent spawned on this machine, and it persists. A run that
// picks the wrong lane costs one failure and moves on.
test('a last-resort lane may take a run but may not take over the machine default', () => {
  const lastResort = {
    lane: makeLane('l1', 'a1'),
    status: { status: 'quota-unknown', reason: 'Signed in, but its usage could not be read' },
  };
  assert.equal(worthSwitchingTo(lastResort), false);
});

test('a lane with a reading behind it may take over the default', () => {
  const solid = { lane: makeLane('l1', 'a1'), status: { status: 'available', reason: 'Subscription has capacity' } };
  assert.equal(worthSwitchingTo(solid), true);
});

test('no selection at all never switches anything', () => {
  assert.equal(worthSwitchingTo(null), false);
  assert.equal(worthSwitchingTo(undefined), false);
  assert.equal(worthSwitchingTo({ lane: makeLane('l1', 'a1') }), false, 'a result with no status is not a vouched one');
});

// Headroom: how full a window may get before an account stops being somewhere to send new
// work. A different question from `spentEvidence`, which answers whether it works at all.

const usage = (session, week) => ({
  windows: [
    { key: 'session', label: 'Session (5h)', usedPercent: session, resetsAt: null },
    { key: 'week', label: 'Week (all models)', usedPercent: week, resetsAt: null },
  ],
});

test('headroom needs room on every gating window, and the five-hour one counts', () => {
  assert.equal(hasHeadroom(usage(5, 10)), true);
  assert.equal(hasHeadroom(usage(90, 10)), false);   // idle for the week, five-hour nearly gone
  assert.equal(hasHeadroom(usage(5, 95)), false);
  assert.equal(hasHeadroom(usage(86, 91)), true);    // just clear on both windows
});

test('an unreadable or stale account never counts as having room', () => {
  assert.equal(hasHeadroom({ error: 'auth' }), false);
  assert.equal(hasHeadroom({ ...usage(5, 10), stale: true }), false);
  assert.equal(hasHeadroom(undefined), false);
  assert.equal(hasHeadroom({ windows: [{ key: 'extra', label: 'Extra usage', usedPercent: 0 }] }), false);
});

// The dead band. Giving the default up and winning it back are asked different questions,
// so a reading that wobbles either side of one mark cannot move the default back and
// forth: an account lets go at 90/95 and only takes it back once it reads under 87/92.

test('the account holding the default keeps it on a reading that would not win it back', () => {
  assert.equal(hasHeadroom(usage(89, 94), { holdsDefault: true }), true);
  assert.equal(hasHeadroom(usage(89, 94)), false, 'the same reading is not enough to take the default off anyone');
});

test('a reading inside the band moves nothing, in either direction', () => {
  for (const session of [87, 88, 89]) {
    assert.equal(hasHeadroom(usage(session, 10), { holdsDefault: true }), true, `keeps the default at ${session}%`);
    assert.equal(hasHeadroom(usage(session, 10)), false, `cannot take the default at ${session}%`);
  }
});

test('an account that has dropped clear of the band is somewhere to send the default again', () => {
  assert.equal(hasHeadroom(usage(86, 10)), true);
  assert.equal(hasHeadroom(usage(10, 91)), true);
});

test('the band has the same shape on the weekly window', () => {
  assert.equal(hasHeadroom(usage(10, 93), { holdsDefault: true }), true);
  assert.equal(hasHeadroom(usage(10, 93)), false);
  assert.equal(hasHeadroom(usage(10, 95), { holdsDefault: true }), false, 'holding it does not survive the leave mark');
});

test('holding the default does not make an unreadable account readable', () => {
  assert.equal(hasHeadroom({ error: 'auth' }, { holdsDefault: true }), false);
  assert.equal(hasHeadroom({ ...usage(5, 10), stale: true }, { holdsDefault: true }), false);
});

test('running out is the same line read from the other side, and says nothing about the unreadable', () => {
  assert.equal(isRunningOut(usage(90, 10)), true);
  assert.equal(isRunningOut(usage(5, 10)), false);
  assert.equal(isRunningOut({ error: 'auth' }), null);
  assert.equal(isRunningOut({ ...usage(100, 100), stale: true }), null);
});

test('the mark for leaving did not move when the one for coming back was added', () => {
  assert.equal(isRunningOut(usage(90, 10)), true);
  assert.equal(isRunningOut(usage(89, 10)), false, 'the band is about coming back, not about leaving');
  assert.equal(isRunningOut(usage(10, 95)), true);
  assert.equal(isRunningOut(usage(10, 94)), false);
});

test('the fullest window is what ranking compares', () => {
  assert.equal(tightestWindow(usage(88, 10)), 88);
  assert.equal(tightestWindow(usage(5, 40)), 40);
  assert.equal(tightestWindow({ error: 'auth' }), null);
});

test('running low is not the same as being out: a lane at 95% is still usable for a run', () => {
  assert.equal(spentEvidence(usage(95, 20), NOW).state, 'clear');
  assert.equal(isRunningOut(usage(95, 20)), true);
});

// ---- Quota about to be forfeited at the weekly turnover ----

const expiringUsage = (session, week, weekReset) => ({
  windows: [
    { key: 'session', label: 'Session (5h)', usedPercent: session, resetsAt: null },
    { key: 'week', label: 'Week (all models)', usedPercent: week, resetsAt: weekReset },
  ],
});

test('a week ending within the horizon with room to spare is about to forfeit quota', () => {
  assert.equal(expiringWeek(expiringUsage(12, 67, NOW + 6 * HOUR), NOW), NOW + 6 * HOUR);
  assert.equal(expiringWeek(expiringUsage(12, 67, NOW + SPEND_DOWN_HORIZON_MS), NOW), NOW + SPEND_DOWN_HORIZON_MS, 'the boundary is inclusive');
});

test('a week ending beyond the horizon is not about to forfeit anything', () => {
  assert.equal(expiringWeek(expiringUsage(12, 67, NOW + SPEND_DOWN_HORIZON_MS + 1), NOW), null);
});

test('a turnover in the past describes a week that already ended', () => {
  assert.equal(expiringWeek(expiringUsage(12, 67, NOW - 1000), NOW), null);
  assert.equal(expiringWeek(expiringUsage(12, 67, NOW), NOW), null);
});

test('no headroom means nothing left to spend, whichever window is the tight one', () => {
  assert.equal(expiringWeek(expiringUsage(95, 67, NOW + 6 * HOUR), NOW), null, 'the five-hour window is full');
  assert.equal(expiringWeek(expiringUsage(12, 96, NOW + 6 * HOUR), NOW), null, 'the week itself is full');
});

// The account already parked here by an earlier spend-down has to keep counting as
// expiring while it sits in the band, or the default would leave mid-window for a lane
// further up the order and the detour would undo itself early.
test('an expiring account holding the default is judged on keeping it, not on winning it', () => {
  const parked = expiringUsage(89, 67, NOW + 6 * HOUR);
  assert.equal(expiringWeek(parked, NOW, { holdsDefault: true }), NOW + 6 * HOUR);
  assert.equal(expiringWeek(parked, NOW), null, 'the same reading is not enough to send the default somewhere new');
});

test('unused quota cannot be claimed about a meter that was not read', () => {
  assert.equal(expiringWeek({ windows: [
    { key: 'session', label: 'Session (5h)', usedPercent: 12, resetsAt: null },
    { key: 'week', label: 'Week (all models)', usedPercent: null, resetsAt: NOW + 6 * HOUR },
  ] }, NOW), null);
  assert.equal(expiringWeek(usage(12, 67), NOW), null, 'no turnover time, no claim');
  assert.equal(expiringWeek({ error: 'auth' }, NOW), null);
  assert.equal(expiringWeek({ ...expiringUsage(12, 67, NOW + 6 * HOUR), stale: true }, NOW), null);
  assert.equal(expiringWeek(undefined, NOW), null);
});
