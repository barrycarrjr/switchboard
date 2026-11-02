import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { resetVaultDriver } from '../core/vault.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import {
  chooseProvisionKey,
  classifyRemoteAddress,
  createGatewayKey,
  DEFAULT_PROVISION_LABEL,
  detectGatewayHostIp,
  gatewayEnabledSettings,
  ipAllowedByScope,
  listGatewayKeys,
  normalizeGatewayPort,
  normalizeGatewayScope,
  recordGatewayKeyUse,
  revokeGatewayKey,
  updateGatewayKey,
  verifyGatewayKey,
} from '../core/gateway-keys.js';

test('classifyRemoteAddress and ipAllowedByScope enforce strict socket CIDR rules', () => {
  assert.equal(classifyRemoteAddress('127.0.0.1'), 'localhost');
  assert.equal(classifyRemoteAddress('::1'), 'localhost');
  assert.equal(classifyRemoteAddress('::ffff:127.0.0.1'), 'localhost');
  assert.equal(classifyRemoteAddress('172.24.112.1'), 'wsl');
  assert.equal(classifyRemoteAddress('::ffff:172.19.0.2'), 'wsl');
  assert.equal(classifyRemoteAddress('192.168.1.50'), 'lan');
  assert.equal(classifyRemoteAddress('10.0.4.12'), 'lan');
  assert.equal(classifyRemoteAddress('100.88.1.2'), 'lan');
  assert.equal(classifyRemoteAddress('8.8.8.8'), null);

  assert.equal(ipAllowedByScope('127.0.0.1', 'localhost'), true);
  assert.equal(ipAllowedByScope('172.24.112.1', 'localhost'), false);
  assert.equal(ipAllowedByScope('172.24.112.1', 'localhost-wsl'), true);
  assert.equal(ipAllowedByScope('192.168.1.50', 'localhost-wsl'), false);
  assert.equal(ipAllowedByScope('192.168.1.50', 'lan'), true);
  assert.equal(ipAllowedByScope('8.8.8.8', 'lan'), false);
});

test('createGatewayKey, listGatewayKeys, verifyGatewayKey, and revokeGatewayKey work end-to-end', () => {
  let settings = { gateway: { enabled: true, port: 8318, scope: 'localhost-wsl' }, gatewayKeys: {} };

  const created = createGatewayKey(settings, { label: 'T3 Code WSL', scope: 'localhost-wsl', now: 1700000000000 });
  settings = created.settings;
  assert.ok(created.secret.startsWith('sb-key-'));
  assert.equal(created.key.id, 't3-code-wsl');
  assert.equal(created.key.label, 'T3 Code WSL');
  assert.equal(created.key.token, undefined, 'public key metadata never includes raw secret');
  assert.ok(created.key.hint.startsWith('sb-key-'));

  const list = listGatewayKeys(settings, 1700000000000);
  assert.equal(list.length, 1);
  assert.equal(list[0].token, undefined);

  // Valid key from WSL subnet succeeds
  const okWsl = verifyGatewayKey(settings, created.secret, '::ffff:172.20.10.5');
  assert.equal(okWsl.ok, true);
  assert.equal(okWsl.key.id, 't3-code-wsl');

  // Valid key from LAN subnet is rejected when gateway scope is localhost-wsl
  const blockedLan = verifyGatewayKey(settings, created.secret, '192.168.1.25');
  assert.equal(blockedLan.ok, false);
  assert.equal(blockedLan.status, 403);
  assert.equal(blockedLan.reason, 'ip-outside-gateway-scope');

  // Wrong key is rejected with 401
  const badKey = verifyGatewayKey(settings, 'sb-key-wrong', '127.0.0.1');
  assert.equal(badKey.ok, false);
  assert.equal(badKey.status, 401);

  // Record usage
  settings = recordGatewayKeyUse(settings, 't3-code-wsl', {
    accountId: 'claude-a',
    laneId: 'lane-1',
    now: 1700000005000,
  });
  const afterUse = listGatewayKeys(settings, 1700000005000)[0];
  assert.equal(afterUse.requestsToday, 1);
  assert.equal(afterUse.lastAccountId, 'claude-a');
  assert.equal(afterUse.lastLaneId, 'lane-1');

  // Revoke key
  settings = revokeGatewayKey(settings, 't3-code-wsl');
  assert.equal(listGatewayKeys(settings).length, 0);
  const afterRevoke = verifyGatewayKey(settings, created.secret, '127.0.0.1');
  assert.equal(afterRevoke.ok, false);
  assert.equal(afterRevoke.status, 401);
});

