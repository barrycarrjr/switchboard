import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideDefaultSwitch, freshNotices, isSpent, planDefaultSwitches, SWITCH_COOLDOWN_MS } from '../core/watch.js';
import { defaultFollowsLanes } from '../core/lanes.js';

const acct = (id) => ({ id, provider: 'claude', label: id, home: `/x/${id}` });
const snap = (session, week, extra = {}) => ({
  windows: [
    { key: 'session', label: 'Session (5h)', usedPercent: session, resetsAt: extra.sessionReset ?? null },
    { key: 'week', label: 'Week (all models)', usedPercent: week, resetsAt: extra.weekReset ?? null },
  ],
  ...extra,
});

const base = {
  accounts: [acct('a'), acct('b')],
  activeId: 'a',
  now: 1_000_000_000,
  lastSwitchAt: 0,
  pinPresent: false,
};

test('off mode never acts', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'off', snapshots: { a: snap(100, 50), b: snap(5, 10) } });
  assert.equal(d.kind, 'none');
});

test('auto mode switches to the account with room when the active one is spent', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(5, 10) } });
  assert.deepEqual({ kind: d.kind, to: d.to, from: d.from }, { kind: 'switch', to: 'b', from: 'a' });
});

test('notify mode suggests instead of switching', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'notify', snapshots: { a: snap(30, 100), b: snap(5, 10) } });
  assert.equal(d.kind, 'suggest');
  assert.equal(d.to, 'b');
});

test('a healthy active account means no action', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(80, 62), b: snap(5, 10) } });
  assert.equal(d.kind, 'none');
});

test('unknown active quota is never treated as spent', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: { error: 'no-credentials' }, b: snap(5, 10) } });
  assert.equal(d.kind, 'none');
});

test('a stale desktop sample is never acted on, in either direction', () => {
  assert.equal(isSpent(snap(100, 100, { stale: true, source: 'desktop' })), null);
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(5, 10, { stale: true, source: 'desktop' }) } });
  assert.equal(d.kind, 'exhausted'); // b is unreadable-for-action, so nothing has room
});

test('a signed-out account is never an auto-switch target even when Desktop shows room', () => {
  const d = decideDefaultSwitch({
    ...base,
    mode: 'auto',
    snapshots: { a: snap(100, 62), b: snap(5, 10, { source: 'desktop' }) },
    loginStates: { a: { signedIn: true }, b: { signedIn: false } },
  });
  assert.equal(d.kind, 'exhausted');
});

test('a verified signed-in target remains eligible for auto-switching', () => {
  const d = decideDefaultSwitch({
    ...base,
    mode: 'auto',
    snapshots: { a: snap(100, 62), b: snap(5, 10) },
    loginStates: { a: { signedIn: true }, b: { signedIn: true } },
  });
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'b');
});

test('a nearly-spent target is not worth switching to', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(10, 97) } });
  assert.equal(d.kind, 'exhausted');
});

// The dead band. The two usage sources can read a couple of points apart for the same
// account, so one mark used in both directions let the default leave and come straight
// back. An account lets go of the default at 90/95 and only wins it back under 87/92.

test('a target inside the dead band is not somewhere to send a default that still works', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(93, 62), b: snap(88, 10) } });
  assert.equal(d.kind, 'none', 'a few points better than the account it would replace is not room to spare');
});

test('a target that has dropped clear of the band is', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(86, 10) } });
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'b');
});

// The band decides between two accounts that both still work. Once the default has
// actually hit the wall it decides nothing, because staying is no longer an option that
// works: the candidates go back to being judged at the leaving mark, which is the only
// line there was before the band existed. Without this, a default at 100% sat there
// refusing work while an account three points inside the band ran perfectly well, and
// the machine reported that nothing had room. The lane path never had this problem; it
// has always fallen back to the ordinary pick when the default is spent.

test('a spent default does hand over to an account inside the band', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(88, 10) } });
  assert.equal(d.kind, 'switch', 'an account that still runs beats one that has hit the wall');
  assert.equal(d.to, 'b');
});

test('a spent default hands over on the weekly band too', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(30, 100), b: snap(10, 93) } });
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'b');
});

test('the handover stops at the leaving mark; it does not take anything that still runs', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(91, 10) } });
  assert.equal(d.kind, 'exhausted', 'past the leaving mark is where it was already refused before the band');
});

test('the handover still refuses an account that is signed out', () => {
  const d = decideDefaultSwitch({
    ...base,
    mode: 'auto',
    loginStates: { a: { signedIn: true }, b: { signedIn: false } },
    snapshots: { a: snap(100, 62), b: snap(88, 10) },
  });
  assert.equal(d.kind, 'exhausted');
});

test('a merely low default is left alone even when the band would hand it over', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(96, 62), b: snap(88, 10) } });
  assert.equal(d.kind, 'none', 'the band only stops applying once the default has stopped working');
});

test('two accounts either side of 90 percent do not trade the default between them', () => {
  const there = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(91, 40), b: snap(89, 40) } });
  assert.equal(there.kind, 'none');
  const back = decideDefaultSwitch({ ...base, activeId: 'b', mode: 'auto', snapshots: { a: snap(89, 40), b: snap(91, 40) } });
  assert.equal(back.kind, 'none');
});

test('exhausted reports the latest known reset of the spent windows', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 100, { sessionReset: base.now + 5000, weekReset: base.now + 9000 }), b: snap(10, 99) } });
  assert.equal(d.kind, 'exhausted');
  assert.equal(d.resetsAt, base.now + 9000);
});

test('the pin blocks switching and says so', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', pinPresent: true, snapshots: { a: snap(100, 62), b: snap(5, 10) } });
  assert.equal(d.kind, 'pin-blocked');
  assert.equal(d.spent, true);
});

// pin-blocked fires at the running-low gate, not at empty, so the decision carries
// which of the two it is: telling someone their account "is out of quota" while it is
// still working would be a false alarm about the wrong problem.
test('a pin block on a merely running-low account says low, not empty', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', pinPresent: true, snapshots: { a: snap(92, 40), b: snap(5, 10) } });
  assert.equal(d.kind, 'pin-blocked');
  assert.equal(d.spent, false);
});

test('the cooldown suppresses back-to-back switches', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', lastSwitchAt: base.now - SWITCH_COOLDOWN_MS + 1000, snapshots: { a: snap(100, 62), b: snap(5, 10) } });
  assert.equal(d.kind, 'none');
});

test('a single registered account means nothing to decide', () => {
  const d = decideDefaultSwitch({ ...base, accounts: [acct('a')], mode: 'auto', snapshots: { a: snap(100, 62) } });
  assert.equal(d.kind, 'none');
});

test('with several targets, the one with the most week headroom wins', () => {
  const accounts = [acct('a'), acct('b'), acct('c')];
  const d = decideDefaultSwitch({ ...base, accounts, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(5, 40), c: snap(5, 10) } });
  assert.equal(d.to, 'c');
});

// planDefaultSwitches: the whole watch decision, for every tool at once. The tray app and
// `switchboard watch` both call this, so these cases cover both.

