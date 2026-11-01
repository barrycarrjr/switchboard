import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { resetVaultDriver } from '../core/vault.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import {
  classifyRemoteAddress,
  createGatewayKey,
  detectGatewayHostIp,
  ipAllowedByScope,
  listGatewayKeys,
  normalizeGatewayPort,
  normalizeGatewayScope,
  recordGatewayKeyUse,
  revokeGatewayKey,
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
