import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { readOpenCodeAuth, openCodeCredential } from '../core/opencode-auth.js';

test('readOpenCodeAuth returns empty object for missing or unreadable file', () => {
  const dir = tempDir('sb-opencode-');
  const missing = path.join(dir, 'nonexistent.json');
  assert.deepEqual(readOpenCodeAuth(missing), {});

  const corrupt = path.join(dir, 'corrupt.json');
  fs.writeFileSync(corrupt, '{ broken json', 'utf8');
  assert.deepEqual(readOpenCodeAuth(corrupt), {});
});

test('readOpenCodeAuth returns parsed map for valid auth.json', () => {
  const dir = tempDir('sb-opencode-');
  const authFile = path.join(dir, 'auth.json');
  const payload = {
    'github-copilot': { type: 'oauth', access: 'token-copilot-123' },
    'deepseek': { type: 'api-key', key: 'token-deepseek-456' },
  };
  fs.writeFileSync(authFile, JSON.stringify(payload), 'utf8');

  const auth = readOpenCodeAuth(authFile);
  assert.deepEqual(auth, payload);
});

test('openCodeCredential extracts valid credentials and respects expiration', () => {
  const dir = tempDir('sb-opencode-');
  const authFile = path.join(dir, 'auth.json');
  const now = 1_000_000_000;
  const payload = {
    'github-copilot': { type: 'oauth', access: 'copilot-access-token', expires: now + 50_000 },
    'expired-provider': { type: 'oauth', access: 'old-token', expires: now - 1000 },
    'openrouter': { type: 'api-key', key: 'openrouter-api-key' },
  };
  fs.writeFileSync(authFile, JSON.stringify(payload), 'utf8');

  assert.equal(openCodeCredential('github-copilot', { customPath: authFile, now }), 'copilot-access-token');
  assert.equal(openCodeCredential('expired-provider', { customPath: authFile, now }), null);
  assert.equal(openCodeCredential('openrouter', { customPath: authFile, now }), 'openrouter-api-key');
  assert.equal(openCodeCredential('unknown-provider', { customPath: authFile, now }), null);
});
