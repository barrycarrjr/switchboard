import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_THRESHOLDS,
  normalizeThresholds,
  formatNotificationText,
  buildNotificationPayload,
  checkThresholds,
  dispatchNotification,
} from '../core/hooks.js';
import { parseNotifyArgs } from '../core/runargs.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { tempDir } from '../test-support/tempdir.js';

test('normalizeThresholds handles defaults, valid inputs, and sanitization', () => {
  assert.deepEqual(normalizeThresholds(), DEFAULT_THRESHOLDS);
  assert.deepEqual(normalizeThresholds(null), DEFAULT_THRESHOLDS);
  assert.deepEqual(normalizeThresholds({}), DEFAULT_THRESHOLDS);

  const custom = normalizeThresholds({ session: 75, week: 90 });
  assert.deepEqual(custom, { session: 75, week: 90 });

  // Out of bounds / invalid values fall back to defaults
  const sanitized = normalizeThresholds({ session: 150, week: -5, other: 'ignored' });
  assert.deepEqual(sanitized, { session: 80, week: 85 });

  // Partial override
  const partial = normalizeThresholds({ session: 60 });
  assert.deepEqual(partial, { session: 60, week: 85 });
});

test('buildNotificationPayload includes text for Slack and structured fields', () => {
  const event = {
    kind: 'threshold',
    event: 'usage_threshold_crossed',
    provider: 'claude',
    accountId: 'acc1',
    accountLabel: 'Work',
    window: 'session',
    windowLabel: 'Session (5h)',
    usedPercent: 82,
    threshold: 80,
    resetsAt: 1700000000000,
  };

  const payload = buildNotificationPayload(event, 1699990000000);
  assert.ok(payload.text.includes('Work (claude) reached 82% of Session (5h)'));
  assert.ok(payload.text.includes('threshold: 80%'));
  assert.equal(payload.content, payload.text); // Discord compatibility
  assert.equal(payload.event, 'usage_threshold_crossed');
  assert.equal(payload.provider, 'claude');
  assert.equal(payload.accountLabel, 'Work');
  assert.equal(payload.usedPercent, 82);
  assert.equal(payload.threshold, 80);
});

test('formatNotificationText renders different notification events cleanly', () => {
  const switchEvent = {
    kind: 'switch',
    event: 'default_switched',
    provider: 'claude',
    to: 'acc2',
    reason: 'Account acc1 reached 100% of weekly limit',
  };
  const switchText = formatNotificationText(switchEvent);
  assert.ok(switchText.includes('[Switchboard] Switched default claude:'));
  assert.ok(switchText.includes('Account acc1 reached 100% of weekly limit'));

  const exhaustedEvent = {
    kind: 'exhausted',
    event: 'quota_exhausted',
    provider: 'claude',
    resetsAt: 1700000000000,
  };
  const exhaustedText = formatNotificationText(exhaustedEvent);
  assert.ok(exhaustedText.includes('[Switchboard] Quota exhausted: no claude account has room'));

  const testEvent = {
    kind: 'test',
    event: 'test_notification',
    provider: 'claude',
    accountLabel: 'Test',
    windowLabel: 'Session (5h)',
    usedPercent: 80,
    threshold: 80,
  };
  const testText = formatNotificationText(testEvent);
  assert.ok(testText.includes('[Switchboard] Test alert: notification hooks are configured and working'));
});

test('checkThresholds fires on crossing and suppresses duplicate alerts within same window', () => {
  const accounts = [
    { id: 'acc1', provider: 'claude', label: 'Primary' },
    { id: 'acc2', provider: 'claude', label: 'Secondary' },
  ];

  const now = 1000000;
  const resetTime = now + 3600000;

  const snapshots = {
    acc1: {
      windows: [
        { key: 'session', label: 'Session (5h)', usedPercent: 82, resetsAt: resetTime },
        { key: 'week', label: 'Week (all models)', usedPercent: 50, resetsAt: resetTime + 86400000 },
      ],
    },
    acc2: {
      windows: [
        { key: 'session', label: 'Session (5h)', usedPercent: 40, resetsAt: resetTime },
      ],
    },
  };

  // First pass: acc1 session crosses 80% threshold
  const { events: firstEvents, memory: mem1 } = checkThresholds({
    accounts,
    snapshots,
    thresholds: { session: 80, week: 85 },
    memory: {},
    now,
  });

  assert.equal(firstEvents.length, 1);
  assert.equal(firstEvents[0].accountId, 'acc1');
  assert.equal(firstEvents[0].window, 'session');
  assert.equal(firstEvents[0].usedPercent, 82);
  assert.equal(firstEvents[0].threshold, 80);

  // Second pass with same or slightly higher usage in same reset window: debounced, no new alert
  const snapshots2 = {
    acc1: {
      windows: [
        { key: 'session', label: 'Session (5h)', usedPercent: 84, resetsAt: resetTime },
        { key: 'week', label: 'Week (all models)', usedPercent: 50, resetsAt: resetTime + 86400000 },
      ],
    },
  };

  const { events: secondEvents, memory: mem2 } = checkThresholds({
    accounts,
    snapshots: snapshots2,
    thresholds: { session: 80, week: 85 },
    memory: mem1,
    now: now + 300000,
  });

  assert.equal(secondEvents.length, 0);

  // Third pass: usage dropped below threshold (e.g. after turnover or correction), clearing memory
  const snapshots3 = {
    acc1: {
      windows: [
        { key: 'session', label: 'Session (5h)', usedPercent: 10, resetsAt: resetTime },
      ],
    },
  };

  const { events: thirdEvents, memory: mem3 } = checkThresholds({
    accounts,
    snapshots: snapshots3,
    thresholds: { session: 80, week: 85 },
    memory: mem2,
    now: now + 600000,
  });

  assert.equal(thirdEvents.length, 0);
  assert.equal(mem3['acc1:session'], undefined);

  // Fourth pass: usage crosses threshold again -> fires new alert
  const snapshots4 = {
    acc1: {
      windows: [
        { key: 'session', label: 'Session (5h)', usedPercent: 88, resetsAt: resetTime + 7200000 },
      ],
    },
  };

  const { events: fourthEvents } = checkThresholds({
    accounts,
    snapshots: snapshots4,
    thresholds: { session: 80, week: 85 },
    memory: mem3,
    now: now + 900000,
  });

  assert.equal(fourthEvents.length, 1);
  assert.equal(fourthEvents[0].usedPercent, 88);
});

