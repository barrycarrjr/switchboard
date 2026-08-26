import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addLane,
  buildLane,
  laneProblem,
  nextLaneId,
  removeLane,
  reorderLanes,
  setLaneBudget,
  unknownLaneIds,
  vendorForHarness,
  BILLING_KINDS,
} from '../core/lane-admin.js';

const accounts = [
  { id: 'claude-work', provider: 'claude', label: 'Work', home: 'X:\\p\\.claude-work' },
  { id: 'codex-main', provider: 'codex', label: 'Main', home: 'X:\\p\\.codex' },
  { id: 'qwen-main', provider: 'qwen', label: 'Qwen', home: 'X:\\p\\.qwen' },
];

const settingsWith = (lanes = [], extra = {}) => ({ lanes, spendPolicies: {}, cooldowns: {}, ...extra });

test('vendorForHarness names the vendor behind each harness', () => {
  assert.equal(vendorForHarness('claude'), 'anthropic');
  assert.equal(vendorForHarness('codex'), 'openai');
  assert.equal(vendorForHarness('gemini'), 'google');
});

test('a harness with no separate vendor name answers to its own', () => {
  assert.equal(vendorForHarness('qwen'), 'qwen');
});

test('laneProblem refuses an account that is not registered', () => {
  const problem = laneProblem({ accountId: 'nope', billing: 'subscription' }, accounts, []);
  assert.match(problem, /no registered account/);
});

test('laneProblem refuses billing it does not recognise', () => {
  const problem = laneProblem({ accountId: 'claude-work', billing: 'free' }, accounts, []);
  assert.match(problem, /billing must be one of/);
  for (const kind of BILLING_KINDS) {
    assert.equal(laneProblem({ accountId: 'claude-work', billing: kind }, accounts, []), null);
  }
});

test('laneProblem refuses a second lane that could never be selected', () => {
  const existing = [buildLane(accounts[0], 'subscription', 'lane-1')];
  const problem = laneProblem({ accountId: 'claude-work', billing: 'subscription' }, accounts, existing);
  assert.match(problem, /already exists/);
});

test('the same account on different billing is a real second lane', () => {
  const existing = [buildLane(accounts[0], 'subscription', 'lane-1')];
  assert.equal(laneProblem({ accountId: 'claude-work', billing: 'metered' }, accounts, existing), null);
});

test('addLane appends at the lowest priority and fills in harness and vendor', () => {
  const first = addLane(settingsWith(), { accountId: 'claude-work' }, accounts, 1000);
  const second = addLane(first.settings, { accountId: 'codex-main' }, accounts, 2000);

  assert.deepEqual(second.settings.lanes.map((l) => l.id), ['lane-1000', 'lane-2000']);
  assert.deepEqual(first.lane, {
    id: 'lane-1000',
    harness: 'claude',
    provider: 'anthropic',
    accountId: 'claude-work',
    billing: 'subscription',
    capabilities: ['chat'],
  });
});

test('addLane leaves the settings it was given untouched', () => {
  const before = settingsWith();
  addLane(before, { accountId: 'claude-work' }, accounts, 1000);
  assert.equal(before.lanes.length, 0);
});

test('addLane throws what laneProblem says', () => {
  assert.throws(
    () => addLane(settingsWith(), { accountId: 'nope' }, accounts, 1000),
    /no registered account/,
  );
});

test('removeLane also drops the budget and cooldown filed under that id', () => {
  const settings = settingsWith(
    [buildLane(accounts[0], 'metered', 'lane-1'), buildLane(accounts[1], 'subscription', 'lane-2')],
    { spendPolicies: { 'lane-1': { budget: 5 } }, cooldowns: { 'lane-1': 999 } },
  );
  const next = removeLane(settings, 'lane-1');

  assert.deepEqual(next.lanes.map((l) => l.id), ['lane-2']);
  assert.deepEqual(next.spendPolicies, {});
  assert.deepEqual(next.cooldowns, {});
});

test('removeLane refuses an id that names no lane', () => {
  assert.throws(() => removeLane(settingsWith(), 'lane-nope'), /no lane with id/);
});

test('reorderLanes keeps lanes left out of the list, at the end', () => {
  const settings = settingsWith([
    buildLane(accounts[0], 'subscription', 'lane-1'),
    buildLane(accounts[1], 'subscription', 'lane-2'),
    buildLane(accounts[2], 'subscription', 'lane-3'),
  ]);
  const next = reorderLanes(settings, ['lane-3', 'lane-1']);
  assert.deepEqual(next.lanes.map((l) => l.id), ['lane-3', 'lane-1', 'lane-2']);
});

test('reorderLanes ignores an id repeated in the list', () => {
  const settings = settingsWith([
    buildLane(accounts[0], 'subscription', 'lane-1'),
    buildLane(accounts[1], 'subscription', 'lane-2'),
  ]);
  const next = reorderLanes(settings, ['lane-2', 'lane-2']);
  assert.deepEqual(next.lanes.map((l) => l.id), ['lane-2', 'lane-1']);
});

test('unknownLaneIds names only the ids that match nothing', () => {
  const settings = settingsWith([buildLane(accounts[0], 'subscription', 'lane-1')]);
  assert.deepEqual(unknownLaneIds(settings, ['lane-1', 'lane-9']), ['lane-9']);
  assert.deepEqual(unknownLaneIds(settings, ['lane-1']), []);
});

test('setLaneBudget stores a number and clears on null', () => {
  const settings = settingsWith([buildLane(accounts[0], 'metered', 'lane-1')]);
  const set = setLaneBudget(settings, 'lane-1', '25');
  assert.deepEqual(set.spendPolicies['lane-1'], { budget: 25 });
  assert.deepEqual(setLaneBudget(set, 'lane-1', null).spendPolicies, {});
});

test('setLaneBudget refuses an amount that would block the lane while looking like a cap', () => {
  const settings = settingsWith([buildLane(accounts[0], 'metered', 'lane-1')]);
  assert.throws(() => setLaneBudget(settings, 'lane-1', 0), /greater than zero/);
  assert.throws(() => setLaneBudget(settings, 'lane-1', 'lots'), /greater than zero/);
});

test('setLaneBudget refuses an id that names no lane', () => {
  assert.throws(() => setLaneBudget(settingsWith(), 'lane-nope', 5), /no lane with id/);
});

test('nextLaneId keeps the shape the app has always written', () => {
  assert.equal(nextLaneId(1787257314471), 'lane-1787257314471');
});
