import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../test-support/tempdir.js';
import { sharedQuotaKey } from '../core/quota-cache.js';
import { transcriptFile } from '../core/transcripts.js';
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
    fs.writeFileSync(path.join(binDir, 'codex.cmd'),
      '@echo off\r\n' +
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
  fs.writeFileSync(codex, '#!/bin/sh\necho "CODEX_LANE_RAN $*"\n[ "$FAKE_TOOL_SKIPS_STDIN" = "1" ] && exit 0\necho STDIN_BEGIN\ncat\necho\necho STDIN_END\nexit 0\n');
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
function makeWorld({ firstLane = 'dead' } = {}) {
  const tmp = tempDir('sb-anyorder-');
  const appData = path.join(tmp, 'appdata');
  const dataDir = path.join(appData, 'Switchboard');
  const homes = {
    // "dead" is refused at sign-in; "spent" reads its prompt and then reports a limit.
    'acct-dead': path.join(tmp, `home-${firstLane}`),
    'acct-codex': path.join(tmp, 'home-codex'),
    'acct-live': path.join(tmp, 'home-live'),
  };
  const binDir = path.join(tmp, 'bin');

  for (const dir of [dataDir, ...Object.values(homes)]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(homes['acct-dead'], '.credentials.json'), signedInCredential());
  fs.writeFileSync(path.join(homes['acct-live'], '.credentials.json'), signedInCredential());
  fs.writeFileSync(path.join(homes['acct-codex'], 'auth.json'), JSON.stringify({ tokens: { id_token: 'test' } }));
  writeFakeHarnesses(binDir);

  const accounts = [
    { id: 'acct-dead', provider: 'claude', label: 'Dead Account', home: homes['acct-dead'] },
    { id: 'acct-codex', provider: 'codex', label: 'Codex Account', home: homes['acct-codex'] },
    { id: 'acct-live', provider: 'claude', label: 'Live Account', home: homes['acct-live'] },
  ];
  fs.writeFileSync(path.join(dataDir, 'accounts.json'), JSON.stringify({ accounts }, null, 2));

  fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
    lanes: [
      { id: 'lane-dead', harness: 'claude', provider: 'anthropic', accountId: 'acct-dead', billing: 'subscription', capabilities: ['chat'] },
      { id: 'lane-codex', harness: 'codex', provider: 'openai', accountId: 'acct-codex', billing: 'subscription', capabilities: ['chat'] },
      { id: 'lane-live', harness: 'claude', provider: 'anthropic', accountId: 'acct-live', billing: 'subscription', capabilities: ['chat'] },
    ],
    spendPolicies: {},
    cooldowns: {},
    quotaWatch: 'off'
  }, null, 2));

  const cache = {};
  for (const account of accounts) {
    cache[account.id] = {
      key: sharedQuotaKey(account.provider, account.home),
      at: Date.now(),
      result: { source: 'token', windows: [{ key: 'session', usedPercent: 5 }, { key: 'week', usedPercent: 5 }] },
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

function runCli(world, args, { input } = {}) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    cwd: world.workspace,
    // The caller's prompt, piped in the way an automated caller sends it.
    ...(input !== undefined ? { input } : {}),
    env: {
      ...process.env,
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
    assert.match(output, /CLAUDE_LIVE_LANE_RAN -p from-the-claude-spec/,
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