const laneFor = (id, accountId, harness = 'claude') => ({
  id,
  harness,
  provider: harness === 'claude' ? 'anthropic' : harness,
  accountId,
  billing: 'subscription',
  capabilities: ['chat'],
});

// Which account is the machine default: the persisted variable names its folder.
const envSaying = (home) => (name) => (name === 'CLAUDE_CONFIG_DIR' ? home : null);

const signedIn = (...ids) => Object.fromEntries(ids.map((id) => [id, { signedIn: true }]));

// Tests that walk the same states on both settings. On "Tell me" they guard the rules
// it always had, which have to stay exactly as they were; on "Switch automatically" they
// show the ranking reaching the same answer, or the honest new one.
const BOTH = [['notify', 'suggest'], ['auto', 'switch']];

const planBase = {
  registry: { accounts: [acct('a'), acct('b')] },
  loginStates: signedIn('a', 'b'),
  now: 1_000_000_000,
  envReader: envSaying('/x/a'),
};

test('planDefaultSwitches does nothing while the watch is off', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    settings: { quotaWatch: 'off', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')] },
    snapshots: { a: snap(100, 50), b: snap(5, 10) },
  });
  assert.deepEqual(decisions, []);
});

test('a configured pool decides by lane order, not by whether the default is spent', () => {
  const [decision, ...rest] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),  // b is the default, and it is perfectly healthy
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(5, 10) },
  });
  assert.equal(rest.length, 0);
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.provider, 'claude');
  assert.equal(decision.to, 'a');
  assert.equal(decision.from, 'b');
});

test('notify mode suggests the lane switch instead of making it', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'notify', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(5, 10) },
  });
  assert.equal(decision.kind, 'suggest');
  assert.equal(decision.to, 'a');
});

test('the top lane already being the default is nothing to do', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(5, 10) },
  });
  assert.deepEqual(decisions, []);
});

// The dead band, on the path where a single mark hurt most. Lane order pulls the default
// back to the top lane the moment that lane looks roomy again, so a top lane reading
// either side of 90% took the default, gave it up and took it back all day.

test('the lane holding the default keeps it on a reading inside the band', () => {
  const decisions = planDefaultSwitches({
    ...planBase,   // a is the top lane and holds the default
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(88, 10), b: snap(5, 10) },
  });
  assert.deepEqual(decisions, []);
});

test('a lane that gave the default up does not take it back on a reading inside the band', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),   // b holds it; the top lane gave it up earlier at 91%
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(89, 10), b: snap(5, 10) },
  });
  assert.deepEqual(decisions, []);
});

test('a lane that has dropped clear of the band takes the default back', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(86, 10), b: snap(5, 10) },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'a');
});

test('the mark for giving the default up has not moved: 90 percent still hands it over', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(90, 10), b: snap(5, 10) },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'b');
});

// The measured failure, walked the way the watch actually runs: the default follows each
// switch, so the next pass asks about the account that just received it. On one mark this
// sequence switched on all ten passes, which at a pass every five minutes and a switch
// every ten is the ninety-odd default changes a day the review counted.
test('readings wobbling either side of 90 percent move the default once, not all day', () => {
  const lanes = [laneFor('l-a', 'a'), laneFor('l-b', 'b')];
  const wobble = [91, 89, 91, 88, 90, 89, 91, 87, 90, 88];
  let defaultHome = '/x/a';
  let lastAutoSwitchAt = 0;
  const switches = [];

  wobble.forEach((session, pass) => {
    const now = planBase.now + pass * (SWITCH_COOLDOWN_MS + 60_000);   // clear of the cooldown every pass
    const [decision] = planDefaultSwitches({
      ...planBase,
      now,
      envReader: envSaying(defaultHome),
      settings: { quotaWatch: 'auto', lanes, lastAutoSwitchAt },
      snapshots: { a: snap(session, 10), b: snap(5, 10) },
    });
    if (!decision) return;
    switches.push(decision.to);
    defaultHome = `/x/${decision.to}`;
    lastAutoSwitchAt = now;
  });

  assert.deepEqual(switches, ['b'], 'the default leaves the wobbling lane once and then stays put');
});

test('a lane whose usage could not be read is never worth switching to', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: { error: 'auth' }, b: snap(5, 10) },
  });
  assert.deepEqual(decisions, []);
});

test('a credential override blocks a lane switch rather than making an unreliable one', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(5, 10) },
    pinPresent: true,
  });
  assert.equal(decision.kind, 'pin-blocked');
  assert.equal(decision.provider, 'claude');
  // Healthy snapshots here, so the block is about the pin, not exhaustion.
  assert.equal(decision.spent, false);
});

// Both renderers branch on the flag; a hard-coded "is out of quota" would lie whenever
// the block fired at the running-low gate. Pinned at source, the way the lane-token
// wiring pins are, because formatDecision and the tray handler have no spawn harness.
test('both pin-blocked renderers say low or empty from the decision, not a fixed claim', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cli = fs.readFileSync(path.join(root, 'bin', 'cli.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const branch = /\$\{decision\.spent \? 'is out of quota' : 'is nearly out of quota'\}/;
  assert.match(cli, branch);
  assert.match(main, branch);
});

test('a lane switch respects the cooldown on the last one', () => {
  for (const [quotaWatch] of BOTH) {
    const decisions = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'),
      settings: {
        quotaWatch,
        lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')],
        lastAutoSwitchAt: planBase.now - (SWITCH_COOLDOWN_MS - 1),
      },
      snapshots: { a: snap(5, 10), b: snap(5, 10) },
    });
    assert.deepEqual(decisions, [], quotaWatch);
  }
});

// A lastAutoSwitchAt AHEAD of now was written by a wrong clock; reading its negative
// age as "inside the cooldown" would freeze all switching for the whole skew, since
// nothing rewrites the stamp while switches are suppressed. Expired, not inside:
// same guard as the lane-token freshness window ("a checkedAt in the future is
// stale, not fresh" in lane-tokens.test.js).
test('a cooldown stamp in the future is expired, not in force', () => {
  const d = decideDefaultSwitch({
    ...base,
    mode: 'auto',
    lastSwitchAt: base.now + 24 * 60 * 60 * 1000,
    snapshots: { a: snap(100, 62), b: snap(5, 10) },
  });
  assert.equal(d.kind, 'switch');
});

test('a lane switch is not frozen by a future cooldown stamp either', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: {
      quotaWatch: 'auto',
      lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')],
      lastAutoSwitchAt: planBase.now + 24 * 60 * 60 * 1000,
    },
    snapshots: { a: snap(5, 10), b: snap(5, 10) },
  });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'switch');
  assert.equal(decisions[0].to, 'a');
});

test('with no lanes at all, Claude still falls back to the quota-only decision', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    settings: { quotaWatch: 'auto', lanes: [], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(100, 62), b: snap(5, 10) },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.provider, 'claude');
  assert.equal(decision.to, 'b');
});

test('a tool other than Claude waits for lanes rather than being guessed about', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [{ id: 'c1', provider: 'codex', label: 'c1', home: '/x/c1' }] },
    loginStates: signedIn('c1'),
    settings: { quotaWatch: 'auto', lanes: [], lastAutoSwitchAt: 0 },
    snapshots: {},
  });
  assert.deepEqual(decisions, []);
});

