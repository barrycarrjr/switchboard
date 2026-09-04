import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'cli.js');

/**
 * The case this covers is the one that is easy to reason about wrongly: a lane whose
 * sign-in looks perfectly good on disk and is refused the moment the tool actually runs.
 *
 * Selection already rules out an account it knows is signed out, so a lane that is plainly
 * dead never reaches the run at all. That is not the situation worth testing. The gap is
 * the window where the stored credential still looks usable, selection therefore hands the
 * work to that lane, and only the spawned tool discovers otherwise. A pool with no run
 * time reading of its own sits there and fails every request until somebody notices.
 *
 * So the dead account here is given a credential file that reads as signed in, and the
 * refusal comes from the tool, exactly as it does in life.
 */

/** A credential file that reads as a usable sign-in. No real token is involved. */
function signedInCredential() {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'test-access-token',
      refreshToken: 'test-refresh-token',
      expiresAt: Date.now() + 60 * 60 * 1000,
      scopes: ['user:inference'],
      subscriptionType: 'max'
    }
  });
}

/**
 * A stand-in for the vendor CLI. It refuses for one account and works for the other, and
 * it prints the refusal on stdout with nothing on stderr, because that is where the real
 * tool puts it. Detection that only read stderr would pass a unit test and never once fire
 * in practice.
 */
function writeFakeHarness(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === 'win32') {
    const shim = path.join(binDir, 'claude.cmd');
    fs.writeFileSync(shim,
      '@echo off\r\n' +
      'echo %CLAUDE_CONFIG_DIR% | findstr /C:"dead" >nul\r\n' +
      'if %errorlevel%==0 (\r\n' +
      '  echo Failed to authenticate: OAuth session expired and could not be refreshed\r\n' +
      '  exit /b 1\r\n' +
      ')\r\n' +
      'echo LIVE_LANE_RAN\r\n' +
      'exit /b 0\r\n'
    );
    return shim;
  }
  const shim = path.join(binDir, 'claude');
  fs.writeFileSync(shim,
    '#!/bin/sh\n' +
    'case "$CLAUDE_CONFIG_DIR" in\n' +
    '  *dead*)\n' +
    '    echo "Failed to authenticate: OAuth session expired and could not be refreshed"\n' +
    '    exit 1\n' +
    '    ;;\n' +
    'esac\n' +
    'echo LIVE_LANE_RAN\n' +
    'exit 0\n'
  );
  fs.chmodSync(shim, 0o755);
  return shim;
}

/** A whole machine's worth of Switchboard state in a throwaway folder. */
function makeWorld() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-failover-'));
  const appData = path.join(tmp, 'appdata');
  const dataDir = path.join(appData, 'Switchboard');
  const deadHome = path.join(tmp, 'home-dead');
  const liveHome = path.join(tmp, 'home-live');
  const binDir = path.join(tmp, 'bin');

  for (const dir of [dataDir, deadHome, liveHome]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(deadHome, '.credentials.json'), signedInCredential());
  fs.writeFileSync(path.join(liveHome, '.credentials.json'), signedInCredential());
  writeFakeHarness(binDir);

  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({
    accounts: [
      { id: 'acct-dead', provider: 'claude', label: 'Dead Account', home: deadHome },
      { id: 'acct-live', provider: 'claude', label: 'Live Account', home: liveHome }
    ]
  }, null, 2));

  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    lanes: [
      { id: 'lane-dead', harness: 'claude', provider: 'anthropic', accountId: 'acct-dead', billing: 'subscription', capabilities: ['chat'] },
      { id: 'lane-live', harness: 'claude', provider: 'anthropic', accountId: 'acct-live', billing: 'subscription', capabilities: ['chat'] }
    ],
    spendPolicies: {},
    cooldowns: {},
    quotaWatch: 'off'
  }, null, 2));

  return { tmp, appData, binDir };
}

function runCli(world, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: {
      ...process.env,
      APPDATA: world.appData,
      PATH: world.binDir + path.delimiter + process.env.PATH,
      Path: world.binDir + path.delimiter + (process.env.Path ?? process.env.PATH)
    }
  });
}

test('a refused sign-in moves the run to the next lane', () => {
  const world = makeWorld();
  try {
    const res = runCli(world, ['run', '--', 'claude', '-p', 'hi']);
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    // It has to have actually tried the dead lane, or the rest proves nothing.
    assert.match(output, /Running via lane lane-dead/,
      `expected the dead lane to be tried first. Output:\n${output}`);

    // The refusal is recognised as a refusal, not filed as an ordinary failure.
    assert.match(output, /could not authenticate/,
      `expected the sign-in failure to be named. Output:\n${output}`);
    assert.doesNotMatch(output, /Ambiguous failure, not falling back/,
      `a refused sign-in must not be treated as an ambiguous failure. Output:\n${output}`);

    // And the work actually landed somewhere.
    assert.match(output, /Running via lane lane-live/,
      `expected a fall back to the live lane. Output:\n${output}`);
    assert.match(output, /LIVE_LANE_RAN/,
      `expected the live lane to run the command. Output:\n${output}`);
    assert.equal(res.status, 0, `expected the run to end well. Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('--no-fallback keeps a refused sign-in on one lane', () => {
  const world = makeWorld();
  try {
    const res = runCli(world, ['run', '--no-fallback', '--', 'claude', '-p', 'hi']);
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-dead/,
      `expected the dead lane to be tried. Output:\n${output}`);
    assert.doesNotMatch(output, /Running via lane lane-live/,
      `--no-fallback must not move the run. Output:\n${output}`);
    assert.notEqual(res.status, 0, `expected a failing exit. Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});