test('gatewayKeys tokens are encrypted at rest in settings.json via vault', () => {
  resetVaultDriver();
  const dir = tempDir('sb-gw-');
  const file = path.join(dir, 'settings.json');

  const initial = loadSettings(file);
  const { settings, secret } = createGatewayKey(initial, { label: 'Ubuntu Worker', scope: 'localhost-wsl' });
  saveSettings(settings, file);

  const onDisk = fs.readFileSync(file, 'utf8');
  assert.ok(!onDisk.includes(secret), 'raw client key secret must never be written in plaintext');
  assert.ok(onDisk.includes('enc:v1:aes-gcm:'), 'client key must be encrypted with AES-GCM on disk');

  const reloaded = loadSettings(file);
  const verified = verifyGatewayKey(reloaded, secret, '127.0.0.1');
  assert.equal(verified.ok, true);
  assert.equal(verified.key.label, 'Ubuntu Worker');
});

test('detectGatewayHostIp and normalizers validate inputs', () => {
  assert.equal(normalizeGatewayScope('localhost-wsl'), 'localhost-wsl');
  assert.throws(() => normalizeGatewayScope('public-internet'));
  assert.equal(normalizeGatewayPort(8318), 8318);
  assert.throws(() => normalizeGatewayPort(80));

  const mockInterfaces = {
    'vEthernet (WSL)': [{ family: 'IPv4', internal: false, address: '172.25.160.1' }],
    'Ethernet': [{ family: 'IPv4', internal: false, address: '192.168.1.99' }],
  };
  assert.equal(detectGatewayHostIp('localhost', mockInterfaces), '127.0.0.1');
  assert.equal(detectGatewayHostIp('localhost-wsl', mockInterfaces), '172.25.160.1');
  assert.equal(detectGatewayHostIp('lan', mockInterfaces), '192.168.1.99');
});

test('gatewayEnabledSettings turns the gateway on and never changes a scope or port someone chose', () => {
  const fresh = gatewayEnabledSettings({});
  assert.equal(fresh.settings.gateway.enabled, true);
  assert.equal(fresh.scope, 'localhost-wsl');
  assert.equal(fresh.fresh, true);
  assert.equal(fresh.wasEnabled, false);

  const lan = gatewayEnabledSettings({ gateway: { enabled: false, scope: 'lan', port: 8400 } });
  assert.equal(lan.settings.gateway.enabled, true);
  assert.equal(lan.settings.gateway.scope, 'lan', 'an existing scope is kept, in either direction');
  assert.equal(lan.settings.gateway.port, 8400);
  assert.equal(lan.fresh, false);

  const on = gatewayEnabledSettings({ gateway: { enabled: true, scope: 'localhost' }, other: 1 });
  assert.equal(on.wasEnabled, true);
  assert.equal(on.settings.gateway.scope, 'localhost');
  assert.equal(on.settings.other, 1, 'the rest of the settings ride along');
});

