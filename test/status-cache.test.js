import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readSharedStatus, writeSharedStatus, SHARED_STATUS_TTL_MS } from '../core/status-cache.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-status-cache-')), 'status-cache.json');
}

test('a reading survives the round trip and carries its age', () => {
  const file = tmpFile();
  const now = 1_000_000;
  writeSharedStatus('claude', { tier: 'live', level: 'ok', components: [], summary: null, pageUrl: 'https://status.claude.com', error: null }, now, file);
  const hit = readSharedStatus('claude', now + 60_000, file);
  assert.equal(hit.level, 'ok');
  assert.equal(hit.checkedAt, now);
  assert.equal(hit.cached, true);
});

test('a reading older than the TTL is treated as absent', () => {
  const file = tmpFile();
  const now = 1_000_000;
  writeSharedStatus('codex', { tier: 'live', level: 'warn' }, now, file);
  assert.ok(readSharedStatus('codex', now + SHARED_STATUS_TTL_MS - 1, file), 'still fresh one millisecond before the edge');
  assert.equal(readSharedStatus('codex', now + SHARED_STATUS_TTL_MS + 1, file), null, 'stale one millisecond after it');
});

test('a clock that moved backwards is treated as absent, not as a future reading', () => {
  const file = tmpFile();
  writeSharedStatus('grok', { tier: 'live', level: 'bad' }, 5_000_000, file);
  assert.equal(readSharedStatus('grok', 4_000_000, file), null);
});

test('a missing or corrupt cache file reads as absent rather than throwing', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-status-cache-')), 'missing.json');
  assert.equal(readSharedStatus('claude', Date.now(), file), null);
  fs.writeFileSync(file, '{not json');
  assert.equal(readSharedStatus('claude', Date.now(), file), null);
});

test('an id with no entry never collides with another provider written to the same file', () => {
  const file = tmpFile();
  writeSharedStatus('claude', { tier: 'live', level: 'ok' }, 1000, file);
  assert.equal(readSharedStatus('codex', 1000, file), null);
});

test('a failed result is never written, so a bad reading cannot be shared', () => {
  const file = tmpFile();
  writeSharedStatus('claude', { tier: 'live', level: 'info', error: 'unreachable' }, 1000, file);
  assert.equal(readSharedStatus('claude', 1000, file), null);
});
