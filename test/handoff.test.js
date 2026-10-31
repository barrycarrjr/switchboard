import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { formatHandoff, fitHandoff, derivedHandoffData, DERIVED_NEXT_ACTIONS, getHandoffPath, writeHandoff, readHandoff, generateHandoffPrompt } from '../core/handoff.js';
import { dataDir } from '../core/paths.js';

// Handoffs are written under dataDir(), which is the real app's data folder unless APPDATA
// says otherwise. These tests wrote and deleted a file beside the real handoffs, so a test
// that failed half way would have left one there. They get a folder of their own, whether
// or not the suite-wide isolation in test-support/isolate-appdata.js is loaded.
process.env.APPDATA = tempDir('sb-handoff-appdata-');

test('formatHandoff produces the required markdown schema', () => {
  const md = formatHandoff({
    objective: 'Fix the failing tests',
    nextActions: 'Run npm test'
  });
  
  assert.ok(md.includes('# Task handoff'));
  assert.ok(md.includes('Objective:\nFix the failing tests'));
  assert.ok(md.includes('Next actions:\nRun npm test'));
  assert.ok(md.includes('Constraints:\nNone provided'));
});

test('formatHandoff redacts common secrets', () => {
  const md = formatHandoff({
    objective: 'Deploy using token ' + 'sk' + '-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ',
    decisions: 'Logged in with ' + 'ya29' + '.a0AfB_byCdefGhijKLMNOpqrSTUVwxyz'
  });
  
  assert.ok(!md.includes('sk' + '-ant-api03-'));
  assert.ok(!md.includes('ya29' + '.a0AfB'));
  assert.ok(md.includes('***REDACTED***'));
});

test('writeHandoff enforces 4 KB size limit', () => {
  const largeData = { objective: 'A'.repeat(5000) };
  assert.throws(() => {
    writeHandoff(process.cwd(), largeData);
  }, /Handoff document exceeds 4 KB size limit/);
});

test('writeHandoff and readHandoff work in a temporary workspace', () => {
  const fakeWorkspace = path.join(dataDir(), 'test-workspace-123');
  const data = { objective: 'Test objective' };
  
  const handoffPath = writeHandoff(fakeWorkspace, data);
  assert.ok(fs.existsSync(handoffPath));
  
  const content = readHandoff(fakeWorkspace);
  assert.ok(content.includes('Test objective'));
  
  // Cleanup
  fs.rmSync(handoffPath);
});

test('generateHandoffPrompt creates the exact requested sentence', () => {
  const prompt = generateHandoffPrompt(process.cwd());
  assert.ok(prompt.startsWith('Read '));
  assert.ok(prompt.endsWith(' and continue from its Next actions section.'));
});

test('a handoff whose first request was long is shortened to fit rather than not written at all', () => {
  const data = {
    derivedByRun: 'run-1',
    objective: 'Build the quarterly report. ' + 'Detail. '.repeat(900),
    state: 'Started. ' + 'Progress. '.repeat(200) + 'Charts are next.',
    nextActions: 'Carry on.',
  };
  assert.ok(Buffer.byteLength(formatHandoff(data), 'utf8') > 4096, 'the fixture must start too big');

  const { data: fitted, trimmed } = fitHandoff(data);
  const doc = formatHandoff(fitted);

  assert.equal(trimmed, true);
  assert.ok(Buffer.byteLength(doc, 'utf8') <= 4096, `still ${Buffer.byteLength(doc, 'utf8')} bytes`);
  assert.match(doc, /Build the quarterly report\./, 'the opening of the request is what is kept');
  assert.match(doc, /Charts are next\./, 'the most recent work is what is kept');
});

test('a handoff that already fits is left exactly as it is', () => {
  const data = { objective: 'short', state: 'done', nextActions: 'next' };
  assert.deepEqual(fitHandoff(data), { data, trimmed: false });
});

