import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { formatHandoff, getHandoffPath, writeHandoff, readHandoff, generateHandoffPrompt } from '../core/handoff.js';
import { dataDir } from '../core/paths.js';

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