// The five-hour window. It is the one that stops work first in practice: it can sit at
// 95% while the weekly figure still reads comfortable, and it used to be ignored right up
// until it read a full 100, by which point Claude Code was already refusing work.

test('the default moves before the five-hour window is completely gone', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(92, 40), b: snap(5, 10) } });
  assert.deepEqual({ kind: d.kind, to: d.to }, { kind: 'switch', to: 'b' });
  assert.match(d.reason, /nearly out of quota/);
});

test('a full weekly window still reads as out of quota, not merely low', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(10, 100), b: snap(5, 10) } });
  assert.match(d.reason, /is out of quota/);
});

test('running low with nowhere to go is not announced as exhausted', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(92, 40), b: snap(93, 40) } });
  assert.equal(d.kind, 'none');
});

test('being genuinely out with nowhere to go is still announced', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 40), b: snap(93, 40) } });
  assert.equal(d.kind, 'exhausted');
});

test('targets are ranked by their fullest window, not by the weekly one alone', () => {
  const accounts = [acct('a'), acct('b'), acct('c')];
  const d = decideDefaultSwitch({
    ...base,
    accounts,
    mode: 'auto',
    // b looks best on the week and is nearly out of its five-hour window; c is idle.
    snapshots: { a: snap(100, 62), b: snap(88, 10), c: snap(5, 40) },
  });
  assert.equal(d.to, 'c');
});

test('a lane whose five-hour window is nearly gone does not take the default back', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),  // b is the default and is healthy
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(95, 20), b: snap(5, 10) },
  });
  assert.deepEqual(decisions, []);
});

test('a default running low hands over to the next lane with room', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(95, 20), b: snap(5, 10) },  // a is the default and nearly out
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'b');
  assert.match(decision.reason, /close to its limit/);
});

test('a spent default still moves even when the only other lane is short on room', () => {
  for (const [quotaWatch, kind] of BOTH) {
    const [decision] = planDefaultSwitches({
      ...planBase,
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: { a: snap(100, 20), b: snap(93, 10) },
    });
    assert.equal(decision.kind, kind, quotaWatch);
    assert.equal(decision.to, 'b', quotaWatch);
  }
});

// Spend-down. A weekly window is use-it-or-lose-it: quota unspent at the turnover is
// forfeited. So an account whose week ends within a day and still has room takes the
// default even while the active account is perfectly healthy. In a lane pool the
// default comes back on its own, because lane order resumes once the window resets and
// stops qualifying; without lanes there is no preferred account to come back to, and
// the default stays where the last switch put it, as after every other switch.

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test('an account whose week expires soon takes the default from a healthy one', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.deepEqual({ kind: d.kind, to: d.to, from: d.from }, { kind: 'switch', to: 'b', from: 'a' });
  assert.match(d.reason, /expires soon/);
});

test('spend-down suggests instead of switching in notify mode', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'notify', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'suggest');
  assert.equal(d.to, 'b');
});

test('a week that turns over beyond the horizon is not about to lose anything', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
    b: snap(12, 67, { weekReset: base.now + 30 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

test('the active account expiring soonest means staying put and spending it', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 2 * HOUR }),
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

test('a turnover sooner than the active account\'s own still wins', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 6 * HOUR }),
    b: snap(12, 67, { weekReset: base.now + 2 * HOUR }),
  } });
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'b');
});

test('an expiring account without headroom has nothing left worth spending', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
    b: snap(95, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

test('a turnover already in the past is a stale reading, not spend-down', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
    b: snap(12, 67, { weekReset: base.now - 1000 }),
  } });
  assert.equal(d.kind, 'none');
});

test('the soonest turnover wins when several accounts are about to forfeit', () => {
  const accounts = [acct('a'), acct('b'), acct('c')];
  const d = decideDefaultSwitch({ ...base, accounts, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
    b: snap(5, 40, { weekReset: base.now + 20 * HOUR }),
    c: snap(5, 10, { weekReset: base.now + 2 * HOUR }),
  } });
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'c');
  assert.match(d.reason, /expires soon/);
});

// The strict < is the anti-oscillation guard for this shape: with <=, each pass would
// find the OTHER account "sooner" and the default would trade hands every cooldown
// until the shared reset. Two Max accounts started the same day reset at the same
// instant, so this is not a contrived state.
test('two weeks turning over at the same instant stay where they are', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 6 * HOUR }),
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

// Anti-flap: with the comparison made against a missing reading, one failed read of
// the default's meter would swing the default away and the next good read would swing
// it back, once per cooldown for as long as the blips recurred.
test('an unreadable default is never left for a spend-down', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: { error: 'unavailable' },
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

test('a default with no stated week turnover cannot be proven the later one', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71),
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

test('spend-down respects the cooldown like every other switch', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', lastSwitchAt: base.now - SWITCH_COOLDOWN_MS + 1000, snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

// A pin blocks a spend-down quietly. pin-blocked is an alarm that the default is in
// trouble; here nothing is wrong with it and nothing was going to stop working.
test('a pin blocks spend-down silently, not with a false alarm', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', pinPresent: true, snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

test('a signed-out account is never a spend-down target', () => {
  const d = decideDefaultSwitch({
    ...base,
    mode: 'auto',
    snapshots: {
      a: snap(19, 71, { weekReset: base.now + 96 * HOUR }),
      b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
    },
    loginStates: { a: { signedIn: true }, b: { signedIn: false } },
  });
  assert.equal(d.kind, 'none');
});

test('a running-low default prefers the expiring target over the roomiest one', () => {
  const accounts = [acct('a'), acct('b'), acct('c')];
  const d = decideDefaultSwitch({ ...base, accounts, mode: 'auto', snapshots: {
    a: snap(92, 40),
    b: snap(5, 40, { weekReset: base.now + 6 * HOUR }),
    c: snap(5, 10),
  } });
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'b');
  assert.match(d.reason, /nearly out of quota/);
});

test('an expiring lane jumps the lane order', () => {
  const expected = {
    notify: 'b has unused quota that expires soon; spending it down before a',
    auto: "b's weekly quota resets sooner than a's, so it is used first",
  };
  for (const [quotaWatch, kind] of BOTH) {
    const [decision, ...rest] = planDefaultSwitches({
      ...planBase,
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      },
    });
    assert.equal(rest.length, 0, quotaWatch);
    assert.equal(decision.kind, kind, quotaWatch);
    assert.equal(decision.to, 'b', quotaWatch);
    assert.equal(decision.reason, expected[quotaWatch], quotaWatch);
  }
});

test('the detour undoes itself: after the reset, the default goes back to the lane that is now due', () => {
  const expected = {
    notify: 'a is the first ready account in your lane order',
    auto: "a's weekly quota resets sooner than b's, so it is used first",
  };
  for (const [quotaWatch, kind] of BOTH) {
    const [decision] = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'),
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(0, 0, { weekReset: planBase.now + 7 * 24 * HOUR }),
      },
    });
    assert.equal(decision.kind, kind, quotaWatch);
    assert.equal(decision.to, 'a', quotaWatch);
    assert.equal(decision.reason, expected[quotaWatch], quotaWatch);
  }
});

