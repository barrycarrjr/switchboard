import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { signinTerminal } from '../core/signin.js';
import { accountScopedEnv, configuredClaudeCredentialOverrides } from '../core/accounts.js';

test('the account folder is handed over as an environment variable, never as command text', () => {
  const home = 'C:\\profiles\\work\\.claude';
  const { command, env } = signinTerminal({ provider: 'claude', label: 'Work', home });
  assert.equal(env.CLAUDE_CONFIG_DIR, home);
  assert.match(env.SWITCHBOARD_SIGNIN_BANNER, /Work/);
  assert.equal(command.includes(home), false);
  assert.match(command, /^Write-Host \$env:SWITCHBOARD_SIGNIN_BANNER -ForegroundColor Cyan; claude auth login --claudeai$/);
  assert.doesNotMatch(command, /setup-token/, 'subscription cards use the vendor subscription login, not an automation token');
});

test('a parent-shaped tool gets the folder above its own, which is what it reads', () => {
  const { env } = signinTerminal({ provider: 'gemini', label: 'Work', home: 'C:\\profiles\\work\\.gemini' });
  assert.equal(env.GEMINI_CLI_HOME, 'C:\\profiles\\work');
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

/** The banner is data, never command text, across both cmd.exe and PowerShell. */
test('account-label metacharacters stay in the environment and out of both command parsers', () => {
  const label = "Jo's %PATH%'; calc; $env:SECRET";
  const { command, env } = signinTerminal({ provider: 'codex', label, home: 'C:\\h\\.codex' });
  assert.equal(env.SWITCHBOARD_SIGNIN_BANNER.includes(label), true);
  assert.equal(command.includes('Jo'), false);
  assert.equal(command.includes('%PATH%'), false);
  assert.equal(command.includes('calc'), false);
});

test('Claude account terminals remove credential and provider pins case-insensitively', () => {
  const account = { provider: 'claude', home: 'C:\\profiles\\primary\\.claude' };
  const env = accountScopedEnv(account, {
    Path: 'C:\\Windows',
    anthropic_api_key: 'secret',
    Claude_Code_Use_Bedrock: '1',
    CLAUDE_CONFIG_DIR: 'C:\\wrong',
    UNRELATED: 'keep-me',
  });
  assert.equal(env.CLAUDE_CONFIG_DIR, path.resolve(account.home));
  assert.equal(env.UNRELATED, 'keep-me');
  assert.equal(env.Path, 'C:\\Windows');
  assert.equal(Object.keys(env).some((name) => name.toUpperCase() === 'ANTHROPIC_API_KEY'), false);
  assert.equal(Object.keys(env).some((name) => name.toUpperCase() === 'CLAUDE_CODE_USE_BEDROCK'), false);
});

test('process-only Claude overrides block switching case-insensitively', () => {
  const found = configuredClaudeCredentialOverrides({
    processEnv: { Claude_Code_Use_Vertex: '1', ANTHROPIC_API_KEY: '' },
  });
  assert.deepEqual(found, ['CLAUDE_CODE_USE_VERTEX']);
});
