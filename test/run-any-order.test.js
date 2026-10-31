import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../test-support/tempdir.js';
import { sharedQuotaKey } from '../core/quota-cache.js';
import { transcriptFile, projectSlug } from '../core/transcripts.js';
import { formatHandoff, handoffOrigin, DERIVED_NEXT_ACTIONS } from '../core/handoff.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'bin', 'cli.js');

/**
 * Lanes belong in whatever order their owner wants, and these run the real command line
 * to prove a caller that drives only some tools still gets a usable lane.
 *
 * The pool here is deliberately the awkward one: the lane the caller cannot drive sits in
 * the MIDDLE, between a first choice that fails and a last one that works. That is the
 * arrangement that used to end a run. After the first lane failed, the next healthy lane
 * won whatever its tool, the spec had no command line for it, and the run stopped with
 * "refusing to guess" one place above a lane that would have worked.
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
 * Stand-ins for two vendor CLIs. The Claude one refuses to sign in for the "dead" account
 * and works for any other; it prints the refusal on stdout, which is where the real tool
 * puts it. The Codex one always works, and says so in words no Claude lane prints, so a
 * test can tell which tool actually ran.
 */
function writeFakeHarnesses(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  // Every stand-in that runs also prints whatever it was given on standard input, between
  // two markers, because whether a lane received the caller's prompt is half of what these
  // tests are about. The "spent" account reads its input first and then reports a limit,
  // which is what a real tool does: the pipe is empty by the time anything falls back.
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(binDir, 'claude.cmd'),
      '@echo off\r\n' +
      'echo %CLAUDE_CONFIG_DIR% | findstr /C:"dead" >nul\r\n' +
      'if %errorlevel%==0 (\r\n' +
      '  echo Failed to authenticate: OAuth session expired and could not be refreshed\r\n' +
      '  exit /b 1\r\n' +
      ')\r\n' +
      'echo %CLAUDE_CONFIG_DIR% | findstr /C:"spent" >nul\r\n' +
      'if %errorlevel%==0 (\r\n' +
      '  findstr "^" >nul\r\n' +
      // With FAKE_SLUG set, a spent account leaves a transcript under the session it was
      // named with, as the real tool does, so a test can follow that session onwards.
      '  if not "%FAKE_SLUG%"=="" if "%1"=="--session-id" (\r\n' +
      '    mkdir "%CLAUDE_CONFIG_DIR%\\projects\\%FAKE_SLUG%" 2>nul\r\n' +
      '    echo {"type":"user","uuid":"u1","message":{"role":"user","content":"the original task"}}>"%CLAUDE_CONFIG_DIR%\\projects\\%FAKE_SLUG%\\%2.jsonl"\r\n' +
      '  )\r\n' +
      "  echo You've hit your weekly limit\r\n" +
      '  exit /b 1\r\n' +
      ')\r\n' +
      'echo CLAUDE_LIVE_LANE_RAN %*\r\n' +
      'echo STDIN_BEGIN\r\n' +
      'findstr "^"\r\n' +
      'echo STDIN_END\r\n' +
      'exit /b 0\r\n'
    );
    // FAKE_TOOL_SKIPS_STDIN makes it a tool that never reads its input, for the test where
    // the caller leaves its pipe open: reading to the end of that would never finish.
    // A Codex account whose folder name says "spent" reads its input and reports a limit.
    fs.writeFileSync(path.join(binDir, 'codex.cmd'),
      '@echo off\r\n' +
      'echo %CODEX_HOME% | findstr /C:"dead" >nul\r\n' +
      'if %errorlevel%==0 (\r\n' +
      '  echo Failed to authenticate: your sign-in was refused\r\n' +
      '  exit /b 1\r\n' +
      ')\r\n' +
      'echo %CODEX_HOME% | findstr /C:"spent" >nul\r\n' +
      'if %errorlevel%==0 (\r\n' +
      '  findstr "^" >nul\r\n' +
      "  echo You've reached your usage limit\r\n" +
      '  exit /b 1\r\n' +
      ')\r\n' +
      'echo CODEX_LANE_RAN %*\r\n' +
      'if "%FAKE_TOOL_SKIPS_STDIN%"=="1" exit /b 0\r\n' +
      'echo STDIN_BEGIN\r\n' +
      'findstr "^"\r\n' +
      'echo STDIN_END\r\n' +
      'exit /b 0\r\n'
    );
    return;
  }
  const claude = path.join(binDir, 'claude');
  fs.writeFileSync(claude,
    '#!/bin/sh\n' +
    'case "$CLAUDE_CONFIG_DIR" in\n' +
    '  *dead*)\n' +
    '    echo "Failed to authenticate: OAuth session expired and could not be refreshed"\n' +
    '    exit 1\n' +
    '    ;;\n' +
    '  *spent*)\n' +
    '    cat >/dev/null\n' +
    '    if [ -n "$FAKE_SLUG" ] && [ "$1" = "--session-id" ]; then\n' +
    '      mkdir -p "$CLAUDE_CONFIG_DIR/projects/$FAKE_SLUG"\n' +
    '      echo \'{"type":"user","uuid":"u1","message":{"role":"user","content":"the original task"}}\' > "$CLAUDE_CONFIG_DIR/projects/$FAKE_SLUG/$2.jsonl"\n' +
    '    fi\n' +
    '    echo "You\'ve hit your weekly limit"\n' +
    '    exit 1\n' +
    '    ;;\n' +
    'esac\n' +
    'echo "CLAUDE_LIVE_LANE_RAN $*"\n' +
    'echo STDIN_BEGIN\n' +
    'cat\n' +
    'echo\n' +
    'echo STDIN_END\n' +
    'exit 0\n'
  );
  fs.chmodSync(claude, 0o755);
  const codex = path.join(binDir, 'codex');
  fs.writeFileSync(codex, '#!/bin/sh\ncase "$CODEX_HOME" in *dead*) echo "Failed to authenticate: your sign-in was refused"; exit 1;; esac\ncase "$CODEX_HOME" in *spent*) cat >/dev/null; echo "You\'ve reached your usage limit"; exit 1;; esac\necho "CODEX_LANE_RAN $*"\n[ "$FAKE_TOOL_SKIPS_STDIN" = "1" ] && exit 0\necho STDIN_BEGIN\ncat\necho\necho STDIN_END\nexit 0\n');
  fs.chmodSync(codex, 0o755);
}