test('an expiring lane already holding the default is left alone', () => {
  for (const [quotaWatch] of BOTH) {
    const decisions = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'),
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      },
    });
    assert.deepEqual(decisions, [], quotaWatch);
  }
});

// A lane parked on the default by an earlier spend-down keeps counting as expiring while
// it drifts into the band. Judged on winning the default instead of keeping it, it would
// drop out of the expiring list mid-window and the top lane would take the default back
// early, which is the round trip the detour exists to avoid.
test('a spend-down lane holding the default keeps it while it drifts into the band', () => {
  for (const [quotaWatch] of BOTH) {
    const decisions = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'),
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(88, 67, { weekReset: planBase.now + 6 * HOUR }),
      },
    });
    assert.deepEqual(decisions, [], quotaWatch);
  }
});

// The default sits ON the expiring-but-unavailable lane in these two, so falling
// through to the ordinary order produces a visible switch to the top lane. With the
// default elsewhere, "fell through" and "selected nothing" would both read as [].
const fellThrough = {
  notify: 'a is the first ready account in your lane order',
  auto: 'a is the first ready account by soonest weekly reset',
};

test('an expiring lane that is signed out falls through to the ordinary order', () => {
  for (const [quotaWatch, kind] of BOTH) {
    const [decision] = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'),
      loginStates: { a: { signedIn: true }, b: { signedIn: false } },
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      },
    });
    assert.equal(decision.kind, kind, quotaWatch);
    assert.equal(decision.to, 'a', quotaWatch);
    assert.equal(decision.reason, fellThrough[quotaWatch], `${quotaWatch}: nothing claims b reset later, it simply cannot run`);
  }
});

test('an expiring lane on cooldown falls through to the ordinary order', () => {
  for (const [quotaWatch, kind] of BOTH) {
    const [decision] = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'),
      settings: {
        quotaWatch,
        lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')],
        cooldowns: { 'l-b': planBase.now + 2 * HOUR },
        lastAutoSwitchAt: 0,
      },
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      },
    });
    assert.equal(decision.kind, kind, quotaWatch);
    assert.equal(decision.to, 'a', quotaWatch);
    assert.equal(decision.reason, fellThrough[quotaWatch], quotaWatch);
  }
});

test('the soonest-expiring lane heads the queue when several qualify', () => {
  const expected = {
    notify: 'c has unused quota that expires soon; spending it down before a',
    auto: "c's weekly quota resets sooner than a's, so it is used first",
  };
  for (const [quotaWatch, kind] of BOTH) {
    const [decision] = planDefaultSwitches({
      ...planBase,
      registry: { accounts: [acct('a'), acct('b'), acct('c')] },
      loginStates: signedIn('a', 'b', 'c'),
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(5, 40, { weekReset: planBase.now + 20 * HOUR }),
        c: snap(5, 10, { weekReset: planBase.now + 2 * HOUR }),
      },
    });
    assert.equal(decision.kind, kind, quotaWatch);
    assert.equal(decision.to, 'c', quotaWatch);
    assert.equal(decision.reason, expected[quotaWatch], quotaWatch);
  }
});

// Anti-flap: the failed read is the absence of a reading, not a reading. Acting on it
// made every blip a round trip, out on the error and back on the recovery, once per
// cooldown for as long as the endpoint stayed flaky.
test('a default whose meter merely failed to read is not moved', () => {
  for (const [quotaWatch] of BOTH) {
    const decisions = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'),
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(5, 10),
        b: { error: 'unavailable' },
      },
    });
    assert.deepEqual(decisions, [], quotaWatch);
  }
});

// The other absence channel: the sign-in state can fail to read (the credentials file
// is briefly unparseable during the CLI's own token refresh). That is a blip, not a
// state, and moving the default on it made the same round trip as a quota blip.
test('a default whose sign-in state failed to read is not moved either', () => {
  for (const [quotaWatch] of BOTH) {
    const decisions = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'),
      loginStates: { a: { signedIn: true }, b: { signedIn: null } },
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: { a: snap(5, 10), b: snap(6, 11) },
    });
    assert.deepEqual(decisions, [], quotaWatch);
  }
});

// A stale reading may rule an account out, never in: it describes a moment every run
// since has moved on from, so it cannot prove the default's own turnover is the later
// one, and without the proof there is no spend-down.
test('a stale reading of the default cannot vouch for leaving it', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: {
    a: snap(19, 71, { weekReset: base.now + 96 * HOUR, stale: true, source: 'desktop' }),
    b: snap(12, 67, { weekReset: base.now + 6 * HOUR }),
  } });
  assert.equal(d.kind, 'none');
});

// The abstain must not swallow the reclaim of a default parked on an account with no
// lane at all: that account is outside the pool's vocabulary, not an absence of a
// reading, and the guide promises the watcher reclaims it.
test('a default on an account with no lane is still reclaimed by the pool', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(5, 10) },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'a');
  assert.match(decision.reason, /first ready account in your lane order/);
});

test('a signed-out default still hands over; that is a reading, not the lack of one', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    loginStates: { a: { signedIn: true }, b: { signedIn: false } },
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(5, 10),
      b: { error: 'no-credentials' },
    },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'a');
});

// A pin makes switching unreliable. For a switch the watch wanted anyway that is worth
// an alarm; for a switch that exists only to burn expiring quota it is not, because
// nothing is wrong with the default and nothing was going to stop working.
test('a pin blocks a lane spend-down silently, not with a false alarm', () => {
  for (const [quotaWatch] of BOTH) {
    const decisions = planDefaultSwitches({
      ...planBase,
      pinPresent: true,
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      },
    });
    assert.deepEqual(decisions, [], quotaWatch);
  }
});

test('a pin still alarms when the default is genuinely running low', () => {
  for (const [quotaWatch] of BOTH) {
    const [decision] = planDefaultSwitches({
      ...planBase,
      pinPresent: true,
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
      snapshots: {
        a: snap(92, 40),
        b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      },
    });
    assert.equal(decision.kind, 'pin-blocked', quotaWatch);
    assert.equal(decision.spent, false, quotaWatch);
  }
});

// The alarm asks whether the pin blocked something that was going to happen anyway,
// which is not the same question as whether this switch is a spend-down. With the
// default on neither the top lane nor the expiring one, a lane-priority switch was
// independently wanted and blocked, and reading the switch as a spend-down silenced
// that alarm for the whole expiring day. That is "Tell me", where lane order is the
// priority; on "Switch automatically" the next test holds instead.
test('a pin still alarms when lane priority wanted a switch of its own', () => {
  const withExpiring = (weekReset) => planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: signedIn('a', 'b', 'c'),
    envReader: envSaying('/x/c'),
    pinPresent: true,
    settings: { quotaWatch: 'notify', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(12, 67, { weekReset }), c: snap(6, 20) },
  });
  // Without the expiring lane this state alarms; adding one must not change that.
  assert.equal(withExpiring(planBase.now + 96 * HOUR)[0]?.kind, 'pin-blocked');
  assert.equal(withExpiring(planBase.now + 6 * HOUR)[0]?.kind, 'pin-blocked');
});

