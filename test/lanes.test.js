import test from 'node:test';
import assert from 'node:assert/strict';
import { laneStatus, selectLane, selectLaneAsNeeded, narrowPool, lanesCallerCannotDrive, laneAnswersTo, selectionFailure, worthSwitchingTo, defaultFollowsLanes, followsLanesNote, switchedAgainstLanesNote, ordersBySoonestReset, ranksByReset, soonestResetOrder, accountUseOrder, NO_LANES_CONFIGURED, NO_LANES_MATCH, NO_LANE_AVAILABLE } from '../core/lanes.js';
import { expiringWeek, hasHeadroom, isRunningOut, spentEvidence, tightestWindow, weekTurnover, SPEND_DOWN_HORIZON_MS, WINDOW_LIFETIME_MS } from '../core/lanes-util.js';

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

// ---- Lanes in any order, whatever each caller can drive ----

// The order belongs to whoever owns the machine. This was found the day a Copilot lane was
// added beneath Codex: a Slack bot that drives Claude and Codex only had been told to insist
// on a particular order, because a lane it could not drive sitting above one it could meant
// the usable lane was never offered.
function ownersPool() {
  const copilot = makeLane('l-copilot', 'a3');
  copilot.harness = 'copilot';
  copilot.provider = 'github';
  const [claudeLane, codexLane] = mixedPool();
  return [copilot, claudeLane, codexLane];
}

function ownersContext(overrides = {}) {
  const context = healthyContext({});
  context.loginStates.a3 = { signedIn: true };
  context.quotas.a3 = { windows: [{ key: 'session', usedPercent: 10 }] };
  return { ...context, ...overrides };
}

test('a lane the caller cannot drive is passed over wherever the owner put it', () => {
  const pool = narrowPool(ownersPool(), { harnesses: ['claude', 'codex'] });

  assert.deepEqual(pool.map((l) => l.id), ['l1', 'l2'], 'the owner order of what is left is kept');
  assert.equal(selectLane(pool, ownersContext()).lane.id, 'l1');
});

test('the lane below an undrivable one is reached when the first choice is spent', () => {
  const spentClaude = ownersContext();
  spentClaude.quotas.a1 = { windows: [{ key: 'session', usedPercent: 100, resetsAt: 5000 }] };

  // Copilot sits between nothing and Codex here only by being first in the owner's list;
  // moving it between the two must make no difference either.
  const pool = ownersPool();
  const reordered = [pool[1], pool[0], pool[2]];
  for (const lanes of [pool, reordered]) {
    const selected = selectLane(narrowPool(lanes, { harnesses: ['claude', 'codex'] }), spentClaude);
    assert.equal(selected.lane.id, 'l2', 'Codex takes the work, not the Copilot lane above it');
  }
});

test('a caller that can drive anything keeps every lane', () => {
  assert.equal(narrowPool(ownersPool(), {}).length, 3);
  assert.equal(narrowPool(ownersPool(), { harnesses: null }).length, 3);
  assert.equal(narrowPool(ownersPool()).length, 3);
});

test('tools are matched whatever case the caller wrote them in', () => {
  assert.deepEqual(narrowPool(ownersPool(), { harnesses: ['CoPilot'] }).map((l) => l.id), ['l-copilot']);
});

test('a caller that can drive none of the lanes gets the "nothing matched" answer', () => {
  const lanes = ownersPool();
  const pool = narrowPool(lanes, { harnesses: ['gemini'] });

  assert.deepEqual(pool, []);
  assert.equal(selectionFailure(lanes, pool), NO_LANES_MATCH, 'not "busy": waiting will never fix it');
  assert.deepEqual(narrowPool(lanes, { harnesses: [] }), [], 'and an empty list is not "anything"');
});

test('the account and provider filters still apply alongside the tools', () => {
  const lanes = ownersPool();

  assert.deepEqual(narrowPool(lanes, { provider: 'openai', harnesses: ['claude', 'codex'] }).map((l) => l.id), ['l2']);
  assert.deepEqual(narrowPool(lanes, { account: 'a1', harnesses: ['claude', 'codex'] }).map((l) => l.id), ['l1']);
  assert.deepEqual(narrowPool(lanes, { account: 'a3', harnesses: ['claude', 'codex'] }), []);
});