test('checkThresholds alerts on new reset window even if memory was set', () => {
  const accounts = [{ id: 'acc1', provider: 'claude', label: 'Primary' }];
  const initialReset = 2000000;
  const memory = {
    'acc1:session': { alertKey: initialReset, alertedAt: 1000000 },
  };

  // Next reset turnover
  const nextReset = 5000000;
  const snapshots = {
    acc1: {
      windows: [
        { key: 'session', label: 'Session (5h)', usedPercent: 85, resetsAt: nextReset },
      ],
    },
  };

  const { events } = checkThresholds({
    accounts,
    snapshots,
    thresholds: { session: 80, week: 85 },
    memory,
    now: 3000000,
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].resetsAt, nextReset);
});

test('dispatchNotification posts to webhook and executes command hook safely', async () => {
  const sentRequests = [];
  const fakeFetch = async (url, options) => {
    sentRequests.push({ url, options });
    return { ok: true, status: 200, text: async () => 'ok' };
  };

  const spawned = [];
  const fakeSpawn = (cmd, args, opts) => {
    spawned.push({ cmd, args, opts });
    const dummyChild = {
      stdin: {
        write: (data) => { spawned[spawned.length - 1].stdinData = data; },
        end: () => {},
      },
      on: (ev, handler) => {
        if (ev === 'close') setTimeout(() => handler(0), 10);
      },
    };
    return dummyChild;
  };

  const settings = {
    notifyWebhookUrl: 'https://example.com/webhook',
    notifyCommand: 'custom-alert-cmd',
  };

  const payload = { text: 'alert test', usedPercent: 85 };
  const res = await dispatchNotification(settings, payload, {
    fetchImpl: fakeFetch,
    spawnImpl: fakeSpawn,
  });

  assert.equal(res.webhook?.ok, true);
  assert.equal(res.command?.ok, true);
  assert.equal(sentRequests.length, 1);
  assert.equal(sentRequests[0].url, 'https://example.com/webhook');
  assert.equal(sentRequests[0].options.method, 'POST');
  assert.equal(JSON.parse(sentRequests[0].options.body).text, 'alert test');

  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].opts.env.SWITCHBOARD_EVENT, JSON.stringify(payload));
  assert.equal(spawned[0].stdinData, JSON.stringify(payload));
});

test('dispatchNotification fails gracefully on network errors without throwing', async () => {
  const failingFetch = async () => {
    throw new Error('network down');
  };

  const settings = {
    notifyWebhookUrl: 'https://example.com/bad',
  };

  const res = await dispatchNotification(settings, { text: 'test' }, { fetchImpl: failingFetch });
  assert.equal(res.webhook?.ok, false);
  assert.ok(res.webhook?.error.includes('network down'));
});

test('parseNotifyArgs parses webhook, command, thresholds, test and json flags', () => {
  const args1 = parseNotifyArgs(['--webhook', 'https://hooks.slack.com/services/xxx', '--command', 'notify.bat', '--threshold', 'session=75', '--threshold', 'week=90', '--test', '--json']);
  assert.equal(args1.webhook, 'https://hooks.slack.com/services/xxx');
  assert.equal(args1.command, 'notify.bat');
  assert.deepEqual(args1.thresholds, { session: 75, week: 90 });
  assert.equal(args1.test, true);
  assert.equal(args1.json, true);

  // Clearing webhook and command
  const args2 = parseNotifyArgs(['--webhook', 'none', '--command', 'none']);
  assert.equal(args2.webhook, 'none');
  assert.equal(args2.command, 'none');

  // Error cases
  assert.throws(() => parseNotifyArgs(['--threshold', 'invalid']), /Use <window>=<percent>/i);
  assert.throws(() => parseNotifyArgs(['--threshold', 'session=150']), /between 1 and 100/);
  assert.throws(() => parseNotifyArgs(['--webhook']), /--webhook needs a URL/);
  assert.throws(() => parseNotifyArgs(['--webhook', 'ftp://invalid']), /http: or https:/);
});

test('settings persists notify settings and normalizes thresholds', () => {
  const dir = tempDir('sb-hook-');
  const file = `${dir}/settings.json`;

  const s1 = loadSettings(file);
  assert.equal(s1.notifyWebhookUrl, null);
  assert.equal(s1.notifyCommand, null);
  assert.deepEqual(s1.thresholds, { session: 80, week: 85 });

  s1.notifyWebhookUrl = 'https://hooks.slack.com/services/test';
  s1.notifyCommand = 'python notify.py';
  s1.thresholds = { session: 70, week: 88 };
  saveSettings(s1, file);

  const s2 = loadSettings(file);
  assert.equal(s2.notifyWebhookUrl, 'https://hooks.slack.com/services/test');
  assert.equal(s2.notifyCommand, 'python notify.py');
  assert.deepEqual(s2.thresholds, { session: 70, week: 88 });
});
