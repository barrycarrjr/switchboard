import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { signinTerminal } from '../core/signin.js';

test('the account folder is handed over as an environment variable, never as command text', () => {
  const home = 'C:\\profiles\\work\\.claude';
  const { command, env } = signinTerminal({ provider: 'claude', label: 'Work', home });
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: home });
  assert.equal(command.includes(home), false);
  assert.match(command, /^Write-Host '.*' -ForegroundColor Cyan; claude$/);
});

test('a parent-shaped tool gets the folder above its own, which is what it reads', () => {
  const { env } = signinTerminal({ provider: 'gemini', label: 'Work', home: 'C:\\profiles\\work\\.gemini' });
  assert.deepEqual(env, { GEMINI_CLI_HOME: 'C:\\profiles\\work' });
});

/**
 * A folder name may legally contain an apostrophe, and an imported configuration can
 * carry one deliberately. Either way it must not be able to end a PowerShell string
 * and have what follows run as a statement.
 */
test('a quote in the folder name cannot become a second command', () => {
  const hostile = "C:\\x'; calc; $x='\\.codex";
  const { command, env } = signinTerminal({ provider: 'codex', label: 'Planted', home: hostile });
  assert.equal(env.CODEX_HOME, path.resolve(hostile));
  assert.equal(command.includes('calc'), false);
  assert.equal(command.includes("'; "), false);
});

/**
 * The banner IS interpolated, so what matters is that the string literal stays well
 * formed: every quote inside it doubled, and nothing outside it but the one statement
 * separator this command is meant to have.
 */
test('a quote in the account label is doubled, the way PowerShell escapes one', () => {
  const { command } = signinTerminal({ provider: 'codex', label: "Jo's'; calc; '", home: 'C:\\h\\.codex' });
  assert.match(command, /^Write-Host '(?:[^']|'')*' -ForegroundColor Cyan; codex login$/);
  assert.match(command, /Jo''s''; calc; ''/);
});
