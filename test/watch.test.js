import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideDefaultSwitch, isSpent, planDefaultSwitches, SWITCH_COOLDOWN_MS } from '../core/watch.js';

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

test('a target inside the dead band is not somewhere to send the default', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(88, 10) } });
  assert.equal(d.kind, 'exhausted', 'a few points better than the account it would replace is not room to spare');
});

test('a target that has dropped clear of the band is', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 62), b: snap(86, 10) } });
  assert.equal(d.kind, 'switch');
  assert.equal(d.to, 'b');
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
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: {
      quotaWatch: 'auto',
      lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')],
      lastAutoSwitchAt: planBase.now - (SWITCH_COOLDOWN_MS - 1),
    },
    snapshots: { a: snap(5, 10), b: snap(5, 10) },
  });
  assert.deepEqual(decisions, []);
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
  const [decision] = planDefaultSwitches({
    ...planBase,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(100, 20), b: snap(93, 10) },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'b');
});

// Spend-down. A weekly window is use-it-or-lose-it: quota unspent at the turnover is
// forfeited. So an account whose week ends within a day and still has room takes the
// default even while the active account is perfectly healthy. In a lane pool the
// default comes back on its own, because lane order resumes once the window resets and
// stops qualifying; without lanes there is no preferred account to come back to, and
// the default stays where the last switch put it, as after every other switch.

const HOUR = 60 * 60 * 1000;

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
  const [decision, ...rest] = planDefaultSwitches({
    ...planBase,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
    },
  });
  assert.equal(rest.length, 0);
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'b');
  assert.match(decision.reason, /expires soon/);
});

test('the detour undoes itself: after the reset, lane priority takes the default back', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(0, 0, { weekReset: planBase.now + 7 * 24 * HOUR }),
    },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'a');
  assert.match(decision.reason, /Lane priority/);
});

test('an expiring lane already holding the default is left alone', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
    },
  });
  assert.deepEqual(decisions, []);
});

// A lane parked on the default by an earlier spend-down keeps counting as expiring while
// it drifts into the band. Judged on winning the default instead of keeping it, it would
// drop out of the expiring list mid-window and the top lane would take the default back
// early, which is the round trip the detour exists to avoid.
test('a spend-down lane holding the default keeps it while it drifts into the band', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(88, 67, { weekReset: planBase.now + 6 * HOUR }),
    },
  });
  assert.deepEqual(decisions, []);
});

// The default sits ON the expiring-but-unavailable lane in these two, so falling
// through to the ordinary order produces a visible switch to the top lane. With the
// default elsewhere, "fell through" and "selected nothing" would both read as [].
test('an expiring lane that is signed out falls through to the ordinary order', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    loginStates: { a: { signedIn: true }, b: { signedIn: false } },
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
    },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'a');
  assert.match(decision.reason, /Lane priority/);
});

test('an expiring lane on cooldown falls through to the ordinary order', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: {
      quotaWatch: 'auto',
      lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')],
      cooldowns: { 'l-b': planBase.now + 2 * HOUR },
      lastAutoSwitchAt: 0,
    },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
    },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'a');
  assert.match(decision.reason, /Lane priority/);
});

test('the soonest-expiring lane heads the queue when several qualify', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: signedIn('a', 'b', 'c'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(5, 40, { weekReset: planBase.now + 20 * HOUR }),
      c: snap(5, 10, { weekReset: planBase.now + 2 * HOUR }),
    },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'c');
  assert.match(decision.reason, /expires soon/);
});

// Anti-flap: the failed read is the absence of a reading, not a reading. Acting on it
// made every blip a round trip, out on the error and back on the recovery, once per
// cooldown for as long as the endpoint stayed flaky.
test('a default whose meter merely failed to read is not moved', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(5, 10),
      b: { error: 'unavailable' },
    },
  });
  assert.deepEqual(decisions, []);
});

// The other absence channel: the sign-in state can fail to read (the credentials file
// is briefly unparseable during the CLI's own token refresh). That is a blip, not a
// state, and moving the default on it made the same round trip as a quota blip.
test('a default whose sign-in state failed to read is not moved either', () => {
  const decisions = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    loginStates: { a: { signedIn: true }, b: { signedIn: null } },
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(6, 11) },
  });
  assert.deepEqual(decisions, []);
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
  assert.match(decision.reason, /Lane priority/);
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
  const decisions = planDefaultSwitches({
    ...planBase,
    pinPresent: true,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
      b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
    },
  });
  assert.deepEqual(decisions, []);
});

test('a pin still alarms when the default is genuinely running low', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    pinPresent: true,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(92, 40),
      b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
    },
  });
  assert.equal(decision.kind, 'pin-blocked');
  assert.equal(decision.spent, false);
});

// The alarm asks whether the pin blocked something that was going to happen anyway,
// which is not the same question as whether this switch is a spend-down. With the
// default on neither the top lane nor the expiring one, a lane-priority switch was
// independently wanted and blocked, and reading the switch as a spend-down silenced
// that alarm for the whole expiring day.
test('a pin still alarms when lane priority wanted a switch of its own', () => {
  const withExpiring = (weekReset) => planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: signedIn('a', 'b', 'c'),
    envReader: envSaying('/x/c'),
    pinPresent: true,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(12, 67, { weekReset }), c: snap(6, 20) },
  });
  // Without the expiring lane this state alarms; adding one must not change that.
  assert.equal(withExpiring(planBase.now + 96 * HOUR)[0]?.kind, 'pin-blocked');
  assert.equal(withExpiring(planBase.now + 6 * HOUR)[0]?.kind, 'pin-blocked');
});

test('a pin alarms for a signed-out default even while a lane is expiring', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    registry: { accounts: [acct('a'), acct('b'), acct('c')] },
    loginStates: { ...signedIn('a', 'b'), c: { signedIn: false } },
    envReader: envSaying('/x/c'),
    pinPresent: true,
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b'), laneFor('l-c', 'c')], lastAutoSwitchAt: 0 },
    snapshots: { a: snap(5, 10), b: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }), c: { error: 'no-credentials' } },
  });
  assert.equal(decision.kind, 'pin-blocked');
});

// The top lane happening to be the expiring one is not a spend-down: lane order wanted
// that switch anyway, so it keeps its ordinary reason (and, under a pin, its alarm).
test('a switch lane order wanted anyway is not called a spend-down', () => {
  const [decision] = planDefaultSwitches({
    ...planBase,
    envReader: envSaying('/x/b'),
    settings: { quotaWatch: 'auto', lanes: [laneFor('l-a', 'a'), laneFor('l-b', 'b')], lastAutoSwitchAt: 0 },
    snapshots: {
      a: snap(12, 67, { weekReset: planBase.now + 6 * HOUR }),
      b: snap(19, 71, { weekReset: planBase.now + 96 * HOUR }),
    },
  });
  assert.equal(decision.kind, 'switch');
  assert.equal(decision.to, 'a');
  assert.match(decision.reason, /Lane priority/);
});

test('a metered lane has nothing that expires', () => {
  const metered = { ...laneFor('l-b', 'b'), billing: 'metered' };
  const decisions = planDefaultSwitches({
    ...planBase,
    settings: {
      quotaWatch: 'auto',
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
  assert.deepEqual(decisions, []);
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