test('chooseProvisionKey creates a key with the gateway scope when none is stored, else reuses one and gives it that scope', () => {
  const none = chooseProvisionKey({ gateway: { enabled: true, scope: 'lan' } }, { now: 1000 });
  assert.equal(none.created, true);
  assert.equal(none.key.scope, 'lan', 'a new key takes the gateway scope, never a hard-coded one');
  assert.equal(none.key.label, DEFAULT_PROVISION_LABEL);
  assert.match(none.secret, /^sb-key-/);
  assert.equal(none.settings.gatewayKeys[none.key.id].token, none.secret);
  assert.equal(none.scopeChanged, false);

  const labelled = chooseProvisionKey({ gateway: { scope: 'localhost' } }, { label: 'fleet box', now: 1000 });
  assert.equal(labelled.key.label, 'fleet box');
  assert.equal(labelled.key.scope, 'localhost');

  // Stored keys: the label match wins, then the one already on the gateway scope, then
  // the first readable one. A key this machine cannot decrypt is never picked.
  const first = createGatewayKey({ gateway: { scope: 'lan' } }, { label: 'laptop', scope: 'localhost-wsl', now: 1 });
  const second = createGatewayKey(first.settings, { label: 'lan box', scope: 'lan', now: 2 });
  const stored = {
    ...second.settings,
    gatewayKeys: {
      ...second.settings.gatewayKeys,
      broken: { id: 'broken', label: 'old machine', token: 'sb-key-unreadable', unreadable: true, scope: 'lan' },
    },
  };
  const byScope = chooseProvisionKey(stored, { now: 3 });
  assert.equal(byScope.created, false);
  assert.equal(byScope.key.id, second.key.id);
  assert.equal(byScope.scopeChanged, false);
  assert.equal(byScope.secret, second.secret);
  assert.equal(byScope.settings, stored, 'nothing to change, so the same settings object');

  const byLabel = chooseProvisionKey(stored, { label: 'Laptop', now: 3 });
  assert.equal(byLabel.key.id, first.key.id);
  assert.equal(byLabel.scopeChanged, true);
  assert.equal(byLabel.previousScope, 'localhost-wsl');
  assert.equal(byLabel.key.scope, 'lan', 'a reused key is moved onto the gateway scope: a key is checked against its own scope');
  assert.equal(byLabel.settings.gatewayKeys[first.key.id].scope, 'lan');
  assert.equal(byLabel.settings.gatewayKeys[first.key.id].token, first.secret, 'the secret is kept, so installed clients stay valid');
  assert.equal(byLabel.settings.gatewayKeys[second.key.id].scope, 'lan', 'other keys are untouched');

  const onlyUnreadable = chooseProvisionKey({ gateway: { scope: 'lan' }, gatewayKeys: { broken: stored.gatewayKeys.broken } }, { now: 4 });
  assert.equal(onlyUnreadable.created, true, 'an unreadable key cannot be installed, so a new one is made');

  const explicit = chooseProvisionKey(first.settings, { scope: 'localhost-wsl', now: 5 });
  assert.equal(explicit.key.id, first.key.id);
  assert.equal(explicit.scopeChanged, false, 'an explicit scope argument wins over the settings');
});

test('updateGatewayKey updates label and scope in place without rotating secret', () => {
  let settings = { gateway: { enabled: true, port: 8318, scope: 'lan' }, gatewayKeys: {} };

  const created = createGatewayKey(settings, { label: 'Initial Label', scope: 'localhost', now: 1700000000000 });
  settings = created.settings;
  const secret = created.secret;

  // Initially blocked on LAN because key scope is 'localhost'
  const blockedLan = verifyGatewayKey(settings, secret, '192.168.27.50');
  assert.equal(blockedLan.ok, false);
  assert.equal(blockedLan.status, 403);
  assert.equal(blockedLan.reason, 'ip-outside-key-scope');

  // Update label and scope in place
  const updated = updateGatewayKey(settings, created.key.id, {
    label: 'WSL Ubuntu & Slack Bridge',
    scope: 'lan',
    now: 1700000010000,
  });
  settings = updated.settings;
  assert.equal(updated.key.id, created.key.id);
  assert.equal(updated.key.label, 'WSL Ubuntu & Slack Bridge');
  assert.equal(updated.key.scope, 'lan');
  assert.equal(updated.key.hint, created.key.hint);

  // Same secret now succeeds from LAN with new label
  const allowedLan = verifyGatewayKey(settings, secret, '192.168.27.50');
  assert.equal(allowedLan.ok, true);
  assert.equal(allowedLan.key.label, 'WSL Ubuntu & Slack Bridge');
  assert.equal(allowedLan.key.scope, 'lan');

  // Validation errors
  assert.throws(() => updateGatewayKey(settings, 'missing-id', { label: 'X' }), /no gateway key with id/);
  assert.throws(() => updateGatewayKey(settings, created.key.id, { label: '   ' }), /a label for the client key is required/);
  assert.throws(() => updateGatewayKey(settings, created.key.id, { scope: 'invalid-scope' }), /invalid gateway scope/);
});
