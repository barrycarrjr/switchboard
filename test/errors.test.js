import test from 'node:test';
import assert from 'node:assert/strict';
import { isLimitError, isAuthError, classifyRunFailure } from '../core/errors.js';

test('isLimitError recognizes Claude limits', () => {
  assert.ok(isLimitError('Error: 429 Rate Limit Exceeded'));
  assert.ok(isLimitError('Usage limit reached for this month'));
  assert.ok(isLimitError('You have exceeded your quota'));
  assert.ok(isLimitError('status code 429'));
});

test('isLimitError recognizes strict 429 HTTP context', () => {
  assert.ok(isLimitError('HTTP 429'));
  assert.ok(isLimitError('Error 429'));
  assert.ok(isLimitError('status: 429'));
});

test('isLimitError returns false for ambiguous errors', () => {
  assert.equal(isLimitError('Error: 500 Internal Server Error'), false);
  assert.equal(isLimitError('SyntaxError: Unexpected token'), false);
  assert.equal(isLimitError('Network timeout'), false);
});

test('isLimitError rejects near-miss 429 numbers', () => {
  assert.equal(isLimitError('Server listening on localhost:4290'), false);
  assert.equal(isLimitError('Parsed 429 tokens'), false);
  assert.equal(isLimitError('Task 429 failed'), false);
  assert.equal(isLimitError('Line 429: error'), false);
});

// The exact line a Claude harness prints when the account folder's sign-in is gone. Kept
// verbatim rather than paraphrased: this is the string the feature exists to recognize,
// and a reworded copy would let the real one stop matching without a test noticing.
const REAL_CLAUDE_AUTH_FAILURE =
  'Failed to authenticate: OAuth session expired and could not be refreshed';

test('isAuthError recognizes the real harness sign-in failure', () => {
  assert.ok(isAuthError(REAL_CLAUDE_AUTH_FAILURE));
});

test('isAuthError recognizes other sign-in refusals', () => {
  assert.ok(isAuthError('authentication_error: invalid x-api-key'));
  assert.ok(isAuthError('Invalid API key provided'));
  assert.ok(isAuthError('You are not logged in'));
  assert.ok(isAuthError('401 Unauthorized'));
  assert.ok(isAuthError('HTTP 401'));
  assert.ok(isAuthError('status code 401'));
});

test('isAuthError returns false for ambiguous errors', () => {
  assert.equal(isAuthError('Error: 500 Internal Server Error'), false);
  assert.equal(isAuthError('SyntaxError: Unexpected token'), false);
  assert.equal(isAuthError('Network timeout'), false);
  assert.equal(isAuthError(''), false);
  assert.equal(isAuthError(null), false);
});

test('isAuthError rejects near-miss 401 numbers', () => {
  assert.equal(isAuthError('Server listening on localhost:4015'), false);
  assert.equal(isAuthError('Parsed 401 tokens'), false);
  assert.equal(isAuthError('Line 401: error'), false);
});

// The two readings must not blur into each other. A spent account is not a broken one:
// it comes back by itself, and only the sign-in failure is worth telling somebody about.
test('the limit and auth readings stay separate', () => {
  assert.equal(isAuthError('Usage limit reached for this month'), false);
  assert.equal(isAuthError('Error: 429 Rate Limit Exceeded'), false);
  assert.equal(isLimitError(REAL_CLAUDE_AUTH_FAILURE), false);
  assert.equal(isLimitError('401 Unauthorized'), false);
});

test('classifyRunFailure never classifies a run that succeeded', () => {
  // An agent that talks about authentication and then exits cleanly did its job.
  assert.equal(classifyRunFailure(0, REAL_CLAUDE_AUTH_FAILURE), 'other');
  assert.equal(classifyRunFailure(0, 'Usage limit reached'), 'other');
});

test('classifyRunFailure names each kind of failure', () => {
  assert.equal(classifyRunFailure(1, REAL_CLAUDE_AUTH_FAILURE), 'auth');
  assert.equal(classifyRunFailure(1, 'Usage limit reached for this month'), 'limit');
  assert.equal(classifyRunFailure(1, 'SyntaxError: Unexpected token'), 'other');
  assert.equal(classifyRunFailure(2, ''), 'other');
});

// An exhausted account that also mentions its sign-in is still exhausted. Reading it as a
// broken lane would tell somebody to go and fix a sign-in that was never the problem.
test('classifyRunFailure reads a limit first when output carries both', () => {
  const both = 'Usage limit reached for this month. ' + REAL_CLAUDE_AUTH_FAILURE;
  assert.equal(classifyRunFailure(1, both), 'limit');
});