test('a key that a trim would cut in half is redacted before the trim, never left partly readable', () => {
  // Assembled at runtime so the source-tree scan does not see a credential shape here.
  const key = ['gh', 'p_'].join('') + 'A'.repeat(36);
  const data = {
    derivedByRun: 'run-1',
    objective: 'Do the task. ' + 'x'.repeat(3480) + ` token ${key} ` + 'y'.repeat(600),
    state: 'Progress.',
    nextActions: 'Carry on.',
  };
  const doc = formatHandoff(fitHandoff(data).data);
  assert.ok(Buffer.byteLength(doc, 'utf8') <= 4096);
  assert.equal(/gh[p]_A{8,}/.test(doc), false, 'no part of the key may survive');
});

test('setup tokens and project keys are redacted from a handoff', () => {
  // Assembled at runtime so the source-tree scan does not see a credential shape here.
  const setup = ['sk', 'ant', 'oat01', 'B'.repeat(80)].join('-');
  const project = ['sk', 'proj', 'C'.repeat(60)].join('-');
  const doc = formatHandoff({ objective: `use ${setup}`, state: `and ${project}` });
  assert.equal(doc.includes('B'.repeat(20)), false);
  assert.equal(doc.includes('C'.repeat(20)), false);
});

test('a handoff built on the earlier one keeps every line of it, headings and all', () => {
  const earlier = {
    objective: 'Fix the login bug.\n\nConstraints:\n- do not touch the db',
    state: 'I changed auth.js.\n\nNext actions:\n- run the tests',
    sessionId: 'aaaaaaaa-0000-0000-0000-000000000001',
  };
  const data = derivedHandoffData({ earlier, runId: 'run-1', objective: 'Read the handoff.', state: 'Updated imports.', sessionId: null, harness: 'codex' });
  assert.equal(data.objective, earlier.objective);
  assert.ok(data.state.startsWith(earlier.state), data.state);
  assert.match(data.state, /Then, in the next lane \(codex\):\nUpdated imports\.$/);
});

test('the same conversation carried on elsewhere replaces the record instead of repeating it', () => {
  const sid = 'aaaaaaaa-0000-0000-0000-000000000001';
  const earlier = { objective: 'Build the report', state: 'Half done.', sessionId: sid };
  const data = derivedHandoffData({ earlier, runId: 'run-1', objective: 'Build the report', state: 'Half done.\n\nCharts done too.', sessionId: sid, harness: 'claude' });
  assert.equal(data.state, 'Half done.\n\nCharts done too.');
  assert.doesNotMatch(data.state, /Then, in the next lane/);
});

test('a conversation carried on elsewhere replaces only its own part, keeping the lanes before it', () => {
  const sid = 'aaaaaaaa-0000-0000-0000-000000000002';
  // Lane one (Codex) did some work; lane two (Claude) started from that handoff.
  const first = derivedHandoffData({ earlier: null, runId: 'run-1', objective: 'Build the report', state: 'Codex drafted the tables.', sessionId: 'codex-1', harness: 'codex' });
  const second = derivedHandoffData({ earlier: { ...first, sessionId: 'codex-1' }, runId: 'run-1', objective: 'Read the handoff.', state: 'Claude added charts.', sessionId: sid, harness: 'claude' });
  assert.equal(second.before, 'Codex drafted the tables.');
  // Lane three carries lane two's own conversation on in another account.
  const third = derivedHandoffData({ earlier: { ...second, sessionId: sid }, runId: 'run-1', objective: 'Read the handoff.', state: 'Claude added charts.\n\nAnd a summary.', sessionId: sid, harness: 'claude' });
  assert.equal(third.objective, 'Build the report');
  assert.ok(third.state.startsWith('Codex drafted the tables.'), third.state);
  assert.equal(third.state.split('Claude added charts.').length, 2, 'lane two must appear once, not twice');
  assert.match(third.state, /And a summary\.$/);
  assert.equal(third.before, 'Codex drafted the tables.');
});