// On "Switch automatically" the alarm keeps its meaning: plain lane order wanted the switch
// too. The default here is the top lane, so a sooner reset is the only thing it is held
// back from, and that is not worth an alarm.
test('on "Switch automatically" a pin holding the top lane back from a sooner reset is not an alarm', () => {
  const lanes = [laneFor('l-c', 'c'), laneFor('l-a', 'a'), laneFor('l-b', 'b')];
  const plan = (c) => planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: signedIn('a', 'b', 'c'),
    envReader: envSaying('/x/c'),
    pinPresent: true,
    settings: { quotaWatch: 'auto', lanes, lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10, { weekReset: planBase.now + 2 * DAY }), b: snap(12, 67, { weekReset: planBase.now + 3 * DAY }), c },
  });
  assert.deepEqual(plan(snap(6, 20, { weekReset: planBase.now + 4 * DAY })), [], 'healthy, and held back from a sooner reset');
  assert.equal(plan(snap(93, 20, { weekReset: planBase.now + 4 * DAY }))[0]?.kind, 'pin-blocked', 'running low');
});

test('a pin alarms for a signed-out default even while a lane is expiring', () => {
  for (const [quotaWatch] of BOTH) {
    const [decision] = planDefaultSwitches({
      ...planBase,
      registry: { accounts: [acct('a'), acct('b'), acct('c')] },
      loginStates: { ...signedIn('a', 'b'), c: { signedIn: false } },
      envReader: envSaying('/x/c'),
      pinPresent: true,
      settings: { quotaWatch, lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
      snapshots: { a: snap(5, 10), b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }), c: { error: 'no-credentials' } },
    });
    assert.equal(decision.kind, 'pin-blocked', quotaWatch);
  }
});

// The top lane happening to be the expiring one is not a spend-down: lane order wanted
// that switch anyway, so it keeps its ordinary reason (and, under a pin, its alarm). On
// "Switch automatically" the same switch is made for its reset and says so, above.
test('a switch lane order wanted anyway is not called a spend-down', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'notify', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      b: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
    },
  });
  assert.equal(decision.kind, 'suggest');
  assert.equal(decision.to, 'a');
  assert.match(decision.reason, /first ready account in your lane order/);
});

test('a metered lane has nothing that expires', () => {
  const metered = { ...laneFor('l-b', 'b'), billing: 'metered' };
  for (const [quotaWatch] of BOTH) {
    const decisions = planDefaultSwitches({
      ...planBase,
      settings: {
        quotaWatch,
        lanes: [laneFor('l-a', 'a'), metered],
        spendPolicies: { 'l-b': { budget: 25 } },
        lastAutoSwitchAt: 0,
      },
      // Even a metered account that somehow reports subscription-style windows must not
      // be treated as forfeiting anything at the week's turnover.
      snapshots: {
        a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
        b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      },
    });
    assert.deepEqual(decisions, [], quotaWatch);
  }
});

test('a metered lane is judged by its spend policy, not by a usage meter it does not have', () => {
  const metered = { ...laneFor('l-b', 'b'), billing: 'metered' };
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/a'),
    settings: {
      quotaWatch: 'auto',
      lanes: [metered, laneFor('l-a', 'a')],
      spendPolicies: { 'l-b': { budget: 25 } },
      lastAutoSwitchAt: 0,
    },
    snapshots: { a: snap(5, 10) },
  });
  assert.equal(decision.to, 'b');
});

// ---- "Switch automatically" ranks every account by its weekly reset ----
//
// Asked for on 2026-10-26: the default had moved to the account whose week ended that
// afternoon, but the others still sat in lane order, Monday's reset ahead of Thursday's.
// Unused weekly quota is lost at the turnover, so the soonest is spent first, and lane
// order only settles ties.

test('once the soonest account resets, the next soonest takes over, not the top lane', () => {
  const registry = { accounts: [acct('main'), acct('second'), acct('third')] };
  const lanes = [laneFor('l-main', 'main'), laneFor('l-second', 'second'), laneFor('l-third', 'third')];
  const plan = (snapshots) => planDefaultSwitches({
    ...planBase,
    registry,
    loginStates: signedIn('main', 'second', 'third'),
    envReader: envSaying('/x/second'),
    settings: { quotaWatch: 'auto', lanes, lastAutoSwitchAt: 0 },
    snapshots,
  });

  // The afternoon it was asked about: second ends today, third on Thursday, main on Monday.
  assert.deepEqual(plan({
    main: snap(21, 6, { weekReset: planBase.now + 6 * DAY }),
    second: snap(1, 84, { weekReset: planBase.now + 2 * HOUR }),
    third: snap(0, 42, { weekReset: planBase.now + 3 * DAY }),
  }), [], 'the account about to lose its quota keeps the default');

  // Its week has turned over, so its turnover is a week away again.
  const [decision] = plan({
    main: snap(21, 6, { weekReset: planBase.now + 6 * DAY }),
    second: snap(0, 0, { weekReset: planBase.now + 7 * DAY }),
    third: snap(0, 42, { weekReset: planBase.now + 3 * DAY }),
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'third', 'Thursday before Monday, whatever the lane order says');
  assert.equal(decision.reason, "third's weekly quota resets sooner than second's, so it is used first");
});

// Found in review. The tray serves a reading for five minutes (thirty while the vendor is
// refusing it), so the first passes after a week turns over can still hold the reading
// taken just before, whose reset has now passed, and a week nothing has been used of
// comes back with no reset at all. Both are a fresh week, the latest of all, and the
// default goes straight to the next soonest, not by way of the top lane and not held.
test('once the default\'s week turns over it goes straight to the next soonest, whatever the reading looks like', () => {
  const registry = { accounts: [acct('main'), acct('second'), acct('third')] };
  const lanes = [laneFor('l-main', 'main'), laneFor('l-second', 'second'), laneFor('l-third', 'third')];
  const turnover = planBase.now;
  const plan = (now, second) => planDefaultSwitches({
    ...planBase,
    now,
    registry,
    loginStates: signedIn('main', 'second', 'third'),
    envReader: envSaying('/x/second'),
    settings: { quotaWatch: 'auto', lanes, lastAutoSwitchAt: 0 },
    snapshots: {
      main: snap(21, 6, { weekReset: turnover + 6 * DAY }),
      second,
      third: snap(0, 42, { weekReset: turnover + 3 * DAY }),
    },
  });
  for (const [what, second] of [
    ['the reading taken just before the turnover', snap(1, 84, { weekReset: turnover })],
    ['an unstarted week, which states no reset', snap(0, 0)],
    ['a fresh reading of the new week', snap(0, 0, { weekReset: turnover + 7 * DAY })],
  ]) {
    const [decision] = plan(turnover + 60_000, second);
    assert.equal(decision?.to, 'third', `${what}: one move, to the next soonest`);
  }
});

/**
 * The watch the way it runs: every pass after the cooldown, the default following each
 * switch. `readings(pass)` gives that pass's snapshots. Returns where it switched to.
 */
function walkPasses({ registry, lanes, startOn, passes, readings, loginStates, settings = {} }) {
  let defaultHome = `/x/${startOn}`;
  let lastAutoSwitchAt = 0;
  const switches = [];
  for (let pass = 0; pass < passes; pass++) {
    const now = planBase.now + pass * (SWITCH_COOLDOWN_MS + 60_000);
    const [decision] = planDefaultSwitches({
      ...planBase,
      now,
      registry,
      loginStates,
      envReader: envSaying(defaultHome),
      settings: { quotaWatch: 'auto', lanes, lastAutoSwitchAt, ...settings },
      snapshots: readings(pass),
    });
    if (decision?.kind === 'switch') {
      switches.push(decision.to);
      defaultHome = `/x/${decision.to}`;
      lastAutoSwitchAt = now;
    }
  }
  return switches;
}

// A turnover once read is carried over to later fallback readings until it passes (see
// inheritResetTimes), so a reading does not lose its reset for a pass in practice. What
// does happen is a default whose live reading keeps failing after its week turned over:
// the fallback shows usage and no reset. That week has just begun, and an earlier rule
// that held such a default in place kept it on the account whose week was the latest.
test('a default whose reading states no reset is passed over for an account whose reset is stated', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: signedIn('a', 'b', 'c'),
    envReader: envSaying('/x/c'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 30), b: snap(5, 30, { weekReset: planBase.now + 3 * DAY }), c: snap(5, 71) },
  });
  assert.equal(decision?.to, 'b');
  assert.equal(decision?.reason, 'b is the first ready account by soonest weekly reset');
});

