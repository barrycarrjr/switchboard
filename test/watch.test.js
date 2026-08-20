import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideDefaultSwitch, isSpent, SWITCH_COOLDOWN_MS } from '../core/watch.js';

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

test('exhausted reports the latest known reset of the spent windows', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', snapshots: { a: snap(100, 100, { sessionReset: base.now + 5000, weekReset: base.now + 9000 }), b: snap(10, 99) } });
  assert.equal(d.kind, 'exhausted');
  assert.equal(d.resetsAt, base.now + 9000);
});

test('the pin blocks switching and says so', () => {
  const d = decideDefaultSwitch({ ...base, mode: 'auto', pinPresent: true, snapshots: { a: snap(100, 62), b: snap(5, 10) } });
  assert.equal(d.kind, 'pin-blocked');
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
