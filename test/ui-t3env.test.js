import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Gateway tab's T3 Code Environments card: what a state is called and what the card
// shows after a setup. Lifted out of index.html by text, like the other UI suites.
const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'), 'utf8');

function lift(name) {
  const lines = HTML.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `found ${name} in index.html`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.ok(end > start, `found the end of ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

const t3EnvStateText = new Function(`${lift('t3EnvStateText')}\nreturn t3EnvStateText;`)();
const t3SetupSummary = new Function(`${lift('t3SetupSummary')}\nreturn t3SetupSummary;`)();

test('each environment state reads as a plain word', () => {
  assert.equal(t3EnvStateText('ok'), 'Ready');
  assert.equal(t3EnvStateText('stale'), 'Out of date');
  assert.equal(t3EnvStateText('failed'), 'Not working');
  assert.equal(t3EnvStateText('whatever'), 'Unknown');
});

test('after a setup the card names every account that did not answer and every sign-in still needed', () => {
  const lines = t3SetupSummary({
    lines: ['Setting up wsl:Ubuntu ...'],
    reports: [{
      target: 'wsl:Ubuntu', ok: false, error: null,
      proof: [{ ok: true, label: 'first' }, { ok: false, label: 'second', code: 1, detail: 'claude-leased: lane x\nInvalid API key' }],
      skipped: [{ label: 'third', reason: 'its lane token is dead' }],
      leftovers: [{ displayName: 'Claude', note: 'uses this machine\'s own Claude sign-in, not Switchboard' }],
      signIns: [{ what: 'Codex', state: 'needs-sign-in', how: 'run: switchboard t3 sign-in wsl:Ubuntu' }, { what: 'Antigravity', state: 'signed-in', how: 'x' }],
    }],
  });
  assert.deepEqual(lines, [
    'Setting up wsl:Ubuntu ...',
    'wsl:Ubuntu: NOT ready',
    '  second did not answer: Invalid API key',
    '  not added: third (its lane token is dead)',
    '  left alone: Claude (uses this machine\'s own Claude sign-in, not Switchboard)',
    '  still to sign in: Codex: run: switchboard t3 sign-in wsl:Ubuntu',
  ]);
});

test('a setup that never started shows its error', () => {
  assert.deepEqual(t3SetupSummary({ ok: false, error: 'A setup is already running.' }), ['A setup is already running.']);
});