// Found in review: a week under way must turn over within seven days, so it is spent
// before one that has only begun, even with no reset stated.
test('a week under way with no stated reset is spent before a week that has only begun', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/a'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(0, 0), b: snap(5, 40) },
  });
  assert.equal(decision?.to, 'b');
  assert.equal(decision?.reason, 'b is the first ready account by soonest weekly reset', 'b is not first in the lane order, so the ranking is named');
});

test('with no reset known for any account, lane order decides exactly as it always did', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: signedIn('a', 'b', 'c'),
    envReader: envSaying('/x/c'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 30), b: snap(5, 30), c: snap(5, 30) },
  });
  assert.equal(decision.to, 'a');
  assert.equal(decision.reason, 'a is the first ready account in your lane order');
});

// Found in review: a metered default has no reset, and was treated as a reading that had
// lost one, so recovering subscriptions were reached by way of the top lane.
test('a default parked on a metered lane goes straight to the soonest subscription once one recovers', () => {
  const metered = { ...laneFor('l-m', 'm'), billing: 'metered' };
  const switches = walkPasses({
    registry: { accounts: [acct('a'), acct('m'), acct('b')] },
    lanes: [laneFor('l-a', 'a'), metered, laneFor('l-b', 'b')],
    loginStates: signedIn('a', 'm', 'b'),
    settings: { spendPolicies: { 'l-m': { budget: 25 } } },
    startOn: 'm',
    passes: 4,
    readings: () => ({
      a: snap(5, 30, { weekReset: planBase.now + 5 * DAY }),
      b: snap(5, 30, { weekReset: planBase.now + 2 * DAY }),
    }),
  });
  assert.deepEqual(switches, ['b']);
});

// Found in review: the notification said the target "resets soonest" whenever the order
// differed from lane order, including for a default that was signed out and reset first.
test('a default that had to go is not told the target resets sooner than it does', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: { ...signedIn('a', 'b'), c: { signedIn: false } },
    envReader: envSaying('/x/c'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(5, 30, { weekReset: planBase.now + 6 * DAY }),
      b: snap(5, 30, { weekReset: planBase.now + 2 * DAY }),
      c: snap(5, 30, { weekReset: planBase.now + 1 * DAY }),
    },
  });
  assert.equal(decision.to, 'b');
  assert.equal(decision.reason, 'b is the first ready account by soonest weekly reset');
});

// Found in review: a signed-out account with a readable reading took its tool's first
// place, was skipped there, and the default went to the metered lane in the next place.
test('a signed-out account with the soonest reset never hands the default to a metered lane', () => {
  const metered = { ...laneFor('l-m', 'm'), billing: 'metered' };
  const decisions = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('m'), acct('b')] },
    loginStates: { ...signedIn('a', 'm'), b: { signedIn: false } },
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), metered, laneFor('l-b', 'b')], spendPolicies: { 'l-m': { budget: 20 } }, lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(10, 30, { weekReset: planBase.now + 4 * DAY }),
      b: snap(10, 30, { weekReset: planBase.now + 30 * HOUR }),
    },
  });
  assert.deepEqual(decisions, [], 'a keeps the default: it is the only subscription that can run');
});

test('a reset days away still outranks lane order, but only on "Switch automatically"', () => {
  const state = {
    ...planBase,
    snapshots: {
      a: snap(19, 30, { weekReset: planBase.now + 4 * DAY }),
      b: snap(12, 40, { weekReset: planBase.now + 2 * DAY }),
    },
  };
  const lanes = [laneFor('l-a', 'a'), laneFor('l-b', 'b')];
  const [auto] = planDefaultSwitches({ ...state, settings: { quotaWatch: 'auto', lanes, lastAutoSwitchAt: 0 } });
  assert.equal(auto?.to, 'b');
  assert.deepEqual(planDefaultSwitches({ ...state, settings: { quotaWatch: 'notify', lanes, lastAutoSwitchAt: 0 } }), [],
    'on "Tell me" a person is choosing, so only a reset within the day moves anything');
});

test('two accounts whose weeks end together are settled by lane order', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(5, 30, { weekReset: planBase.now + 3 * DAY }),
      b: snap(5, 30, { weekReset: planBase.now + 3 * DAY }),
    },
  });
  assert.equal(decision.to, 'a');
  assert.equal(decision.reason, "a's weekly quota resets at the same time as b's, and a comes first in your lane order");
});

// Found in review: a tie that a reset decided was put down to lane order alone, which is
// false when a ready account sits higher in the lane order with a later reset.
test('a tie is described as a tie, not as being first in the lane order', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('x'), acct('a'), acct('b')] },
    loginStates: signedIn('x', 'a', 'b'),
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-x', 'x'), laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      x: snap(5, 30, { weekReset: planBase.now + 6 * DAY }),
      a: snap(5, 30, { weekReset: planBase.now + 3 * DAY }),
      b: snap(5, 30, { weekReset: planBase.now + 3 * DAY }),
    },
  });
  assert.equal(decision.to, 'a');
  assert.doesNotMatch(decision.reason, /first ready account in your lane order/, 'x is first in the lane order, and has room');
});

