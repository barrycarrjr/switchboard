import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadAutomations,
  saveAutomations,
  addAutomation,
  removeAutomation,
  toggleAutomation,
  dueAutomations,
  recordAutomationRun,
} from '../core/automations.js';

function makeTempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-auto-test-'));
  return path.join(dir, 'automations.json');
}

describe('core/automations', () => {
  it('adds, toggles, records runs, checks due status, and removes automations', () => {
    const file = makeTempFile();
    const state = loadAutomations(file);
    assert.deepEqual(state.automations, []);

    const added = addAutomation(state, {
      id: 'auto-daily-sync',
      name: 'Daily MCP & Skill Sync',
      prompt: 'Audit MCP registrations across all accounts',
      intervalMinutes: 60,
    });
    assert.equal(added.id, 'auto-daily-sync');
    assert.equal(added.enabled, true);
    assert.equal(added.intervalMinutes, 60);

    saveAutomations(state, file);
    const reloaded = loadAutomations(file);
    assert.equal(reloaded.automations.length, 1);
    assert.equal(reloaded.automations[0].name, 'Daily MCP & Skill Sync');

    // Never run yet -> due immediately
    const now = Date.now();
    assert.equal(dueAutomations(reloaded, now).length, 1);

    // Record a run -> no longer due until 60 minutes later
    recordAutomationRun(reloaded, 'auto-daily-sync', {
      status: 'ok',
      summary: 'Completed sync',
      ranAt: now,
    });
    assert.equal(dueAutomations(reloaded, now + 30 * 60 * 1000).length, 0);
    assert.equal(dueAutomations(reloaded, now + 61 * 60 * 1000).length, 1);

    // Toggle off -> not due even after interval
    toggleAutomation(reloaded, 'auto-daily-sync', false);
    assert.equal(reloaded.automations[0].enabled, false);
    assert.equal(dueAutomations(reloaded, now + 120 * 60 * 1000).length, 0);

    // Remove
    assert.equal(removeAutomation(reloaded, 'auto-daily-sync'), true);
    assert.equal(reloaded.automations.length, 0);
  });
});