/** What a stand-in tool printed between its two standard-input markers. */
function stdinSeenBy(output) {
  const match = /STDIN_BEGIN\r?\n([\s\S]*?)\r?\n?STDIN_END/.exec(output);
  return match ? match[1].trim() : null;
}

/**
 * A whole machine's worth of Switchboard state in a throwaway folder: a Claude lane whose
 * sign-in is refused, then a Codex lane, then a Claude lane that works.
 *
 * Every account is given a current usage reading in the shared cache, so each lane reads
 * as having room and nothing here asks a vendor anything.
 */
function makeWorld({ firstLane = 'dead', quotaWatch = 'off', weekResets = {}, thirdClaude = false } = {}) {
  const tmp = tempDir('sb-anyorder-');
  const appData = path.join(tmp, 'appdata');
  const dataDir = path.join(appData, 'Switchboard');
  const homes = {
    // "dead" is refused at sign-in; "spent" reads its prompt and then reports a limit.
    'acct-dead': path.join(tmp, `home-${firstLane}`),
    'acct-codex': path.join(tmp, 'home-codex'),
    'acct-live': path.join(tmp, 'home-live'),
    // A third Claude account at the end, for a fallback with more than one place to go.
    ...(thirdClaude ? { 'acct-mid': path.join(tmp, 'home-mid') } : {}),
  };
  const binDir = path.join(tmp, 'bin');

  for (const dir of [dataDir, ...Object.values(homes)]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(homes['acct-dead'], '.credentials.json'), signedInCredential());
  fs.writeFileSync(path.join(homes['acct-live'], '.credentials.json'), signedInCredential());
  if (thirdClaude) fs.writeFileSync(path.join(homes['acct-mid'], '.credentials.json'), signedInCredential());
  fs.writeFileSync(path.join(homes['acct-codex'], 'auth.json'), JSON.stringify({ tokens: { id_token: 'test' } }));
  writeFakeHarnesses(binDir);

  const accounts = [
    { id: 'acct-dead', provider: 'claude', label: 'Dead Account', home: homes['acct-dead'] },
    { id: 'acct-codex', provider: 'codex', label: 'Codex Account', home: homes['acct-codex'] },
    { id: 'acct-live', provider: 'claude', label: 'Live Account', home: homes['acct-live'] },
    ...(thirdClaude ? [{ id: 'acct-mid', provider: 'claude', label: 'Mid Account', home: homes['acct-mid'] }] : []),
  ];
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ accounts }, null, 2));

  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    lanes: [
      { id: 'lane-dead', harness: 'claude', provider: 'anthropic', accountId: 'acct-dead', billing: 'subscription', capabilities: ['chat'] },
      { id: 'lane-codex', harness: 'codex', provider: 'openai', accountId: 'acct-codex', billing: 'subscription', capabilities: ['chat'] },
      { id: 'lane-live', harness: 'claude', provider: 'anthropic', accountId: 'acct-live', billing: 'subscription', capabilities: ['chat'] },
      ...(thirdClaude ? [{ id: 'lane-mid', harness: 'claude', provider: 'anthropic', accountId: 'acct-mid', billing: 'subscription', capabilities: ['chat'] }] : []),
    ],
    spendPolicies: {},
    cooldowns: {},
    quotaWatch
  }, null, 2));

  const cache = {};
  for (const account of accounts) {
    const week = { key: 'week', usedPercent: 5, ...(weekResets[account.id] ? { resetsAt: weekResets[account.id] } : {}) };
    cache[account.id] = {
      key: sharedQuotaKey(account.provider, account.home),
      at: Date.now(),
      result: { source: 'token', windows: [{ key: 'session', usedPercent: 5 }, week] },
    };
  }
  fs.writeFileSync(path.join(dataDir, 'quota-cache.json'), JSON.stringify(cache, null, 2));

  // The run's own working directory, kept apart from the state above so a handoff can be
  // written for it the way Switchboard files one: by a hash of the workspace path.
  const workspace = path.join(tmp, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });

  return { tmp, appData, binDir, workspace };
}

/**
 * File a handoff for the world's workspace, where Switchboard will look for one. With no
 * content given it is one somebody wrote by hand: nothing in it marks it as derived.
 */
function writeHandoffFor(world, content = '# Task handoff\n\nObjective:\nfinish the job\n') {
  const hash = crypto.createHash('sha256').update(path.resolve(world.workspace).toLowerCase()).digest('hex').slice(0, 16);
  const dir = path.join(world.appData, 'Switchboard', 'handoffs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${hash}.md`);
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function writeSpec(world, harnessArgs) {
  const file = path.join(world.tmp, `spec-${Object.keys(harnessArgs).join('-')}.json`);
  fs.writeFileSync(file, JSON.stringify({ harnessArgs }), 'utf8');
  return file;
}

function runCli(world, args, { input, env = {} } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: world.workspace,
    // The caller's prompt, piped in the way an automated caller sends it.
    ...(input !== undefined ? { input } : {}),
    env: {
      ...process.env,
      ...env,
      APPDATA: world.appData,
      PATH: world.binDir + path.delimiter + process.env.PATH,
      Path: world.binDir + path.delimiter + (process.env.Path ?? process.env.PATH)
    }
  });
}

