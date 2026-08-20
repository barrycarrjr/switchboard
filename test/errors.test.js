import test from 'node:test';
import assert from 'node:assert/strict';
import { isLimitError } from '../core/errors.js';

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