// Two readings of one turnover differ in their last digits, so ranking raw would let each
// pass find the other account "sooner" and trade the default every cooldown.
test('resets a few milliseconds apart do not trade the default back and forth', () => {
  const lanes = [laneFor('l-a', 'a'), laneFor('l-b', 'b')];
  const turnover = Math.round((planBase.now + 3 * DAY) / HOUR) * HOUR;
  let defaultHome = '/x/b';
  let lastAutoSwitchAt = 0;
  const switches = [];
  for (let pass = 0; pass < 8; pass++) {
    const now = planBase.now + pass * (SWITCH_COOLDOWN_MS + 60_000);
    const [early, late] = pass % 2 ? [turnover - 387, turnover - 382] : [turnover - 382, turnover - 387];
    const [decision] = planDefaultSwitches({
      ...planBase,
      now,
      envReader: envSaying(defaultHome),
      settings: { quotaWatch: 'auto', lanes, lastAutoSwitchAt },
      snapshots: { a: snap(5, 30, { weekReset: early }), b: snap(5, 30, { weekReset: late }) },
    });
    if (decision?.kind === 'switch') {
      switches.push(decision.to);
      defaultHome = `/x/${decision.to}`;
      lastAutoSwitchAt = now;
    }
  }
  assert.deepEqual(switches, ['a'], 'one move to the top lane, then it stays');
});

test('a spent default with nowhere roomy to go still takes the soonest reset among those that run', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: signedIn('a', 'b', 'c'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(100, 40, { weekReset: planBase.now + 3 * DAY }),
      b: snap(89, 40, { weekReset: planBase.now + 5 * DAY }),
      c: snap(89, 40, { weekReset: planBase.now + 1 * DAY }),
    },
  });
  assert.equal(decision.to, 'c', 'both are inside the band, so the ranking of all that run decides');
});

test('on "Switch automatically" the reason names accounts by their labels too', () => {
  const registry = { accounts: [
    { id: 'a', provider: 'claude', label: 'Main Account', home: '/x/a' },
    { id: 'b', provider: 'claude', label: 'Secondary', home: '/x/b' },
  ] };
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry,
    settings: { quotaWatch: 'auto', lanes: [laneFor('lane-1789146805336', 'a'), laneFor('lane-1789146805999', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 30, { weekReset: planBase.now + 4 * DAY }), b: snap(5, 30, { weekReset: planBase.now + 2 * DAY }) },
  });
  assert.equal(decision.reason, "Secondary's weekly quota resets sooner than Main Account's, so it is used first");
});

// Found in review: a metered lane is never ranked, so a pick made through one is lane
// order, whatever the account's own subscription reading says about its reset.
test('a switch onto a metered lane is never put down to a reset', () => {
  const metered = { ...laneFor('l-m', 'm'), billing: 'metered' };
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('m')] },
    loginStates: signedIn('a', 'm'),
    settings: { quotaWatch: 'auto', lanes: [metered, laneFor('l-a', 'a')], spendPolicies: { 'l-m': { budget: 25 } }, lastAutoSwitchAt: 0 },
    snapshots: { a: snap(10, 30, { weekReset: planBase.now + 4 * DAY }), m: snap(10, 97, { weekReset: planBase.now + DAY }) },
  });
  assert.equal(decision.to, 'm');
  assert.equal(decision.reason, 'm is the first ready account in your lane order');
});

// Found in review: ranked only among the lanes with room, a lane that dropped out of the
// band took its place with it, so a metered lane behind it moved ahead of every
// subscription and the default went back and forth onto pay-per-use every cooldown.
test('a metered lane never takes the default past a subscription that could', () => {
  const metered = { ...laneFor('l-am', 'a'), billing: 'metered' };
  const switches = walkPasses({
    registry: { accounts: [acct('a'), acct('b')] },
    lanes: [laneFor('l-a', 'a'), metered, laneFor('l-b', 'b')],
    loginStates: signedIn('a', 'b'),
    settings: { spendPolicies: { 'l-am': { budget: 20 } } },
    startOn: 'a',
    passes: 6,
    readings: () => ({
      a: snap(88, 30, { weekReset: planBase.now + 5 * DAY }),
      b: snap(10, 30, { weekReset: planBase.now + 2 * DAY }),
    }),
  });
  assert.deepEqual(switches, ['b'], 'one move to the sooner subscription, and it stays there');
});

// Found in review: ranked on "can run" rather than "can take the default", an account
// inside the dead band took the first place, was passed over for the default, and the
// metered lane in the next place got it while the default itself had room.
test('only an account that could take the default is ranked for it', () => {
  const metered = { ...laneFor('l-m', 'm'), billing: 'metered' };
  const decisions = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('m'), acct('b')] },
    loginStates: signedIn('a', 'm', 'b'),
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), metered, laneFor('l-b', 'b')], spendPolicies: { 'l-m': { budget: 20 } }, lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(88, 30, { weekReset: planBase.now + 1 * DAY }),
      b: snap(10, 30, { weekReset: planBase.now + 3 * DAY }),
    },
  });
  assert.deepEqual(decisions, [], 'a is inside the band, so b keeps the first place and the default');
});

test('a default running low says so, and claims a reset only for a pick the reset decided', () => {
  const metered = { ...laneFor('l-m', 'm'), billing: 'metered' };
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('m')] },
    loginStates: signedIn('a', 'm'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), metered], spendPolicies: { 'l-m': { budget: 20 } }, lastAutoSwitchAt: 0 },
    snapshots: { a: snap(93, 30, { weekReset: planBase.now + 4 * DAY }), m: snap(5, 5, { weekReset: planBase.now + DAY }) },
  });
  assert.equal(decision.to, 'm');
  assert.equal(decision.reason, 'a is close to its limit; m is the first ready account in your lane order');
});

test('a default running low says so first, even when the next account was picked for its reset', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: signedIn('a', 'b', 'c'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-c', 'c'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(92, 30, { weekReset: planBase.now + 4 * DAY }),
      b: snap(5, 30, { weekReset: planBase.now + 2 * DAY }),
      c: snap(5, 30, { weekReset: planBase.now + 5 * DAY }),
    },
  });
  assert.equal(decision.to, 'b');
  assert.equal(decision.reason, 'a is close to its limit; b is next, as its weekly quota resets soonest of the accounts with room');
});

// Found in review: a metered lane with room was counted as an account the ranking had
// passed over, so the move to the only other subscription claimed it reset soonest, which
// read as resetting sooner than the account being left.
test('a metered lane with room is not an account the ranking chose against', () => {
  const metered = { ...laneFor('l-k', 'k'), billing: 'metered' };
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('work'), acct('personal'), acct('k')] },
    loginStates: signedIn('work', 'personal', 'k'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-w', 'work'), laneFor('l-p', 'personal'), metered], spendPolicies: { 'l-k': { budget: 20 } }, lastAutoSwitchAt: 0 },
    envReader: envSaying('/x/work'),
    snapshots: {
      work: snap(91, 30, { weekReset: planBase.now + 8 * 3600_000 }),
      personal: snap(5, 10, { weekReset: planBase.now + 6 * DAY }),
    },
  });
  assert.equal(decision.to, 'personal');
  assert.equal(decision.reason, 'work is close to its limit; personal is the next account with room');
});