test('a fallback passes over a lane the caller cannot drive and lands on the next one it can', () => {
  const world = makeWorld();
  try {
    const spec = writeSpec(world, { claude: ['-p', 'from-the-claude-spec'] });
    const res = runCli(world, ['run', '--yes', '--spec', spec]);
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-dead/,
      `expected the first lane to be tried. Output:\n${output}`);
    assert.match(output, /Running via lane lane-live/,
      `expected the run to reach the Claude lane below the Codex one. Output:\n${output}`);
    // Named up front, so a later failover can carry the conversation; the spec's own
    // command line follows unchanged.
    assert.match(output, /CLAUDE_LIVE_LANE_RAN --session-id [0-9a-f-]{36} -p from-the-claude-spec/,
      `expected the live lane to run the spec's command line. Output:\n${output}`);
    assert.equal(res.status, 0, `expected the run to end well. Output:\n${output}`);

    // The Codex lane was never in the running, and the run says why rather than refusing
    // to guess at a command line half way through.
    assert.doesNotMatch(output, /CODEX_LANE_RAN/, `Codex must not run. Output:\n${output}`);
    assert.doesNotMatch(output, /Refusing to guess/, `nothing should be refused. Output:\n${output}`);
    assert.match(output, /Leaving out lane-codex \(codex\)/,
      `expected the left-out lane to be named once. Output:\n${output}`);
    // Same tool on both sides of the hop, so nobody is told the conversation was lost.
    assert.doesNotMatch(output, /Cross-provider failover/, `no tool changed. Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a fallback onto a different tool says so, even when the first lane never started', () => {
  const world = makeWorld();
  try {
    const spec = writeSpec(world, { claude: ['-p', 'hi'], codex: ['exec', 'from-the-codex-spec'] });
    const res = runCli(world, ['run', '--yes', '--quiet', '--spec', spec]);

    assert.match(res.stdout ?? '', /CODEX_LANE_RAN exec from-the-codex-spec/,
      `expected Codex, next in the owner's order, to take the work. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    assert.equal(res.status, 0, `expected the run to end well. stderr:\n${res.stderr}`);

    // The line automated callers match on. With --quiet it is on stderr, off the stream
    // the caller parses as the answer.
    assert.match(res.stderr ?? '', /\[switchboard\] Cross-provider failover: claude to codex \(lane lane-codex\)\./,
      `expected the change of tool to be announced. stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stdout ?? '', /\[switchboard\]/,
      `Switchboard's own lines must stay off stdout under --quiet. stdout:\n${res.stdout}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('the lane a run falls back to is given the prompt the first lane already read', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const spec = writeSpec(world, { claude: ['-p'] });
    const res = runCli(world, ['run', '--yes', '--quiet', '--spec', spec], { input: 'PROMPT-FROM-THE-CALLER' });

    assert.match(res.stderr ?? '', /Provider limit error detected in lane lane-dead/,
      `expected the first lane to read the prompt and then run out. stderr:\n${res.stderr}`);
    assert.match(res.stdout ?? '', /CLAUDE_LIVE_LANE_RAN/,
      `expected the second Claude lane to take over. stdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
    // The pipe was empty by now. An inherited stdin left this lane with no question at
    // all, which a real Claude refuses outright.
    assert.equal(stdinSeenBy(res.stdout), 'PROMPT-FROM-THE-CALLER');
    assert.equal(res.status, 0, `expected the run to end well. stderr:\n${res.stderr}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

/** The conversation the spent Claude lane had, where Claude Code would have filed it. */
function writeSpentTranscript(world, sessionId) {
  const file = transcriptFile(path.join(world.tmp, 'home-spent'), world.workspace, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'Rename the login helper.' } }),
    JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Renamed it in auth.js; tests still to run.' }] } }),
  ].join('\n') + '\n', 'utf8');
}

test('a tool taking over part-way is given the first tool\'s notes after the request, through its input', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    // The caller names its own session on its own command line, as the Slack bridge does.
    // That name is how the transcript is found, so a handoff can be derived from it.
    const session = '11111111-2222-4333-8444-555555555555';
    writeSpentTranscript(world, session);
    const spec = writeSpec(world, { claude: ['-p', '--session-id', session], codex: ['exec', '-', '--from-the-spec'] });
    const res = runCli(world, ['run', '--yes', '--quiet', '--spec', spec], { input: 'PROMPT-FROM-THE-CALLER' });

    assert.match(res.stderr ?? '', /Wrote a handoff from the spent claude session/, `stderr:\n${res.stderr}`);
    assert.match(res.stderr ?? '', /Cross-provider failover: claude to codex/,
      `expected the run to move to Codex. stderr:\n${res.stderr}`);

    // The command line is exactly what the caller wrote. A sentence appended to it is
    // swallowed by Claude's list-valued flags and rejected by Codex ("unexpected argument").
    const ranWith = /CODEX_LANE_RAN ([^\r\n]*)/.exec(res.stdout ?? '')?.[1].trim();
    assert.equal(ranWith, 'exec - --from-the-spec', `stdout:\n${res.stdout}`);

    const seen = stdinSeenBy(res.stdout) ?? '';
    assert.match(seen, /^PROMPT-FROM-THE-CALLER/, 'the original request comes first, and stays in charge');
    assert.match(seen, /ran out part-way\. Its notes on how far it got are in .*handoffs.*\.md/,
      `expected the notes to be offered after the prompt. Codex saw:\n${seen}`);
    assert.doesNotMatch(seen, /continue from its Next actions/,
      'the notes open with the first thing that session was ever asked, which may not be this request');
    assert.equal(res.status, 0, `expected the run to end well. stderr:\n${res.stderr}`);

    // Derived for this run, so gone with it. Left behind, it would be the first thing the
    // next run in this folder found.
    const left = fs.readdirSync(path.join(world.appData, 'Switchboard', 'handoffs'));
    assert.deepEqual(left, [], `the derived handoff should have been tidied away, found: ${left}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a handoff somebody left in the folder is never added to a piped request', () => {
  // A bot answers every request from one repository folder. A handoff written there for
  // some other piece of work would otherwise have its "next actions" added to every
  // request that happened to change tool.
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const handoffFile = writeHandoffFor(world);
    const before = fs.readFileSync(handoffFile, 'utf8');
    const spec = writeSpec(world, { claude: ['-p'], codex: ['exec', '-'] });
    const res = runCli(world, ['run', '--yes', '--quiet', '--spec', spec], { input: 'PROMPT-FROM-THE-CALLER' });

    assert.equal(stdinSeenBy(res.stdout), 'PROMPT-FROM-THE-CALLER', `Codex must see the request and nothing else. stdout:\n${res.stdout}`);
    assert.equal(/CODEX_LANE_RAN ([^\r\n]*)/.exec(res.stdout ?? '')?.[1].trim(), 'exec -');
    assert.equal(fs.readFileSync(handoffFile, 'utf8'), before, 'and what somebody wrote on purpose is left exactly as it was');
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a handoff an earlier run derived is never handed to a later one', () => {
  // Nothing used to remove one, and "one already exists" stopped any newer one being
  // written, so the first ever derived in a folder was pointed at by every run after it.
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const stale = writeHandoffFor(world, formatHandoff({
      derivedByRun: 'an-earlier-run',
      objective: 'MONDAYS-UNRELATED-TASK',
      state: 'half done',
      nextActions: DERIVED_NEXT_ACTIONS,
    }));
    assert.equal(handoffOrigin(fs.readFileSync(stale, 'utf8')).runId, 'an-earlier-run');

    const spec = writeSpec(world, { claude: ['-p'], codex: ['exec', '-'] });
    const res = runCli(world, ['run', '--yes', '--quiet', '--spec', spec], { input: 'TUESDAYS-REQUEST' });

    assert.equal(stdinSeenBy(res.stdout), 'TUESDAYS-REQUEST', `stdout:\n${res.stdout}`);
    assert.equal(fs.existsSync(stale), false, 'it describes a different task, so it is removed rather than left to mislead');
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a handoff derived before they were marked is recognised by what it says', () => {
  const unmarked = formatHandoff({ objective: 'x', state: 'y', nextActions: DERIVED_NEXT_ACTIONS });
  assert.deepEqual(handoffOrigin(unmarked), { derived: true, runId: null });
  assert.deepEqual(handoffOrigin('# Task handoff\n\nObjective:\nship the release\n'), { derived: false, runId: null });
  assert.deepEqual(handoffOrigin(null), { derived: false, runId: null });
});

test('with nobody at a terminal, a run is not moved to another tool unless it was told it may be', () => {
  // The question used to be printed anyway. The pipe holds the caller's prompt, not an
  // answer, so the process ended at the question with a clean exit and nothing done.
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const spec = writeSpec(world, { claude: ['-p'], codex: ['exec', '-'] });
    const res = runCli(world, ['run', '--quiet', '--spec', spec], { input: 'PROMPT-FROM-THE-CALLER' });

    assert.doesNotMatch(res.stdout ?? '', /CODEX_LANE_RAN/, 'Codex must not run without leave');
    assert.match(res.stderr ?? '', /Pass --yes to allow it/, `stderr:\n${res.stderr}`);
    assert.doesNotMatch(res.stderr ?? '', /Cross-provider failover: claude to codex/, 'a hop that never happened is never announced');
    assert.notEqual(res.status, 0, 'and a run that did nothing does not report success');
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a tool named with a capital letter in the spec is the same tool for dry-run and for run', () => {
  const world = makeWorld();
  try {
    const spec = writeSpec(world, { Codex: ['exec', '-'] });
    assert.equal(JSON.parse(runCli(world, ['dry-run', '--json', '--spec', spec]).stdout).laneId, 'lane-codex');
    const ran = runCli(world, ['run', '--yes', '--spec', spec]);
    assert.match(ran.stdout ?? '', /CODEX_LANE_RAN exec -/, `run must not refuse the lane dry-run named. Output:\n${ran.stdout}${ran.stderr}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a caller that never closes its pipe does not keep a finished run open', async () => {
  // The input is listened to now, where it used to be simply inherited, and listening to a
  // pipe keeps a process alive for as long as the other end is open.
  const world = makeWorld();
  try {
    const spec = writeSpec(world, { codex: ['exec', '--no-stdin'] });
    const child = spawn(process.execPath, [cli, 'run', '--yes', '--quiet', '--spec', spec], {
      cwd: world.workspace,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        APPDATA: world.appData,
        // The stand-in tool must not wait on the open pipe either, or this would be
        // measuring the tool rather than Switchboard.
        FAKE_TOOL_SKIPS_STDIN: '1',
        PATH: world.binDir + path.delimiter + process.env.PATH,
        Path: world.binDir + path.delimiter + (process.env.Path ?? process.env.PATH)
      }
    });
    child.stdin.write('a prompt, and then the pipe is simply left open');
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });

    const code = await new Promise((resolve) => {
      const giveUp = setTimeout(() => { child.kill(); resolve('still running'); }, 30000);
      child.on('close', (c) => { clearTimeout(giveUp); resolve(c); });
    });
    assert.equal(code, 0, `expected the run to end on its own. stdout:\n${stdout}`);
    assert.match(stdout, /CODEX_LANE_RAN/);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a caller that piped nothing still gets the pointer on the command line, as it always has', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const handoffFile = writeHandoffFor(world);
    const spec = writeSpec(world, { claude: ['-p'], codex: ['exec'] });
    const res = runCli(world, ['run', '--yes', '--quiet', '--spec', spec]);

    const ranWith = /CODEX_LANE_RAN ([^\r\n]*)/.exec(res.stdout ?? '')?.[1] ?? '';
    assert.ok(ranWith.includes(handoffFile), `expected the pointer in the arguments. Codex ran with: ${ranWith}\nstderr:\n${res.stderr}`);
    assert.equal(stdinSeenBy(res.stdout), '', 'nothing was piped, so nothing is replayed');
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('dry-run names the first lane the caller can drive, not the first lane', () => {
  const world = makeWorld();
  try {
    const onlyCodex = JSON.parse(runCli(world, ['dry-run', '--json', '--harnesses', 'codex']).stdout);
    assert.equal(onlyCodex.laneId, 'lane-codex', 'the second lane, because the first is not a tool this caller drives');
    assert.equal(onlyCodex.harness, 'codex');

    // The answer says what it was narrowed to. A version from before the flag existed
    // ignores it and answers for every lane, and this is how a caller tells the two apart.
    assert.deepEqual(onlyCodex.harnesses, ['codex']);

    const anything = JSON.parse(runCli(world, ['dry-run', '--json']).stdout);
    assert.equal(anything.laneId, 'lane-dead', 'with no restriction the owner order alone decides');
    assert.equal('harnesses' in anything, false, 'nothing was narrowed, so nothing is claimed');
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('on "Switch automatically", dry-run and run both take the account whose week ends first', () => {
  const day = 24 * 60 * 60 * 1000;
  // The live account is the lower Claude lane but its week ends days sooner. Codex, in
  // between, ends sooner still, and must keep its place: ranking only ever reorders the
  // accounts of one tool, so the first place stays Claude's.
  const weekResets = { 'acct-dead': Date.now() + 5 * day, 'acct-codex': Date.now() + 1 * day, 'acct-live': Date.now() + 2 * day };
  const automatic = makeWorld({ firstLane: 'spent', quotaWatch: 'auto', weekResets });
  const byHand = makeWorld({ firstLane: 'spent', quotaWatch: 'notify', weekResets });
  try {
    assert.equal(JSON.parse(runCli(automatic, ['dry-run', '--json']).stdout).laneId, 'lane-live',
      'the sooner Claude account, and not the Codex lane whose week ends soonest of all');
    assert.equal(JSON.parse(runCli(byHand, ['dry-run', '--json']).stdout).laneId, 'lane-dead',
      'on "Tell me" the order as set decides');

    const ran = runCli(automatic, ['run', '--yes', '--spec', writeSpec(automatic, { claude: ['-p'] })]);
    const output = `${ran.stdout ?? ''}${ran.stderr ?? ''}`;
    assert.match(output, /Running via lane lane-live/, `run starts where dry-run said. Output:\n${output}`);
    assert.doesNotMatch(output, /Running via lane lane-dead/, `the later reset is never reached. Output:\n${output}`);

    const listed = runCli(automatic, ['lanes']).stdout ?? '';
    assert.match(listed, /taken soonest weekly reset first/, 'the list says it is not the order a run takes');
    assert.doesNotMatch(runCli(byHand, ['lanes']).stdout ?? '', /soonest weekly reset/);
  } finally {
    fs.rmSync(automatic.tmp, { recursive: true, force: true });
    fs.rmSync(byHand.tmp, { recursive: true, force: true });
  }
});

// The fallback after a limit takes the same order as the first pick. Nothing else covered
// that: the first pick in the test above never fails.
test('on "Switch automatically" a run that hits a limit falls back to the next soonest reset, not the next lane down', () => {
  const day = 24 * 60 * 60 * 1000;
  // The spent account resets soonest so it is tried first; of the two left, the last lane
  // resets sooner than the one above it.
  const weekResets = { 'acct-dead': Date.now() + 1 * day, 'acct-live': Date.now() + 5 * day, 'acct-mid': Date.now() + 2 * day };
  const automatic = makeWorld({ firstLane: 'spent', quotaWatch: 'auto', weekResets, thirdClaude: true });
  const byHand = makeWorld({ firstLane: 'spent', quotaWatch: 'notify', weekResets, thirdClaude: true });
  try {
    const ranked = runCli(automatic, ['run', '--yes', '--spec', writeSpec(automatic, { claude: ['-p'] })]);
    const rankedOut = `${ranked.stdout ?? ''}${ranked.stderr ?? ''}`;
    assert.match(rankedOut, /Running via lane lane-dead[\s\S]*Provider limit error[\s\S]*Running via lane lane-mid/, `Output:\n${rankedOut}`);
    assert.doesNotMatch(rankedOut, /Running via lane lane-live/, `the later reset is never reached. Output:\n${rankedOut}`);

    const asSet = runCli(byHand, ['run', '--yes', '--spec', writeSpec(byHand, { claude: ['-p'] })]);
    const asSetOut = `${asSet.stdout ?? ''}${asSet.stderr ?? ''}`;
    assert.match(asSetOut, /Running via lane lane-dead[\s\S]*Running via lane lane-live/, `on "Tell me" the next lane down. Output:\n${asSetOut}`);
  } finally {
    fs.rmSync(automatic.tmp, { recursive: true, force: true });
    fs.rmSync(byHand.tmp, { recursive: true, force: true });
  }
});

test('dry-run with a spec gives the answer run would act on', () => {
  const world = makeWorld();
  try {
    const spec = writeSpec(world, { codex: ['exec', '-'] });
    const answer = JSON.parse(runCli(world, ['dry-run', '--json', '--spec', spec]).stdout);
    assert.equal(answer.laneId, 'lane-codex');

    const ran = runCli(world, ['run', '--yes', '--spec', spec]);
    assert.match(`${ran.stdout ?? ''}${ran.stderr ?? ''}`, /Running via lane lane-codex/,
      'run starts on the lane dry-run named');
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a caller that can drive none of the lanes is told nothing matched, not that the machine is busy', () => {
  const world = makeWorld();
  try {
    const res = runCli(world, ['dry-run', '--json', '--harnesses', 'gemini']);
    const answer = JSON.parse(res.stdout);

    assert.equal(answer.available, false);
    assert.equal(answer.reason, 'No configured lanes match the criteria.');
    assert.deepEqual(answer.harnesses, ['gemini'], 'a refusal says what it was narrowed to as well');
    assert.notEqual(res.status, 0);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a dry-run given a spec it cannot read says so instead of answering for every lane', () => {
  const world = makeWorld();
  try {
    const res = runCli(world, ['dry-run', '--json', '--spec', path.join(world.tmp, 'missing.json')]);
    const answer = JSON.parse(res.stdout);

    assert.equal(answer.available, false);
    assert.match(answer.reason, /Cannot read run spec/);
    assert.notEqual(res.status, 0);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

const CALLER_SESSION = '3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c';

/** A Claude conversation as Claude Code files it, with one request and one reply. */
function seedConversation(home, cwd, sessionId, extra = '') {
  const file = transcriptFile(home, cwd, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file,
    JSON.stringify({ type: 'user', uuid: 'u1', message: { role: 'user', content: 'build the report' } }) + '\n' +
    JSON.stringify({ type: 'assistant', uuid: 'a1', message: { role: 'assistant', content: [{ type: 'text', text: 'Half the report is done.' }] } }) + '\n' +
    extra);
  return file;
}

test('a conversation the caller named in its spec goes with the work to the next Claude account', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const spentHome = path.join(world.tmp, 'home-spent');
    const liveHome = path.join(world.tmp, 'home-live');
    const source = seedConversation(spentHome, world.workspace, CALLER_SESSION);
    const spec = writeSpec(world, { claude: ['--resume', CALLER_SESSION, '-p'] });

    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: 'carry on' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Carried the session over/, `expected a carry. Output:\n${output}`);
    assert.match(output, new RegExp(`CLAUDE_LIVE_LANE_RAN --resume ${CALLER_SESSION} -p`), `expected the live lane to resume it. Output:\n${output}`);
    assert.equal(fs.readFileSync(transcriptFile(liveHome, world.workspace, CALLER_SESSION), 'utf8'), fs.readFileSync(source, 'utf8'));
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a conversation resumed by name is brought from whichever account last held it', () => {
  const world = makeWorld({ thirdClaude: true });
  try {
    const midHome = path.join(world.tmp, 'home-mid');
    const liveHome = path.join(world.tmp, 'home-live');
    seedConversation(midHome, world.workspace, CALLER_SESSION, JSON.stringify({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'and the charts' } }) + '\n');
    // The live account has an older copy: the conversation went on in the other one.
    seedConversation(liveHome, world.workspace, CALLER_SESSION);
    const spec = writeSpec(world, { claude: ['--resume', CALLER_SESSION, '-p'] });

    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: 'next' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Brought the latest copy of that conversation over from Mid Account/, `Output:\n${output}`);
    assert.match(fs.readFileSync(transcriptFile(liveHome, world.workspace, CALLER_SESSION), 'utf8'), /and the charts/);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a tool taking over is never handed the Claude session flag the first lane was given', () => {
  const world = makeWorld();
  try {
    const res = runCli(world, ['run', '--yes', '--', 'hello']);
    const ranWith = /CODEX_LANE_RAN ([^\r\n]*)/.exec(res.stdout ?? '')?.[1].trim();
    assert.equal(ranWith, 'hello', `Output:\n${res.stdout}${res.stderr}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('with nothing piped, a same-tool lane under a spec is not handed a second prompt argument, and the run says so', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const spentHome = path.join(world.tmp, 'home-spent');
    const liveHome = path.join(world.tmp, 'home-live');
    seedConversation(spentHome, world.workspace, CALLER_SESSION);
    // A different conversation under the same name, so the session cannot be carried and
    // a handoff is written instead.
    const theirs = transcriptFile(liveHome, world.workspace, CALLER_SESSION);
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, '{"type":"summary"}\n');
    const spec = writeSpec(world, { claude: ['--resume', CALLER_SESSION, '-p'] });

    const res = runCli(world, ['run', '--yes', '--spec', spec]);
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    // The spec already holds the request, and a second prompt argument is refused outright
    // by Codex, so a lane of the same tool is not given one. The run says the handoff went
    // unused rather than claiming the lane picks up from it.
    assert.match(output, /leaves no safe place to point the next lane at it/, `Output:\n${output}`);
    assert.doesNotMatch(output, /This lane picks up from that handoff/, `Output:\n${output}`);
    assert.match(output, new RegExp(`CLAUDE_LIVE_LANE_RAN --resume ${CALLER_SESSION} -p\\s*\\r?\\n`), `Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a lane that cannot sign in passes on the conversation it was handed, so the next lane still continues it', () => {
  const world = makeWorld({ firstLane: 'spent', thirdClaude: true });
  try {
    const spentHome = path.join(world.tmp, 'home-spent');
    const midHome = path.join(world.tmp, 'home-mid');
    // The second Claude lane is refused at sign-in: its folder name says "dead".
    const deadHome = path.join(world.tmp, 'home-dead2');
    fs.mkdirSync(deadHome, { recursive: true });
    fs.writeFileSync(path.join(deadHome, '.credentials.json'), signedInCredential());
    const accountsFile = path.join(world.appData, 'Switchboard', 'accounts.json');
    const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    reg.accounts.find((a) => a.id === 'acct-live').home = deadHome;
    fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2));
    // A current reading for the moved folder, so selection reaches the lane and only the
    // run itself finds out the sign-in is refused.
    const cacheFile = path.join(world.appData, 'Switchboard', 'quota-cache.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache['acct-live'] = { ...cache['acct-live'], key: sharedQuotaKey('claude', deadHome), at: Date.now() };
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));

    seedConversation(spentHome, world.workspace, CALLER_SESSION);
    const spec = writeSpec(world, { claude: ['--resume', CALLER_SESSION, '-p'] });

    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: 'carry on' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-mid/, `Output:\n${output}`);
    assert.match(output, new RegExp(`CLAUDE_LIVE_LANE_RAN --resume ${CALLER_SESSION} -p`), `the third lane must resume it. Output:\n${output}`);
    assert.ok(fs.existsSync(transcriptFile(midHome, world.workspace, CALLER_SESSION)), 'the conversation reached the third account');
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a conversation resumed as --resume=<id> is also brought from the account that last held it', () => {
  const world = makeWorld({ thirdClaude: true });
  try {
    const midHome = path.join(world.tmp, 'home-mid');
    const liveHome = path.join(world.tmp, 'home-live');
    seedConversation(midHome, world.workspace, CALLER_SESSION);
    const spec = writeSpec(world, { claude: [`--resume=${CALLER_SESSION}`, '-p'] });

    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: 'next' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Brought the latest copy of that conversation over from Mid Account/, `Output:\n${output}`);
    assert.ok(fs.existsSync(transcriptFile(liveHome, world.workspace, CALLER_SESSION)));
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a lane that cannot sign in passes on the handoff it was pointed at to the lane after it', () => {
  const world = makeWorld({ firstLane: 'spent', thirdClaude: true });
  try {
    const spentHome = path.join(world.tmp, 'home-spent');
    const deadHome = path.join(world.tmp, 'home-dead2');
    fs.mkdirSync(deadHome, { recursive: true });
    fs.writeFileSync(path.join(deadHome, '.credentials.json'), signedInCredential());
    const accountsFile = path.join(world.appData, 'Switchboard', 'accounts.json');
    const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
    reg.accounts.find((a) => a.id === 'acct-live').home = deadHome;
    fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2));
    // A current reading for the moved folder, so selection reaches the lane and only the
    // run itself finds out the sign-in is refused.
    const cacheFile = path.join(world.appData, 'Switchboard', 'quota-cache.json');
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    cache['acct-live'] = { ...cache['acct-live'], key: sharedQuotaKey('claude', deadHome), at: Date.now() };
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));

    seedConversation(spentHome, world.workspace, CALLER_SESSION);
    // The refused lane holds a different conversation under that name, so the session
    // cannot be carried into it and a handoff is written instead.
    // The lane after it does too, so the conversation cannot travel there either and the
    // handoff is what has to be passed on.
    for (const home of [deadHome, path.join(world.tmp, 'home-mid')]) {
      const theirs = transcriptFile(home, world.workspace, CALLER_SESSION);
      fs.mkdirSync(path.dirname(theirs), { recursive: true });
      fs.writeFileSync(theirs, `{"type":"summary","in":"${path.basename(home)}"}\n`);
    }
    const spec = writeSpec(world, { claude: ['--resume', CALLER_SESSION, '-p'] });

    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: 'finish the report' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-mid/, `Output:\n${output}`);
    assert.match(output, /pointed at the same handoff the failed lane was given/, `Output:\n${output}`);
    assert.match(stdinSeenBy(res.stdout) ?? '', /finish the report[\s\S]*Its notes on how far it got/, `the third lane must get the request and the pointer. Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

/** Point the world's "live" Claude account at a folder whose sign-in the stand-in refuses. */
function refuseLiveSignIn(world) {
  const deadHome = path.join(world.tmp, 'home-dead2');
  fs.mkdirSync(deadHome, { recursive: true });
  fs.writeFileSync(path.join(deadHome, '.credentials.json'), signedInCredential());
  const accountsFile = path.join(world.appData, 'Switchboard', 'accounts.json');
  const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  reg.accounts.find((a) => a.id === 'acct-live').home = deadHome;
  fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2));
  const cacheFile = path.join(world.appData, 'Switchboard', 'quota-cache.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache['acct-live'] = { ...cache['acct-live'], key: sharedQuotaKey('claude', deadHome), at: Date.now() };
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  return deadHome;
}

test('work that already started is not moved to another tool without leave, even past a lane that could not sign in', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    refuseLiveSignIn(world);
    // Claude (runs, then hits its limit), Claude (sign-in refused), then Codex.
    const settingsFile = path.join(world.appData, 'Switchboard', 'settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const byId = Object.fromEntries(settings.lanes.map((l) => [l.id, l]));
    settings.lanes = [byId['lane-dead'], byId['lane-live'], byId['lane-codex']];
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
    const spec = writeSpec(world, { claude: ['-p'], codex: ['exec', '-'] });

    const res = runCli(world, ['run', '--spec', spec], { input: 'the request' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-live/, `the refused lane must be reached. Output:\n${output}`);
    assert.doesNotMatch(output, /CODEX_LANE_RAN/, `Codex must not run without leave. Output:\n${output}`);
    assert.match(output, /Pass --yes to allow it/, `Output:\n${output}`);
    assert.notEqual(res.status, 0);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('without a spec, a caller resuming its conversation keeps its own request when the conversation cannot be carried', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const spentHome = path.join(world.tmp, 'home-spent');
    const liveHome = path.join(world.tmp, 'home-live');
    seedConversation(spentHome, world.workspace, CALLER_SESSION);
    // A different conversation under that name in the next account: nothing to carry, so
    // a handoff is written from the spent one.
    const theirs = transcriptFile(liveHome, world.workspace, CALLER_SESSION);
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, '{"type":"summary"}\n');

    const res = runCli(world, ['run', '--yes', '--harnesses', 'claude', '--', '--resume', CALLER_SESSION, '-p', 'NEW-REQUEST']);
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /CLAUDE_LIVE_LANE_RAN [^\r\n]*NEW-REQUEST/, `the request being asked now must reach the next lane. Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

/** Move one account to a folder with the given name, keeping its usage reading current. */
function rehome(world, accountId, provider, dirName) {
  const home = path.join(world.tmp, dirName);
  fs.mkdirSync(home, { recursive: true });
  if (provider === 'claude') fs.writeFileSync(path.join(home, '.credentials.json'), signedInCredential());
  else fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify({ tokens: { id_token: 'test' } }));
  const accountsFile = path.join(world.appData, 'Switchboard', 'accounts.json');
  const reg = JSON.parse(fs.readFileSync(accountsFile, 'utf8'));
  reg.accounts.find((a) => a.id === accountId).home = home;
  fs.writeFileSync(accountsFile, JSON.stringify(reg, null, 2));
  const cacheFile = path.join(world.appData, 'Switchboard', 'quota-cache.json');
  const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  cache[accountId] = { ...cache[accountId], key: sharedQuotaKey(provider, home), at: Date.now() };
  fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  return home;
}

/** Put the world's lanes in the order given by id. */
function orderLanes(world, ids) {
  const settingsFile = path.join(world.appData, 'Switchboard', 'settings.json');
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const byId = Object.fromEntries(settings.lanes.map((l) => [l.id, l]));
  settings.lanes = ids.map((id) => byId[id]);
  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
}

test('a conversation carried after a change of tool is resumed with that tool\'s own arguments', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    rehome(world, 'acct-codex', 'codex', 'home-codex-spent');
    orderLanes(world, ['lane-codex', 'lane-dead', 'lane-live']);
    writeHandoffFor(world);
    const res = runCli(world, ['run', '--yes', '--', 'exec', 'Rename-the-helper'], { env: { FAKE_SLUG: projectSlug(world.workspace) } });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Carried the session over/, `Output:\n${output}`);
    const ranWith = /CLAUDE_LIVE_LANE_RAN ([^\r\n]*)/.exec(output)?.[1] ?? '';
    assert.match(ranWith, /^--resume [0-9a-f-]{36} /, `Output:\n${output}`);
    assert.doesNotMatch(ranWith, /exec/, `Codex's arguments must not reach Claude. Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('past a refused lane of another tool, the conversation is carried from the lane whose work it is', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    rehome(world, 'acct-codex', 'codex', 'home-codex-dead');
    const spec = writeSpec(world, { claude: ['-p'], codex: ['exec', '-'] });
    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: '', env: { FAKE_SLUG: projectSlug(world.workspace) } });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-codex/, `the refused lane must be reached. Output:\n${output}`);
    assert.match(output, /Carried the session over from the lane before it/, `Output:\n${output}`);
    assert.match(output, /CLAUDE_LIVE_LANE_RAN --resume [0-9a-f-]{36} -p/, `Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('past a refused lane of another tool, the work\'s own tool is not told the tool changed', () => {
  // Claude runs and hits its limit, Codex cannot sign in, then a second Claude account takes
  // the work. The tool never changed for the work itself, so no change of tool is reported.
  const world = makeWorld({ firstLane: 'spent' });
  try {
    rehome(world, 'acct-codex', 'codex', 'home-codex-dead');
    const spec = writeSpec(world, { claude: ['-p'], codex: ['exec', '-'] });
    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: 'the request' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-codex/, `the refused lane must be reached. Output:\n${output}`);
    assert.match(output, /CLAUDE_LIVE_LANE_RAN/, `Output:\n${output}`);
    assert.match(output, /Cross-provider failover: claude to codex/, `Output:\n${output}`);
    assert.doesNotMatch(output, /Cross-provider failover: codex to claude/, `Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('past a refused lane of another tool, a handoff somebody wrote is not handed back to the work\'s own tool', () => {
  // A hand-written handoff is only for a change of tool. Back on Claude, the caller's own
  // request goes to the next account, not a pointer to somebody else's notes.
  const world = makeWorld({ firstLane: 'spent' });
  try {
    rehome(world, 'acct-codex', 'codex', 'home-codex-dead');
    writeHandoffFor(world);
    const res = runCli(world, ['run', '--yes', '--', '-p', 'THE-REQUEST']);
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-codex/, `the refused lane must be reached. Output:\n${output}`);
    const ranWith = /CLAUDE_LIVE_LANE_RAN ([^\r\n]*)/.exec(output)?.[1] ?? '';
    assert.match(ranWith, /THE-REQUEST/, `Output:\n${output}`);
    assert.doesNotMatch(ranWith, /continue from its Next actions/, `Output:\n${output}`);
    assert.doesNotMatch(output, /pointed at the same handoff the failed lane was given/, `Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('a second lane of the tool a run already moved to is not announced as another change of tool', () => {
  // Claude runs out, the first Codex account cannot sign in, a second Codex account takes
  // the work. The move to Codex was announced (and, at a terminal, asked about) once.
  const world = makeWorld({ firstLane: 'spent' });
  try {
    rehome(world, 'acct-codex', 'codex', 'home-codex-dead');
    const codex2 = path.join(world.tmp, 'home-codex2');
    fs.mkdirSync(codex2, { recursive: true });
    fs.writeFileSync(path.join(codex2, 'auth.json'), JSON.stringify({ tokens: { id_token: 'test' } }));
    const dataDir = path.join(world.appData, 'Switchboard');
    const reg = JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts.json'), 'utf8'));
    reg.accounts.push({ id: 'acct-codex2', provider: 'codex', label: 'Codex Two', home: codex2 });
    fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify(reg, null, 2));
    const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'quota-cache.json'), 'utf8'));
    cache['acct-codex2'] = { ...cache['acct-codex'], key: sharedQuotaKey('codex', codex2), at: Date.now() };
    fs.writeFileSync(path.join(dataDir, 'quota-cache.json'), JSON.stringify(cache, null, 2));
    const settings = JSON.parse(fs.readFileSync(path.join(dataDir, 'settings.json'), 'utf8'));
    settings.lanes.push({ id: 'lane-codex2', harness: 'codex', provider: 'openai', accountId: 'acct-codex2', billing: 'subscription', capabilities: ['chat'] });
    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify(settings, null, 2));
    orderLanes(world, ['lane-dead', 'lane-codex', 'lane-codex2', 'lane-live']);

    const spec = writeSpec(world, { claude: ['-p'], codex: ['exec', '-'] });
    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: 'the request' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-codex2/, `Output:\n${output}`);
    assert.match(output, /CODEX_LANE_RAN/, `Output:\n${output}`);
    assert.equal(output.split('Cross-provider failover: claude to codex').length, 2, `announced exactly once. Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});

test('past a refused lane that was never told about the handoff, the next lane is not said to share it', () => {
  const world = makeWorld({ firstLane: 'spent' });
  try {
    const spentHome = path.join(world.tmp, 'home-spent');
    const deadHome = refuseLiveSignIn(world);
    seedConversation(spentHome, world.workspace, CALLER_SESSION);
    // The refused Claude lane holds a different conversation under that name, so nothing
    // is carried into it, and as a lane of the same tool it is given no pointer either.
    const theirs = transcriptFile(deadHome, world.workspace, CALLER_SESSION);
    fs.mkdirSync(path.dirname(theirs), { recursive: true });
    fs.writeFileSync(theirs, '{"type":"summary"}\n');
    orderLanes(world, ['lane-dead', 'lane-live', 'lane-codex']);
    const spec = writeSpec(world, { claude: ['--resume', CALLER_SESSION, '-p'], codex: ['exec'] });

    const res = runCli(world, ['run', '--yes', '--spec', spec], { input: '' });
    const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;

    assert.match(output, /Running via lane lane-live/, `Output:\n${output}`);
    assert.match(output, /CODEX_LANE_RAN/, `Output:\n${output}`);
    assert.doesNotMatch(output, /same handoff the failed lane was given/, `Output:\n${output}`);
    assert.match(output, /pointed at the handoff written earlier in this run/, `Output:\n${output}`);
  } finally {
    fs.rmSync(world.tmp, { recursive: true, force: true });
  }
});
