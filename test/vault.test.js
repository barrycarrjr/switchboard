import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import {
  isEncrypted,
  protectSecret,
  unprotectSecret,
  protectObject,
  unprotectObject,
  registerVaultDriver,
  resetVaultDriver,
} from '../core/vault.js';
import { loadSettings, saveSettings } from '../core/settings.js';

test('isEncrypted identifies encrypted payloads', () => {
  assert.equal(isEncrypted('enc:v1:aes-gcm:abc:123'), true);
  assert.equal(isEncrypted('enc:v1:dpapi:base64data'), true);
  assert.equal(isEncrypted('plain-secret-token'), false);
  assert.equal(isEncrypted(''), false);
  assert.equal(isEncrypted(null), false);
  assert.equal(isEncrypted(undefined), false);
});

test('protectSecret and unprotectSecret round-trip with default AES-256-GCM', () => {
  resetVaultDriver();
  const secret = 'super-confidential-api-token-xyz';
  const encrypted = protectSecret(secret);

  assert.ok(isEncrypted(encrypted));
  assert.ok(encrypted.startsWith('enc:v1:aes-gcm:'));
  assert.notEqual(encrypted, secret);

  const decrypted = unprotectSecret(encrypted);
  assert.equal(decrypted, secret);
});

test('protectSecret is idempotent on already protected strings', () => {
  resetVaultDriver();
  const secret = 'another-lane-token';
  const enc1 = protectSecret(secret);
  const enc2 = protectSecret(enc1);
  assert.equal(enc1, enc2);
});

test('unprotectSecret passes through unencrypted strings and handles corrupt payloads safely', () => {
  resetVaultDriver();
  assert.equal(unprotectSecret('unencrypted-string'), 'unencrypted-string');
  assert.equal(unprotectSecret('enc:v1:aes-gcm:broken:payload:data'), null);
  assert.equal(unprotectSecret(null), null);
});

test('custom vault driver can be registered and reset', () => {
  const mockDriver = {
    id: 'mock-dpapi',
    encrypt: (plain) => Buffer.from(plain).toString('hex'),
    decrypt: (cipher) => Buffer.from(cipher, 'hex').toString('utf8'),
  };

  registerVaultDriver(mockDriver);

  const secret = 'custom-driver-secret';
  const enc = protectSecret(secret);
  assert.ok(enc.startsWith('enc:v1:mock-dpapi:'));

  const dec = unprotectSecret(enc);
  assert.equal(dec, secret);

  resetVaultDriver();
});

test('protectObject and unprotectObject recursively protect target keys', () => {
  resetVaultDriver();
  const raw = {
    id: 'lane-1',
    token: 'secret-token-123',
    nested: {
      apiKey: 'api-key-456',
      publicInfo: 'hello world',
    },
  };

  const protectedObj = protectObject(raw, ['token', 'apiKey']);
  assert.ok(isEncrypted(protectedObj.token));
  assert.ok(isEncrypted(protectedObj.nested.apiKey));
  assert.equal(protectedObj.nested.publicInfo, 'hello world');

  const restored = unprotectObject(protectedObj, ['token', 'apiKey']);
  assert.equal(restored.token, 'secret-token-123');
  assert.equal(restored.nested.apiKey, 'api-key-456');
  assert.equal(restored.nested.publicInfo, 'hello world');
});

test('settings transparently encrypts laneTokens on save and decrypts on load', () => {
  resetVaultDriver();
  const dir = tempDir('sb-vault-');
  const file = path.join(dir, 'settings.json');

  const settings = {
    quotaWatch: 'off',
    laneTokens: {
      'lane-alpha': {
        token: 'sensitive-lane-secret-token',
        accountId: 'acc-1',
      },
    },
  };

  saveSettings(settings, file);

  // Read raw file from disk to ensure secret is NOT stored in plaintext
  const rawDiskContent = fs.readFileSync(file, 'utf8');
  assert.ok(!rawDiskContent.includes('sensitive-lane-secret-token'), 'Plaintext token must not be written to disk');
  assert.ok(rawDiskContent.includes('enc:v1:aes-gcm:'), 'Disk file must contain encrypted payload');

  // Load through loadSettings: should be transparently restored
  const loaded = loadSettings(file);
  assert.equal(loaded.laneTokens['lane-alpha'].token, 'sensitive-lane-secret-token');

  // Test legacy migration: if disk had plaintext token, it loads and encrypts on save
  const legacyFile = path.join(dir, 'legacy-settings.json');
  fs.writeFileSync(
    legacyFile,
    JSON.stringify({
      laneTokens: {
        'lane-beta': {
          token: 'legacy-plaintext-token',
        },
      },
    }),
    'utf8'
  );

  const loadedLegacy = loadSettings(legacyFile);
  assert.equal(loadedLegacy.laneTokens['lane-beta'].token, 'legacy-plaintext-token');

  saveSettings(loadedLegacy, legacyFile);
  const reSavedRaw = fs.readFileSync(legacyFile, 'utf8');
  assert.ok(!reSavedRaw.includes('legacy-plaintext-token'));
  assert.ok(reSavedRaw.includes('enc:v1:aes-gcm:'));
});
