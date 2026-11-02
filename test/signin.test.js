import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { signinTerminal, laneTokenTerminal } from '../core/signin.js';
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

test('a lane of every tool starts without API keys inherited from the calling shell', () => {
  const shell = {
    Path: 'C:\\Windows',
    OPENAI_API_KEY: 'k1',
    codex_api_key: 'k2',
    GEMINI_API_KEY: 'k3',
    GOOGLE_API_KEY: 'k4',
    DASHSCOPE_API_KEY: 'k5',
    GH_TOKEN: 'k6',
    GOOGLE_CLOUD_PROJECT: 'my-project',
    UNRELATED: 'keep-me',
  };
  const cases = [
    [{ provider: 'codex', home: 'C:\\p\\.codex' }, ['OPENAI_API_KEY', 'CODEX_API_KEY']],
    [{ provider: 'gemini', home: 'C:\\p\\.gemini' }, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']],
    [{ provider: 'qwen', home: 'C:\\p\\.qwen' }, ['OPENAI_API_KEY', 'DASHSCOPE_API_KEY']],
    [{ provider: 'antigravity', home: 'C:\\p\\.gemini' }, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']],
    [{ provider: 'copilot', home: 'C:\\p\\.copilot' }, ['GH_TOKEN']],
  ];
  for (const [account, gone] of cases) {
    const env = accountScopedEnv(account, shell);
    const names = Object.keys(env).map((n) => n.toUpperCase());
    for (const name of gone) assert.equal(names.includes(name), false, `${account.provider} kept ${name}`);
    assert.equal(env.UNRELATED, 'keep-me', account.provider);
    assert.equal(env.Path, 'C:\\Windows', account.provider);
  }
  // Picks a project for a Code Assist sign-in; signs nothing in by itself.
  assert.equal(accountScopedEnv({ provider: 'gemini', home: 'C:\\p\\.gemini' }, shell).GOOGLE_CLOUD_PROJECT, 'my-project');
});

test('the Get new token window runs the app as Node on its own lane-token command, all values in the environment', () => {
  const exePath = "C:\Program Files\Jo's apps\Switchboard.exe";
  const cliPath = 'C:\Program Files\Switchboard\resources\app.asar\bin\cli.js';
  const laneId = "lane-1'; calc; $x='";
  const label = "Jo's %PATH% account";
  const { command, env } = laneTokenTerminal({ laneId, label, exePath, cliPath });
  assert.equal(command, 'Write-Host $env:SWITCHBOARD_TOKEN_BANNER -ForegroundColor Cyan; '
    + "Start-Process -FilePath $env:SWITCHBOARD_EXE -ArgumentList ([char]34 + $env:SWITCHBOARD_CLI + [char]34), 'lane-token', $env:SWITCHBOARD_LANE_ID -NoNewWindow -Wait");
  assert.equal(command.includes('"'), false, 'no double quote for cmd.exe to reinterpret');
  assert.match(command, /-Wait$/, 'PowerShell does not wait for a windowed program started with &');
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1', 'the app executable runs cli.js as Node, as switchboard.cmd does');
  assert.equal(env.SWITCHBOARD_EXE, exePath);
  assert.equal(env.SWITCHBOARD_CLI, cliPath);
  assert.equal(env.SWITCHBOARD_LANE_ID, laneId);
  assert.match(env.SWITCHBOARD_TOKEN_BANNER, /Jo's %PATH% account/);
  assert.match(env.SWITCHBOARD_TOKEN_BANNER, /browser never shows it/, 'says where the token appears, since the browser only says signed in');
  for (const v of [exePath, cliPath, laneId, label, 'calc']) assert.equal(command.includes(v), false);
});