test('only lanes left out for their tool are reported as left out', () => {
  const lanes = ownersPool();

  assert.deepEqual(lanesCallerCannotDrive(lanes, { harnesses: ['claude', 'codex'] }).map((l) => l.id), ['l-copilot']);
  assert.deepEqual(lanesCallerCannotDrive(lanes, {}), [], 'no restriction, nothing left out');
  // A lane the caller ruled out by name was never in the running, so it is not news.
  assert.deepEqual(lanesCallerCannotDrive(lanes, { provider: 'anthropic', harnesses: ['claude'] }), []);
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

// ---- Reading accounts only as far as the answer needs ----
//
// Reading an account is the slow part of choosing a lane: an old reading means asking the
// vendor, and Antigravity's means starting its CLI twice. The Slack bridge allows dry-run
// eight seconds and was running past it on readings for lanes it would never have picked.

/** A reader over fixed facts that notes which accounts it was asked about. */
function recordingReader(facts) {
  const asked = [];
  const read = async (accountId) => {
    asked.push(accountId);
    return facts[accountId] ?? {};
  };
  return { read, asked };
}

const ROOM = { login: { signedIn: true }, quota: { windows: [{ key: 'session', usedPercent: 10 }] } };
const SPENT = { login: { signedIn: true }, quota: { windows: [{ key: 'session', usedPercent: 100, resetsAt: 5000 }] } };
const UNREADABLE = { login: { signedIn: true }, quota: { error: 'fetch failed' } };
const SIGNED_OUT = { login: { signedIn: false } };

test('the walk stops at the first lane with room, so the accounts below it are never read', async () => {
  const { read, asked } = recordingReader({ a1: ROOM, a2: ROOM, a3: ROOM });
  const pool = [makeLane('l1', 'a1'), makeLane('l2', 'a2'), makeLane('l3', 'a3')];
  const selected = await selectLaneAsNeeded(pool, { now: 1000 }, read);
  assert.equal(selected.lane.id, 'l1');
  assert.deepEqual(asked, ['a1'], 'nothing below the answer was read');
});

test('a lane further down is read when the ones above it have no room', async () => {
  const { read, asked } = recordingReader({ a1: SPENT, a2: ROOM, a3: ROOM });
  const pool = [makeLane('l1', 'a1'), makeLane('l2', 'a2'), makeLane('l3', 'a3')];
  const selected = await selectLaneAsNeeded(pool, { now: 1000 }, read);
  assert.equal(selected.lane.id, 'l2');
  assert.deepEqual(asked, ['a1', 'a2']);
});

test('with no lane that has room every account is read, and the first unreadable one is the last resort', async () => {
  const { read, asked } = recordingReader({ a1: SIGNED_OUT, a2: UNREADABLE, a3: UNREADABLE });
  const pool = [makeLane('l1', 'a1'), makeLane('l2', 'a2'), makeLane('l3', 'a3')];
  const selected = await selectLaneAsNeeded(pool, { now: 1000 }, read);
  assert.equal(selected.lane.id, 'l2');
  assert.equal(selected.status.status, 'quota-unknown');
  assert.deepEqual(asked, ['a1', 'a2', 'a3'], 'a lane with room further down would have beaten it');
});

test('an unreadable lane above a lane with room still loses to it when read as needed', async () => {
  const { read } = recordingReader({ a1: UNREADABLE, a2: ROOM });
  const selected = await selectLaneAsNeeded([makeLane('l1', 'a1'), makeLane('l2', 'a2')], { now: 1000 }, read);
  assert.equal(selected.lane.id, 'l2');
});

test('an account with two lanes is read once', async () => {
  const { read, asked } = recordingReader({ a1: ROOM });
  const pool = [makeLane('l1', 'a1'), makeLane('l2', 'a1')];
  const selected = await selectLaneAsNeeded(pool, { now: 1000, cooldowns: { l1: 5000 } }, read);
  assert.equal(selected.lane.id, 'l2');
  assert.deepEqual(asked, ['a1']);
});

test('a lower lane on an account already read does not jump ahead of a lane not read yet', async () => {
  // l3 shares a1 with l1, so reading a1 for l1 makes l3 look ready before l2 has been read.
  const { read } = recordingReader({ a1: ROOM, a2: ROOM });
  const pool = [makeLane('l1', 'a1'), makeLane('l2', 'a2'), makeLane('l3', 'a1')];
  const selected = await selectLaneAsNeeded(pool, { now: 1000, cooldowns: { l1: 5000 } }, read);
  assert.equal(selected.lane.id, 'l2', 'pool order decides, as it does when everything is read first');
});

test('a lane the requirements rule out is never read', async () => {
  const { read, asked } = recordingReader({ a1: ROOM, a2: ROOM });
  const codex = { ...makeLane('l2', 'a2'), harness: 'codex', provider: 'openai' };
  const selected = await selectLaneAsNeeded([makeLane('l1', 'a1'), codex], { now: 1000, requirements: { provider: 'openai' } }, read);
  assert.equal(selected.lane.id, 'l2');
  assert.deepEqual(asked, ['a2']);
});

test('reading as needed always gives the answer that reading everything first gives', async () => {
  // Every way three accounts can stand, with a fourth lane sharing the first account and
  // with and without a cooldown on the first lane, against selectLane given everything.
  const states = { ROOM, SPENT, UNREADABLE, SIGNED_OUT, MISSING: {} };
  const names = Object.keys(states);
  const pool = [makeLane('l1', 'a1'), makeLane('l2', 'a2'), makeLane('l3', 'a3'), makeLane('l4', 'a1')];
  for (const s1 of names) for (const s2 of names) for (const s3 of names) for (const cooled of [false, true]) {
    const facts = { a1: states[s1], a2: states[s2], a3: states[s3] };
    const context = { now: 1000, cooldowns: cooled ? { l1: 5000 } : {} };
    const everything = { ...context, loginStates: {}, quotas: {} };
    for (const [id, f] of Object.entries(facts)) {
      if (f.login !== undefined) everything.loginStates[id] = f.login;
      if (f.quota !== undefined) everything.quotas[id] = f.quota;
    }
    const expected = selectLane(pool, everything);
    const actual = await selectLaneAsNeeded(pool, context, recordingReader(facts).read);
    const label = `${s1}/${s2}/${s3}${cooled ? ' with l1 cooling down' : ''}`;
    assert.equal(actual?.lane.id ?? null, expected?.lane.id ?? null, label);
    assert.equal(actual?.status.status ?? null, expected?.status.status ?? null, label);
  }
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

// ---- When the default belongs to the lane order ----
//
// On 2026-09-14 "Switch to this" was clicked on a second Claude account while the watch was
// set to switch automatically and both accounts were lanes. The switch worked, and a few
// minutes later the watch put the default back on the first lane, as it is meant to. The
// button was the thing that was wrong: it offered a choice the app was about to undo.

test('the default follows the lanes only with the watch switching automatically', () => {
  const lanes = [makeLane('l1', 'a1'), makeLane('l2', 'a2')];
  assert.equal(defaultFollowsLanes({ quotaWatch: 'auto', lanes }, 'claude'), true);
  assert.equal(defaultFollowsLanes({ quotaWatch: 'notify', lanes }, 'claude'), false, 'telling you moves nothing');
  assert.equal(defaultFollowsLanes({ quotaWatch: 'off', lanes }, 'claude'), false);
});

test('the default follows the lanes only for a tool that has some', () => {
  const codexOnly = [{ ...makeLane('l1', 'c1'), harness: 'codex', provider: 'openai' }];
  assert.equal(defaultFollowsLanes({ quotaWatch: 'auto', lanes: codexOnly }, 'claude'), false, 'Claude has no order to follow');
  assert.equal(defaultFollowsLanes({ quotaWatch: 'auto', lanes: codexOnly }, 'codex'), true);
  assert.equal(defaultFollowsLanes({ quotaWatch: 'auto', lanes: [] }, 'claude'), false);
  assert.equal(defaultFollowsLanes({ quotaWatch: 'auto' }, 'claude'), false, 'settings with no lanes key at all');
  assert.equal(defaultFollowsLanes(null, 'claude'), false);
});

// Built from code points so this file keeps to the no-dash rule it is checking.
const DASHES = new RegExp(`[${String.fromCharCode(0x2013)}${String.fromCharCode(0x2014)}]`);

test('where the switch is withheld, the words say how to choose by hand', () => {
  const ranked = followsLanesNote('Claude Code');
  assert.match(ranked, /new Claude Code sessions use the first ready account in your lanes, taking subscription accounts soonest weekly reset first/);
  assert.match(ranked, /lane order decides everything else/, 'says what the lane order still does');
  assert.doesNotMatch(ranked, /Reorder the lanes to change which account/, 'reordering no longer picks between subscriptions, so it is not offered as the way to');
  const asSet = followsLanesNote('Codex', false);
  assert.match(asSet, /^New Codex sessions follow your lane order/, 'a tool with nothing to rank keeps the words it always had');
  assert.match(asSet, /Reorder the lanes/);
  for (const note of [ranked, asSet]) {
    assert.match(note, /"Tell me" or "Do nothing"/, 'names the tray settings that give the choice back');
    assert.doesNotMatch(note, DASHES, 'no dashes in user-facing words');
  }
});

test('a switch made from a terminal anyway says what a running watch will do', () => {
  const ranked = switchedAgainstLanesNote('Claude Code');
  const asSet = switchedAgainstLanesNote('Codex', false);
  for (const note of [ranked, asSet]) {
    assert.match(note, /if the tray app or "switchboard watch" is running/, 'it cannot know that a watch is running, so it does not claim one');
    assert.doesNotMatch(note, DASHES);
  }
  assert.match(ranked, /taking subscription accounts soonest weekly reset first/);
  assert.match(asSet, /first ready account in your lane order/);
});

// Found in review: Gemini CLI and Qwen Code report no usage, so the watch leaves their
// default where it is, yet the words told the user to reorder the lanes to change it and
// warned that a running watch would move a terminal switch back.
test('a tool with no usage reading is not told the lane order moves its default', () => {
  const page = followsLanesNote('Gemini CLI', false, false);
  const terminal = switchedAgainstLanesNote('Gemini CLI', false, false);
  for (const note of [page, terminal]) {
    assert.match(note, /reads no usage for Gemini CLI/);
    assert.doesNotMatch(note, /Reorder the lanes|lane order|back to/, 'reordering changes nothing for it, and nothing moves it back');
    assert.doesNotMatch(note, DASHES);
  }
  assert.match(page, /"Tell me" or "Do nothing"/, 'still names the way to choose by hand');
  assert.match(terminal, /never moves new Gemini CLI sessions between subscription accounts/);
});

test('only a tool with readable usage and more than one subscription account is ranked by reset', () => {
  const lane = (id, harness, accountId, billing = 'subscription') => ({ ...makeLane(id, accountId, billing), harness });
  const auto = (lanes) => ({ quotaWatch: 'auto', lanes });
  assert.equal(ranksByReset(auto([lane('1', 'claude', 'a'), lane('2', 'claude', 'b')]), 'claude'), true);
  assert.equal(ranksByReset({ quotaWatch: 'notify', lanes: [lane('1', 'claude', 'a'), lane('2', 'claude', 'b')] }, 'claude'), false, 'only on "Switch automatically"');
  assert.equal(ranksByReset(auto([lane('1', 'claude', 'a'), lane('2', 'claude', 'a')]), 'claude'), false, 'one account has nothing to rank against');
  assert.equal(ranksByReset(auto([lane('1', 'claude', 'a'), lane('2', 'claude', 'b', 'metered')]), 'claude'), false, 'a metered lane is never ranked');
  assert.equal(ranksByReset(auto([lane('1', 'gemini', 'g1'), lane('2', 'gemini', 'g2')]), 'gemini'), false, 'Gemini CLI has no usage reading to rank on');
  assert.equal(defaultFollowsLanes(auto([lane('1', 'gemini', 'g1'), lane('2', 'gemini', 'g2')]), 'gemini'), true, 'its default still follows its lanes, as it always did');
});

// ---- Soonest weekly reset first ----
//
// On 2026-10-26 the watch had moved the default onto the account whose week ended that
// afternoon, and left the other two in lane order: the one resetting the following Monday
// ahead of the one resetting Thursday. Weekly quota is lost at the turnover, so on "Switch
// automatically" every account of a tool is now ranked by it, not only one on its last day.

const weekEnding = (resetsAt, used = 20) => ({
  windows: [
    { key: 'session', usedPercent: 5, resetsAt: NOW + 3 * HOUR },
    { key: 'week', usedPercent: used, resetsAt },
  ],
});

/** What the ranking reads: these readings, every account in them signed in, plus `extra`. */
const ranking = (quotas, extra = {}) => ({
  now: NOW,
  quotas,
  loginStates: Object.fromEntries(Object.keys(quotas).map((id) => [id, { signedIn: true }])),
  ...extra,
});
const ids = (lanes) => lanes.map((l) => l.id);
const codexLane = (id, accountId, billing = 'subscription') => ({ ...makeLane(id, accountId, billing), harness: 'codex', provider: 'openai' });

test('only "Switch automatically" ranks by reset; a person choosing keeps the order they set', () => {
  assert.equal(ordersBySoonestReset({ quotaWatch: 'auto' }), true);
  assert.equal(ordersBySoonestReset({ quotaWatch: 'notify' }), false);
  assert.equal(ordersBySoonestReset({ quotaWatch: 'off' }), false);
  assert.equal(ordersBySoonestReset({}), false);
  assert.equal(ordersBySoonestReset(null), false);
});

test('accounts of one tool are taken soonest weekly reset first, however far off the reset is', () => {
  // Lane order as set on the machine where this was asked for, with the readings of the day.
  const lanes = [makeLane('l-main', 'main'), makeLane('l-second', 'second'), makeLane('l-third', 'third')];
  const quotas = {
    main: weekEnding(NOW + 6 * DAY, 6),
    second: weekEnding(NOW + 2 * HOUR, 84),
    third: weekEnding(NOW + 3 * DAY, 42),
  };
  assert.deepEqual(ids(soonestResetOrder(lanes, ranking(quotas))), ['l-second', 'l-third', 'l-main']);
});

test('each tool keeps the places its lanes were given, so the order still says which tool comes first', () => {
  const lanes = [makeLane('c1', 'a'), codexLane('x1', 'x'), makeLane('c2', 'b'), codexLane('x2', 'y')];
  const quotas = {
    a: weekEnding(NOW + 5 * DAY), b: weekEnding(NOW + 1 * DAY),
    x: weekEnding(NOW + 4 * DAY), y: weekEnding(NOW + 2 * DAY),
  };
  assert.deepEqual(ids(soonestResetOrder(lanes, ranking(quotas))), ['c2', 'x2', 'c1', 'x1'],
    'Claude still in the first and third places and Codex in the second and fourth, each soonest first');
});

test('a metered lane never moves, because pay-per-use quota does not expire', () => {
  const lanes = [makeLane('l1', 'a'), makeLane('m', 'm', 'metered'), makeLane('l2', 'b')];
  const quotas = { a: weekEnding(NOW + 5 * DAY), m: weekEnding(NOW + 1000), b: weekEnding(NOW + 1 * DAY) };
  assert.deepEqual(ids(soonestResetOrder(lanes, ranking(quotas))), ['l2', 'm', 'l1']);
});

test('an account whose usage cannot be read follows the rest, and a week under way with no stated reset follows the stated ones', () => {
  const lanes = [makeLane('l1', 'unread'), makeLane('l2', 'stale'), makeLane('l3', 'known'), makeLane('l4', 'none')];
  const quotas = {
    unread: { error: 'fetch failed' },
    stale: { ...weekEnding(NOW + 1000), stale: true },
    known: weekEnding(NOW + 6 * DAY),
    // A reading with a week but no stated turnover, as a fallback reading can be.
    none: { windows: [{ key: 'session', usedPercent: 5 }, { key: 'week', usedPercent: 5, resetsAt: null }] },
  };
  assert.deepEqual(ids(soonestResetOrder(lanes, ranking(quotas))), ['l3', 'l4', 'l1', 'l2']);
});

test('an account that has hit a limit waits behind every account that can still run', () => {
  const lanes = [makeLane('l1', 'a'), makeLane('l2', 'spent')];
  const quotas = { a: weekEnding(NOW + 5 * DAY), spent: weekEnding(NOW + 1 * DAY, 100) };
  assert.deepEqual(ids(soonestResetOrder(lanes, ranking(quotas))), ['l1', 'l2']);
});

// Found in review: a signed-out account still has a usage reading (a session log, or a
// Claude Desktop sample with the reset carried over), so ranked on that alone it took its
// tool's first place, was skipped there, and work went to the metered lane in the next
// place while an account of the same tool had room.
test('an account that cannot take work never takes its tool\'s first place, whatever its reading says', () => {
  const lanes = [codexLane('x', 'x'), codexLane('m', 'm', 'metered'), codexLane('y', 'y')];
  const quotas = { x: weekEnding(NOW + 5 * DAY), m: weekEnding(NOW + DAY), y: weekEnding(NOW + DAY) };
  for (const [why, extra] of [
    ['signed out', { loginStates: { x: { signedIn: true }, m: { signedIn: true }, y: { signedIn: false } } }],
    ['sign-in unreadable', { loginStates: { x: { signedIn: true }, m: { signedIn: true } } }],
    ['on cooldown', { cooldowns: { y: NOW + HOUR } }],
  ]) {
    const order = soonestResetOrder(lanes, ranking(quotas, extra));
    assert.deepEqual(ids(order), ['x', 'm', 'y'], why);
    assert.equal(selectLane(order, { ...ranking(quotas, extra), spendPolicies: { m: { budget: 20 } } }).lane.id, 'x',
      `${why}: the subscription with room is used, not the metered lane`);
  }
});

test('the same holds across tools: a tool that cannot run does not hand its place to another', () => {
  const lanes = [codexLane('x', 'x'), makeLane('a', 'a'), codexLane('y', 'y')];
  const quotas = { x: weekEnding(NOW + 5 * DAY), a: weekEnding(NOW + 2 * DAY), y: weekEnding(NOW + DAY) };
  const context = ranking(quotas, { loginStates: { x: { signedIn: true }, a: { signedIn: true }, y: { signedIn: false } } });
  assert.equal(selectLane(soonestResetOrder(lanes, context), context).lane.id, 'x', 'Codex comes first in the order set, and has an account that can run');
});

test('a stricter test of who may be ranked leaves the places ahead of a metered lane to those who pass it', () => {
  const lanes = [makeLane('l1', 'a'), makeLane('m', 'm', 'metered'), makeLane('l2', 'b')];
  const quotas = { a: weekEnding(NOW + 5 * DAY), b: weekEnding(NOW + DAY) };
  assert.deepEqual(ids(soonestResetOrder(lanes, ranking(quotas), { canRank: (l) => l.accountId === 'a' })), ['l1', 'm', 'l2'],
    'b may not be ranked, so a keeps the first place rather than handing it, and the metered lane after it, the lead');
});

// A week that has not started (nothing used, no turnover stated) or has turned over since
// the reading was taken is a whole week from its next turnover, later than any week under
// way. Read as "unknown", the account whose week had only just begun was held on to.
test('a week that has just begun ranks after every week already under way', () => {
  const lanes = [makeLane('l1', 'fresh'), makeLane('l2', 'passed'), makeLane('l3', 'late')];
  const quotas = {
    fresh: { windows: [{ key: 'session', usedPercent: 0 }, { key: 'week', usedPercent: 0, resetsAt: null }] },
    passed: weekEnding(NOW - HOUR, 84),
    late: weekEnding(NOW + 6 * DAY),
  };
  assert.deepEqual(ids(soonestResetOrder(lanes, ranking(quotas))), ['l3', 'l1', 'l2'], 'and two of them settle by lane order');
});

test('resets a few milliseconds apart are the same reset, and the order set decides between them', () => {
  // Two readings of one turnover, as the vendor states it: the last digits differ.
  const hour = Math.round(NOW / HOUR) * HOUR + 6 * DAY;
  const lanes = [makeLane('l1', 'a'), makeLane('l2', 'b')];
  for (const [ra, rb] of [[hour - 382, hour - 387], [hour - 387, hour - 382]]) {
    assert.deepEqual(ids(soonestResetOrder(lanes, ranking({ a: weekEnding(ra), b: weekEnding(rb) }))), ['l1', 'l2'], `${ra} against ${rb}`);
  }
});

test('the reset used for ranking is rounded to the minute and only comes from a current reading', () => {
  const minute = Math.ceil(NOW / 60_000) * 60_000 + DAY;
  assert.equal(weekTurnover(weekEnding(minute - 387), NOW), minute, 'a hair under the minute is that minute');
  assert.equal(weekTurnover(weekEnding(minute + 29_000), NOW), minute);
  assert.equal(weekTurnover(weekEnding(minute + 31_000), NOW), minute + 60_000);
  const weekOn = Math.round((NOW + 7 * DAY) / 60_000) * 60_000;
  assert.equal(weekTurnover(weekEnding(NOW - 1000), NOW), weekOn, 'a turnover already past means a new week, a whole week from its next one');
  assert.equal(weekTurnover({ windows: [{ key: 'week', usedPercent: 0, resetsAt: null }] }, NOW), weekOn, 'so does a week nothing has been used of');
  assert.equal(weekTurnover({ windows: [{ key: 'week', usedPercent: 12, resetsAt: null }] }, NOW), null, 'a week under way with no turnover stated says nothing about where it falls');
  assert.equal(weekTurnover({ ...weekEnding(NOW + DAY), stale: true }, NOW), null);
  assert.equal(weekTurnover({ windows: [{ key: 'week', usedPercent: null, resetsAt: NOW + DAY }] }, NOW), null, 'a meter that was not read proves nothing unused');
  assert.equal(weekTurnover(weekEnding(NOW + DAY, 100), NOW), null);
  assert.equal(weekTurnover(undefined, NOW), null);
});

test('the accounts of a tool are listed in the order they would be used', () => {
  // Registered in one order, lanes set in another, so a list that fell back to the
  // registry would be caught.
  const accounts = [
    { id: 'main', provider: 'claude', label: 'Main' },
    { id: 'second', provider: 'claude', label: 'Second' },
    { id: 'third', provider: 'claude', label: 'Third' },
    { id: 'spare', provider: 'claude', label: 'No lane' },
    { id: 'cx', provider: 'codex', label: 'Codex' },
  ];
  const lanes = [makeLane('l-third', 'third'), makeLane('l-main', 'main'), makeLane('l-second', 'second'), codexLane('l-cx', 'cx')];
  const quotas = { main: weekEnding(NOW + 6 * DAY), second: weekEnding(NOW + DAY), third: weekEnding(NOW + 3 * DAY) };
  assert.deepEqual(accountUseOrder(accounts, lanes, 'claude', ranking(quotas)).map((a) => a.id), ['second', 'third', 'main', 'spare'],
    'an account no lane uses comes last, and another tool\'s accounts are not listed');
  assert.deepEqual(accountUseOrder(accounts, lanes, 'claude', { now: NOW }).map((a) => a.id), ['third', 'main', 'second', 'spare'],
    'with nothing read yet, the lane order is all there is to go on');
});

test('ranking by reset reads a tool only once the walk reaches it', async () => {
  const facts = {
    a: { login: { signedIn: true }, quota: weekEnding(NOW + 5 * DAY) },
    b: { login: { signedIn: true }, quota: weekEnding(NOW + 1 * DAY) },
    x: { login: { signedIn: true }, quota: weekEnding(NOW + 2 * DAY) },
    y: { login: { signedIn: true }, quota: weekEnding(NOW + 3 * DAY) },
  };

  const first = recordingReader(facts);
  const pickedCodex = await selectLaneAsNeeded([codexLane('lx', 'x'), makeLane('la', 'a'), makeLane('lb', 'b')], { now: NOW }, first.read, { bySoonestReset: true });
  assert.equal(pickedCodex.lane.id, 'lx');
  assert.deepEqual(first.asked, ['x'], 'the only Codex account answers, so Claude is never read');

  const second = recordingReader(facts);
  const pickedClaude = await selectLaneAsNeeded([makeLane('la', 'a'), makeLane('lb', 'b'), codexLane('lx', 'x'), codexLane('ly', 'y')], { now: NOW }, second.read, { bySoonestReset: true });
  assert.equal(pickedClaude.lane.id, 'lb');
  assert.deepEqual([...second.asked].sort(), ['a', 'b'], 'Claude answers, so neither Codex account is read');
});

test('without ranking by reset, the walk is exactly as it was', async () => {
  const facts = {
    a: { login: { signedIn: true }, quota: weekEnding(NOW + 5 * DAY) },
    b: { login: { signedIn: true }, quota: weekEnding(NOW + 1 * DAY) },
  };
  const { read, asked } = recordingReader(facts);
  const selected = await selectLaneAsNeeded([makeLane('la', 'a'), makeLane('lb', 'b')], { now: NOW }, read);
  assert.equal(selected.lane.id, 'la');
  assert.deepEqual(asked, ['a']);
});

test('ranked by reset, reading as needed always gives the answer that reading everything first gives', async () => {
  const states = {
    SOON: { login: { signedIn: true }, quota: weekEnding(NOW + 1 * DAY) },
    LATE: { login: { signedIn: true }, quota: weekEnding(NOW + 5 * DAY) },
    NO_RESET: { login: { signedIn: true }, quota: weekEnding(null) },
    SPENT: { login: { signedIn: true }, quota: weekEnding(NOW + 1 * DAY, 100) },
    OUT_WITH_READING: { login: { signedIn: false }, quota: weekEnding(NOW + 1 * HOUR) },
    UNREADABLE,
  };
  const names = Object.keys(states);
  // Two tools, a metered lane between them, and an account with two lanes.
  const pool = [makeLane('l1', 'a1'), codexLane('l3', 'a3'), makeLane('lm', 'm', 'metered'), makeLane('l2', 'a2'), codexLane('l4', 'a4'), makeLane('l5', 'a1')];
  for (const s1 of names) for (const s2 of names) for (const s3 of names) for (const s4 of names) for (const cooled of [false, true]) {
    const facts = { a1: states[s1], a2: states[s2], a3: states[s3], a4: states[s4], m: { login: { signedIn: true } } };
    const context = { now: NOW, cooldowns: cooled ? { l2: NOW + HOUR } : {}, spendPolicies: { lm: { budget: 20 } } };
    const everything = { ...context, loginStates: {}, quotas: {} };
    for (const [id, f] of Object.entries(facts)) {
      if (f.login !== undefined) everything.loginStates[id] = f.login;
      if (f.quota !== undefined) everything.quotas[id] = f.quota;
    }
    const expected = selectLane(soonestResetOrder(pool, everything), everything);
    const actual = await selectLaneAsNeeded(pool, context, recordingReader(facts).read, { bySoonestReset: true });
    const label = `${s1}/${s2}/${s3}/${s4}${cooled ? ' with l2 cooling down' : ''}`;
    assert.equal(actual?.lane.id ?? null, expected?.lane.id ?? null, label);
    assert.equal(actual?.status.status ?? null, expected?.status.status ?? null, label);
  }
});

// Found in review: a tool with one account and two lanes on it, one cooling down, was
// ranked before its account was read, so a metered lane between them won.
test('a tool with one account is still read before its places are settled', async () => {
  const facts = { cx: { login: { signedIn: true }, quota: weekEnding(NOW + 2 * DAY) }, m: { login: { signedIn: true } } };
  const pool = [codexLane('x1', 'cx'), makeLane('m', 'm', 'metered'), codexLane('x2', 'cx')];
  const context = { now: NOW, cooldowns: { x1: NOW + HOUR }, spendPolicies: { m: { budget: 10 } } };
  const selected = await selectLaneAsNeeded(pool, context, recordingReader(facts).read, { bySoonestReset: true });
  assert.equal(selected.lane.id, 'x2', 'the account has room on its other lane, so nothing metered is billed');
});

// Found in review: ranking read every account of a tool live, so an account whose usage
// call was failing was asked, and waited on, by every dry-run.
test('ranking looks at what is already known, and reads in full only the lanes the walk reaches', async () => {
  const facts = {
    a: { login: { signedIn: true }, quota: weekEnding(NOW + 5 * DAY) },
    b: { login: { signedIn: true }, quota: weekEnding(NOW + 1 * DAY) },
    failing: { login: { signedIn: true }, quota: { error: 'fetch failed' } },
  };
  const full = recordingReader(facts);
  const peeked = [];
  // What the real look returns: the last good reading. A failure is never cached, so the
  // failing account's look is whatever it last read successfully, here a later reset.
  const cached = { ...facts, failing: { login: { signedIn: true }, quota: weekEnding(NOW + 6 * DAY) } };
  const peekAccount = (id) => { peeked.push(id); return cached[id]; };
  const pool = [makeLane('la', 'a'), makeLane('lf', 'failing'), makeLane('lb', 'b')];
  const selected = await selectLaneAsNeeded(pool, { now: NOW }, full.read, { bySoonestReset: true, peekAccount });
  assert.equal(selected.lane.id, 'lb');
  assert.deepEqual([...peeked].sort(), ['a', 'b', 'failing'], 'every account of the tool is looked at, cheaply');
  assert.deepEqual(full.asked, ['b'], 'only the lane chosen is read in full; the failing account is never asked');
});

// Found in review: the look can be minutes or hours old. When the full reading says the
// account it ranked first cannot run after all, the walk used to step to the next place,
// a metered lane here, while another account of the same tool had room.
test('when the full reading contradicts the look, the rest of the tool is ranked again before moving on', async () => {
  const facts = {
    a: { login: { signedIn: true }, quota: weekEnding(NOW + 5 * DAY) },
    b: { login: { signedIn: true }, quota: weekEnding(NOW + DAY, 100) },
    m: { login: { signedIn: true } },
  };
  const cached = { ...facts, b: { login: { signedIn: true }, quota: weekEnding(NOW + DAY, 80) } };
  const pool = [makeLane('la', 'a'), makeLane('lm', 'm', 'metered'), makeLane('lb', 'b')];
  const full = recordingReader(facts);
  const selected = await selectLaneAsNeeded(pool, { now: NOW, spendPolicies: { lm: { budget: 20 } } }, full.read, { bySoonestReset: true, peekAccount: (id) => cached[id] });
  assert.equal(selected.lane.id, 'la', 'a has room, so the metered lane is not billed');
  assert.deepEqual(full.asked, ['b', 'a']);
});

// Found in review: a look that says an account is out until a time that has passed was
// ranked as unknown, so with no tray running to refresh it the account was passed over by
// every run until the others ran out, though its limit had long lifted.
test('a look whose limit has since lifted is ranked on its week, and the full reading settles it', async () => {
  const sessionWasOut = { windows: [
    { key: 'session', usedPercent: 100, resetsAt: NOW - 2 * HOUR },
    { key: 'week', usedPercent: 40, resetsAt: NOW + 2 * DAY },
  ] };
  const facts = {
    main: { login: { signedIn: true }, quota: weekEnding(NOW + 2 * DAY, 40) },
    second: { login: { signedIn: true }, quota: weekEnding(NOW + 6 * DAY) },
  };
  const cached = { ...facts, main: { login: { signedIn: true }, quota: sessionWasOut } };
  const full = recordingReader(facts);
  const selected = await selectLaneAsNeeded([makeLane('l-main', 'main'), makeLane('l-second', 'second')], { now: NOW }, full.read, { bySoonestReset: true, peekAccount: (id) => cached[id] });
  assert.equal(selected.lane.id, 'l-main');
  assert.deepEqual(full.asked, ['main']);

  const stillOut = { ...facts, main: { login: { signedIn: true }, quota: { windows: [{ key: 'session', usedPercent: 100, resetsAt: NOW + HOUR }, { key: 'week', usedPercent: 40, resetsAt: NOW + 2 * DAY }] } } };
  const again = recordingReader(facts);
  const meanwhile = await selectLaneAsNeeded([makeLane('l-main', 'main'), makeLane('l-second', 'second')], { now: NOW }, again.read, { bySoonestReset: true, peekAccount: (id) => stillOut[id] });
  assert.equal(meanwhile.lane.id, 'l-second', 'a limit still in force keeps it out of the ranking');
});

test('only registered accounts count towards ranking a tool', () => {
  const lanes = [makeLane('1', 'a'), makeLane('2', 'gone')];
  assert.equal(ranksByReset({ quotaWatch: 'auto', lanes }, 'claude'), true, 'without the registry, every lane counts');
  assert.equal(ranksByReset({ quotaWatch: 'auto', lanes }, 'claude', [{ id: 'a', provider: 'claude' }]), false, 'a lane on an account that is gone can never be picked');
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