// Found in review: a tool with one subscription account has nothing to rank, and the tray
// and the Accounts page say its lane order decides, so the notification must not credit a
// reset for the switch back from its metered lane.
test('a tool with nothing to rank is never told a reset decided its switch', () => {
  const metered = { ...laneFor('l-k', 'k'), billing: 'metered' };
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('c'), acct('k')] },
    loginStates: signedIn('c', 'k'),
    envReader: envSaying('/x/k'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-c', 'c'), metered], spendPolicies: { 'l-k': { budget: 20 } }, lastAutoSwitchAt: 0 },
    snapshots: { c: snap(10, 30, { weekReset: planBase.now + 3 * DAY }) },
  });
  assert.equal(decision.to, 'c');
  assert.equal(decision.reason, 'c is the first ready account in your lane order');
});

// Found in review: the account holding the default is usually the one resetting soonest,
// which is why it holds it, so when it runs low the one taking over resets later. Saying
// the new one "resets soonest" read as a comparison with the account being left.
test('a soonest-resetting default that runs low is not told the next account resets sooner', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('work'), acct('personal')] },
    loginStates: signedIn('work', 'personal'),
    envReader: envSaying('/x/work'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-work', 'work'), laneFor('l-personal', 'personal')], lastAutoSwitchAt: 0 },
    snapshots: {
      work: snap(91, 30, { weekReset: planBase.now + 8 * HOUR }),
      personal: snap(5, 10, { weekReset: planBase.now + 6 * DAY }),
    },
  });
  assert.equal(decision.to, 'personal');
  assert.equal(decision.reason, 'work is close to its limit; personal is the next account with room');
});

// ---- A choice made by hand, and what the watch says about it ----

// The premise behind withholding "Switch to this": with lanes and the watch switching
// automatically, an account picked by hand is put back at the very next pass. If this
// ever stops being true, the button should come back, and this test is what says so.
test('an account picked by hand while the default follows the lanes is switched straight back', () => {
  const lanes = [laneFor('l-a', 'a'), laneFor('l-b', 'b')];
  assert.equal(defaultFollowsLanes({ quotaWatch: 'auto', lanes }, 'claude'), true);
  for (const [what, snapshots] of [
    ['no reset known for either', { a: snap(3, 20), b: snap(8, 82) }],
    ['the first in the order resets sooner', { a: snap(3, 20, { weekReset: planBase.now + 2 * DAY }), b: snap(8, 82, { weekReset: planBase.now + 5 * DAY }) }],
  ]) {
    const [decision] = planDefaultSwitches({
      ...planBase,
      envReader: envSaying('/x/b'), // the hand-picked account
      settings: { quotaWatch: 'auto', lanes, lastAutoSwitchAt: 0 },
      snapshots,
    });
    assert.equal(decision?.kind, 'switch', what);
    assert.equal(decision?.to, 'a', what);
  }
});

test('the reason names accounts the way the rest of the app does, never a lane id', () => {
  const registry = { accounts: [
    { id: 'a', provider: 'claude', label: 'Main Account', home: '/x/a' },
    { id: 'b', provider: 'claude', label: 'Secondary', home: '/x/b' },
  ] };
  const lanes = [laneFor('lane-1789146805336', 'a'), laneFor('lane-1789146805999', 'b')];

  const [back] = planDefaultSwitches({
    ...planBase,
    registry,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'notify', lanes, lastAutoSwitchAt: 0 },
    snapshots: { a: snap(3, 0), b: snap(8, 82) },
  });
  assert.equal(back.reason, 'Main Account is the first ready account in your lane order');

  const [away] = planDefaultSwitches({
    ...planBase,
    registry,
    settings: { quotaWatch: 'notify', lanes, lastAutoSwitchAt: 0 },
    snapshots: { a: snap(92, 10), b: snap(8, 20) },
  });
  assert.equal(away.reason, 'Main Account is close to its limit; Secondary is the first ready account in your lane order');

  const [spend] = planDefaultSwitches({
    ...planBase,
    registry,
    settings: { quotaWatch: 'notify', lanes, lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
    },
  });
  assert.equal(spend.reason, 'Secondary has unused quota that expires soon; spending it down before Main Account');
  for (const d of [back, away, spend]) assert.doesNotMatch(d.reason, /lane-\d/);
});

// "Tell me" repeated its suggestion on every five-minute pass for as long as the default
// sat off the first lane, which could be all day, and that is a state somebody who chose
// "Tell me" over "Switch automatically" may have picked on purpose.
const suggestion = (from = 'b', to = 'a') => ({ kind: 'suggest', provider: 'claude', from, to, reason: 'r' });

test('an unchanged suggestion is said once, not on every pass', () => {
  const active = { claude: 'b' };
  let memory = {};
  const said = [];
  for (let pass = 0; pass < 12; pass++) {
    const d = suggestion();
    const result = freshNotices([d], memory, active);
    memory = result.memory;
    said.push(result.notices.length);
  }
  assert.deepEqual(said, [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 'an hour of passes, one notification');
});

test('a pass with nothing to say forgets nothing, so a reading that failed once does not repeat it', () => {
  const active = { claude: 'b' };
  let { memory } = freshNotices([suggestion()], {}, active);
  ({ memory } = freshNotices([], memory, active));
  assert.equal(freshNotices([suggestion()], memory, active).notices.length, 0);
});

test('a different suggestion is news, and so is the same one after the account has moved', () => {
  let { memory } = freshNotices([suggestion('b', 'a')], {}, { claude: 'b' });
  assert.equal(freshNotices([suggestion('b', 'c')], memory, { claude: 'b' }).notices.length, 1, 'somewhere else to go');

  ({ memory } = freshNotices([], memory, { claude: 'a' })); // switched, by hand or from the notification
  ({ memory } = freshNotices([], memory, { claude: 'b' })); // and back again later
  assert.equal(freshNotices([suggestion('b', 'a')], memory, { claude: 'b' }).notices.length, 1, 'coming back to it is said again');
});

test('running out is said once for each time it ends, and a switch is always reported', () => {
  const active = { claude: 'a' };
  const out = (resetsAt) => ({ kind: 'exhausted', provider: 'claude', resetsAt });
  let { notices, memory } = freshNotices([out(5_000)], {}, active);
  assert.equal(notices.length, 1);
  ({ notices, memory } = freshNotices([out(5_000)], memory, active));
  assert.equal(notices.length, 0);
  ({ notices, memory } = freshNotices([out(9_000)], memory, active));
  assert.equal(notices.length, 1, 'a later end is a new state of affairs');

  const pass = freshNotices([{ kind: 'switch', provider: 'claude', from: 'a', to: 'b' }, { kind: 'pin-blocked', provider: 'claude' }], memory, active);
  assert.deepEqual(pass.notices, [], 'switches and the override alarm are not remembered here; the tray reports them itself');
});

test('what was said about one tool never silences another', () => {
  const active = { claude: 'b', codex: 'y' };
  let { memory } = freshNotices([suggestion('b', 'a')], {}, active);
  const codex = { kind: 'suggest', provider: 'codex', from: 'b', to: 'a', reason: 'r' };
  assert.equal(freshNotices([codex], memory, active).notices.length, 1);
});
