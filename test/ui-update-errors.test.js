import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * What the app says when an update check does not finish. The page is one file, so the
 * helper is lifted out of index.html and run on its own.
 *
 * The promise kept here: running into GitHub's rate limit is not reported as a failure of
 * the app. On 2026-09-25 it was ("Update check failed; try again later"), which left
 * nothing to act on. The limit applies to requests made without signing in and is shared by
 * everything on the network, so the words say when it lifts, and suggest signing in to gh
 * only when gh is what was missing.
 */
const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'), 'utf8');

/** Pull one top-level `function x() { ... }` block out of the page. */
function lift(name) {
  const lines = HTML.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `found ${name} in index.html`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.ok(end > start, `found the end of ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

const MESSAGES = { api: 'Update check failed; try again later.', 'no-auth': 'gh is not signed in; run: gh auth login' };
const updateErrorText = new Function('UPDATE_ERRORS', `${lift('updateErrorText')}\nreturn updateErrorText;`)(MESSAGES);

test('a rate limit says when it lifts rather than that the check failed', () => {
  const resetAt = Date.UTC(2026, 8, 25, 21, 58, 56);
  const time = new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const text = updateErrorText({ error: 'rate-limited', resetAt, ghError: 'api' });
  assert.equal(text, `GitHub is limiting update checks from this network until ${time}. Try again after that.`);
  assert.doesNotMatch(text, /failed/i);
});

test('signing in to gh is suggested only when gh is what was missing', () => {
  for (const ghError of ['no-gh', 'no-auth']) {
    assert.match(updateErrorText({ error: 'rate-limited', resetAt: null, ghError }), /gh auth login/);
  }
  assert.doesNotMatch(updateErrorText({ error: 'rate-limited', resetAt: null, ghError: 'api' }), /gh auth login/,
    'a signed-in gh that failed as well is not helped by being told to sign in');
});

test('a rate limit with no reset time says so instead of inventing one', () => {
  assert.equal(updateErrorText({ error: 'rate-limited', resetAt: null, ghError: 'api' }),
    'GitHub is limiting update checks from this network for now. Try again later.');
});

test('every other error keeps its own words', () => {
  assert.equal(updateErrorText({ error: 'api' }), MESSAGES.api);
  assert.equal(updateErrorText({ error: 'no-auth' }), MESSAGES['no-auth']);
  assert.equal(updateErrorText({ error: 'something-new' }), 'something-new');
});
