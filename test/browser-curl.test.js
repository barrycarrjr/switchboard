import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tokenizeBashArgs,
  parseCookieString,
  isAllowedHost,
  inferProvider,
  parseCurlCommand,
} from '../core/browser-curl.js';

test('tokenizeBashArgs handles single quotes, double quotes, and line continuations', () => {
  const cmd = `curl 'https://claude.ai/api/organizations' \\
    -H 'User-Agent: Mozilla/5.0' \\
    -H "Accept: application/json" \\
    --compressed`;

  const args = tokenizeBashArgs(cmd);
  assert.equal(args[0], 'curl');
  assert.equal(args[1], 'https://claude.ai/api/organizations');
  assert.equal(args[2], '-H');
  assert.equal(args[3], 'User-Agent: Mozilla/5.0');
  assert.equal(args[4], '-H');
  assert.equal(args[5], 'Accept: application/json');
  assert.equal(args[6], '--compressed');
});

test('parseCookieString extracts cookie key-value pairs', () => {
  const cookieStr = 'sessionKey=mock-session-val; other_pref=dark; user_id=42';
  const cookies = parseCookieString(cookieStr);
  assert.equal(cookies['sessionKey'], 'mock-session-val');
  assert.equal(cookies['other_pref'], 'dark');
  assert.equal(cookies['user_id'], '42');
  assert.deepEqual(parseCookieString(''), {});
});

test('isAllowedHost verifies permitted domains and subdomains', () => {
  assert.equal(isAllowedHost('claude.ai'), true);
  assert.equal(isAllowedHost('api.anthropic.com'), true);
  assert.equal(isAllowedHost('chatgpt.com'), true);
  assert.equal(isAllowedHost('api.openai.com'), true);
  assert.equal(isAllowedHost('api.cursor.sh'), true);
  assert.equal(isAllowedHost('evil-site.com'), false);
  assert.equal(isAllowedHost('notclaude.ai.phishing.com'), false);
});

test('inferProvider maps domains to provider identifiers', () => {
  assert.equal(inferProvider('claude.ai'), 'claude');
  assert.equal(inferProvider('api.anthropic.com'), 'claude');
  assert.equal(inferProvider('chatgpt.com'), 'chatgpt');
  assert.equal(inferProvider('api.cursor.sh'), 'cursor');
  assert.equal(inferProvider('github.com'), 'github');
  assert.equal(inferProvider('unknown-service.com'), null);
});

test('parseCurlCommand extracts URL, headers, cookies, authorization, and provider', () => {
  const curl = `curl 'https://claude.ai/api/organizations/org-123/chat_conversations' \\
    -H 'Accept: application/json' \\
    -H 'Cookie: sessionKey=mock-claude-session-key; intercom-id=xyz' \\
    -H 'Authorization: Bearer mock-bearer-token'`;

  const res = parseCurlCommand(curl);
  assert.equal(res.ok, true);
  assert.equal(res.url, 'https://claude.ai/api/organizations/org-123/chat_conversations');
  assert.equal(res.hostname, 'claude.ai');
  assert.equal(res.provider, 'claude');
  assert.equal(res.authorization, 'Bearer mock-bearer-token');
  assert.equal(res.cookies['sessionKey'], 'mock-claude-session-key');
  assert.equal(res.headers['accept'], 'application/json');
});

test('parseCurlCommand extracts cookie from -b flag', () => {
  const curl = `curl -b "sessionKey=mock-session-via-b-flag" https://api.openai.com/v1/models`;
  const res = parseCurlCommand(curl);
  assert.equal(res.ok, true);
  assert.equal(res.provider, 'chatgpt');
  assert.equal(res.cookies['sessionKey'], 'mock-session-via-b-flag');
});

test('parseCurlCommand rejects insecure protocol, disallowed hosts, null bytes, and oversized payloads', () => {
  // Not a curl command
  assert.deepEqual(parseCurlCommand('echo "steal token"'), { ok: false, error: 'not-a-curl-command' });

  // Disallowed domain
  const evil = `curl 'https://evil-phishing-host.com/login' -H 'Cookie: steal=1'`;
  assert.deepEqual(parseCurlCommand(evil), { ok: false, error: 'disallowed-host' });

  // Insecure http protocol
  const insecure = `curl 'http://claude.ai/api'`;
  assert.deepEqual(parseCurlCommand(insecure), { ok: false, error: 'insecure-protocol' });

  // Null byte injection
  const nullByte = `curl 'https://claude.ai/api\0malicious'`;
  assert.deepEqual(parseCurlCommand(nullByte), { ok: false, error: 'contains-null-byte' });

  // Oversized payload (> 64 KB)
  const hugeString = 'curl "https://claude.ai/' + 'a'.repeat(70000) + '"';
  assert.deepEqual(parseCurlCommand(hugeString), { ok: false, error: 'payload-too-large' });
});
