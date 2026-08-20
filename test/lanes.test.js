import test from 'node:test';
import assert from 'node:assert/strict';
import { laneStatus, selectLane } from '../core/lanes.js';

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

test('laneStatus reports unknown for unreadable quota', () => {
  const lane = makeLane('l1', 'a1');
  const ctx = {
    now: 1000,
    loginStates: { a1: { signedIn: true } },
    quotas: { a1: { error: 'fetch failed' } },
  };
  const stat = laneStatus(lane, ctx);
  assert.equal(stat.status, 'unknown');
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
