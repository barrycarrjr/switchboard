// What the WSL lease wrapper (bin/switchboard-lease) reports back to the broker after a run.
//
// Claude prints a rate_limit_event line on ordinary runs too, with status "allowed" or
// "allowed_warning". The wrapper used to report any such line as "rate-limited", so the
// broker cooled each lane down until its weekly reset after one good run. On 2026-11-02 a
// bridge leased two Claude lanes at 08:07 and 08:27, both runs fine, and from 08:30 every
// lease came back 503 because both lanes sat on cooldown until their weekly resets.
// Only a "rejected" event means the account is out.
//
// Runs the real script under bash against an in-process stand-in for the broker, so it is
// skipped where bash, curl and a POSIX node are not all present (plain Windows).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tempDir, removeTempDirs } from '../test-support/tempdir.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wrapper = path.join(here, '..', 'bin', 'switchboard-lease');
const KEY = 'sb-key-stub';

const hasTool = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const skip = process.platform === 'win32' || !hasTool('curl') || !hasTool('node')
  ? 'needs bash, curl and node on a POSIX system (run it inside WSL)'
  : false;

function startBroker({ leaseEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'stub-token' } } = {}) {
  const reports = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { ok: false });
      if (req.url === '/v1/info') return send(200, { ok: true, contract: 1 });
      if (req.url === '/v1/lease') {
        return send(200, {
          ok: true, contract: 1, leaseId: 'lease_1', laneId: 'lane-1', accountLabel: 'Stub',
          env: leaseEnv, headroom: { session: 90, weekly: 90 },
        });
      }
      if (req.url === '/v1/lease/report') { reports.push(JSON.parse(body)); return send(200, { ok: true }); }
      return send(404, { ok: false });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, reports, url: `http://127.0.0.1:${server.address().port}` })));
}

// A stand-in claude that prints the given stdout lines and exits with the given code.
function fakeClaude(dir, lines, code) {
  const file = path.join(dir, 'fake-claude');
  const body = lines.map((l) => `printf '%s\\n' '${l}'`).join('\n');
  fs.writeFileSync(file, `#!/usr/bin/env bash\n${body}\nexit ${code}\n`, { mode: 0o755 });
  return file;
}

function runWrapper(env, args = ['-p', 'hi'], cwd = undefined) {
  return new Promise((resolve) => {
    const child = spawn('bash', [wrapper, ...args], { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.resume();
    child.on('close', (code) => resolve({ code, stdout }));
  });
}

async function reportFor(lines, exitCode) {
  const dir = tempDir('sb-test-');
  const broker = await startBroker();
  try {
    const bin = fakeClaude(dir, lines, exitCode);
    const run = await runWrapper({ SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: bin });
    assert.equal(broker.reports.length, 1, 'one report per run');
    return { run, report: broker.reports[0] };
  } finally {
    broker.server.close();
    removeTempDirs();
  }
}

const event = (status) => JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: 1794207600, rateLimitType: 'seven_day' } });

test('an ordinary run that printed an "allowed" usage event reports ok, not rate-limited', { skip }, async () => {
  const { run, report } = await reportFor([event('allowed'), '{"type":"result"}'], 0);
  assert.equal(run.code, 0);
  assert.equal(report.outcome, 'ok');
  assert.equal(report.resetsAt, undefined, 'no reset time, so the broker sets no cooldown');
});

test('an "allowed_warning" usage event is not a limit either', { skip }, async () => {
  const { report } = await reportFor([event('allowed_warning')], 0);
  assert.equal(report.outcome, 'ok');
});

test('a "rejected" usage event reports rate-limited with its type and reset time', { skip }, async () => {
  const { run, report } = await reportFor([event('allowed'), event('rejected')], 1);
  assert.equal(run.code, 1, 'the wrapper keeps claude\'s exit code');
  assert.equal(report.outcome, 'rate-limited');
  assert.equal(report.rateLimitType, 'seven_day');
  assert.equal(report.resetsAt, 1794207600);
});

test('a failed run with only an "allowed" event reports error, which sets no cooldown', { skip }, async () => {
  const { report } = await reportFor([event('allowed')], 3);
  assert.equal(report.outcome, 'error');
});

// A PATH holding only the named tools, to run the wrapper as a machine without node would.
function limitedPath(dir, tools) {
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  for (const t of tools) {
    const real = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, path.join(bin, t));
  }
  return bin;
}
const BASE_TOOLS = ['bash', 'curl', 'tee', 'mktemp', 'grep', 'tail', 'rm', 'readlink', 'awk', 'ip', 'which', 'cat', 'env', 'touch', 'head', 'tr'];
const skipPy = skip || (!hasTool('python3') ? 'needs python3' : false);

test('with python3 and no node the wrapper still leases, runs claude with the lease and reports', { skip: skipPy }, async () => {
  const dir = tempDir('sb-test-');
  const broker = await startBroker();
  try {
    const bin = fakeClaude(dir, ['ok', event('rejected')], 1);
    const run = await runWrapper({
      SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: bin,
      PATH: limitedPath(dir, [...BASE_TOOLS, 'python3']),
    });
    assert.equal(run.code, 1);
    assert.equal(broker.reports.length, 1);
    assert.equal(broker.reports[0].outcome, 'rate-limited');
    assert.equal(broker.reports[0].resetsAt, 1794207600, 'python3 reads the reset time too');
    assert.equal(broker.reports[0].leaseId, 'lease_1');
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

test('with neither node nor python3 the wrapper stops before leasing and never runs claude', { skip }, async () => {
  const dir = tempDir('sb-test-');
  const broker = await startBroker();
  try {
    const marker = path.join(dir, 'ran');
    const bin = path.join(dir, 'fake-claude');
    fs.writeFileSync(bin, `#!/usr/bin/env bash\ntouch '${marker}'\n`, { mode: 0o755 });
    const run = await runWrapper({ SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: bin, PATH: limitedPath(dir, BASE_TOOLS) });
    assert.equal(run.code, 78);
    assert.equal(fs.existsSync(marker), false, 'claude never ran on whatever sign-in the machine has');
    assert.equal(broker.reports.length, 0);
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

test('the broker address is read from ~/.config/switchboard/broker-url when no variable names it', { skip }, async () => {
  const dir = tempDir('sb-test-');
  const broker = await startBroker();
  try {
    fs.mkdirSync(path.join(dir, '.config', 'switchboard'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.config', 'switchboard', 'broker-url'), `${broker.url}\r\n`);
    const bin = fakeClaude(dir, ['ok'], 0);
    const run = await runWrapper({ SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: '', CLAUDE_BIN: bin, HOME: dir, XDG_CONFIG_HOME: '' });
    assert.equal(run.code, 0);
    assert.equal(broker.reports.length, 1);
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

test('an account hint that is not an id is refused instead of being pasted into the request', { skip }, async () => {
  const dir = tempDir('sb-test-');
  const broker = await startBroker();
  try {
    const bin = fakeClaude(dir, ['ok'], 0);
    const run = await runWrapper({ SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: bin, SWITCHBOARD_ACCOUNT: 'x","provider":"codex' });
    assert.equal(run.code, 78);
    assert.equal(broker.reports.length, 0);
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

// A stand-in claude that prints what it was started with, so a test can see the lease arrive.
function echoClaude(dir) {
  const file = path.join(dir, 'echo-claude');
  fs.writeFileSync(file, '#!/usr/bin/env bash\nprintf "args=%s token=%s apikey=%s\\n" "$*" "${CLAUDE_CODE_OAUTH_TOKEN:-none}" "${ANTHROPIC_API_KEY:-none}"\n', { mode: 0o755 });
  return file;
}

test('the lent token reaches claude, and an API key that would outrank it is removed', { skip }, async () => {
  const dir = tempDir('sb-test-');
  const broker = await startBroker();
  try {
    const run = await runWrapper({ SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: echoClaude(dir), ANTHROPIC_API_KEY: 'leftover' });
    assert.equal(run.code, 0);
    assert.match(run.stdout, /args=-p hi token=stub-token apikey=none/);
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

test('--version runs claude directly and borrows nothing', { skip }, async () => {
  const dir = tempDir('sb-test-');
  const broker = await startBroker();
  try {
    const run = await runWrapper({ SWITCHBOARD_CLIENT_KEY: '', SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: echoClaude(dir) }, ['--version']);
    assert.equal(run.code, 0, 'works even with no key, since nothing is leased');
    assert.match(run.stdout, /args=--version token=none/);
    assert.equal(broker.reports.length, 0);
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

test('a lease that carries no credential is refused rather than running claude on the machine\'s own sign-in', { skip }, async () => {
  const dir = tempDir('sb-test-');
  const broker = await startBroker({ leaseEnv: {} });
  try {
    const run = await runWrapper({ SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: echoClaude(dir) });
    assert.equal(run.code, 78);
    assert.doesNotMatch(run.stdout, /args=/, 'claude never ran');
    assert.equal(broker.reports[0]?.outcome, 'error', 'the broker hears it was not a good run');
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

test('a json.py in the folder claude is run from cannot read the broker\'s reply', { skip: skipPy }, async () => {
  const dir = tempDir('sb-test-');
  const broker = await startBroker();
  try {
    const project = path.join(dir, 'project');
    fs.mkdirSync(project);
    const stolen = path.join(dir, 'stolen');
    fs.writeFileSync(path.join(project, 'json.py'), `open(${JSON.stringify(stolen)}, "w").write("x")\nraise SystemExit(1)\n`);
    const run = await runWrapper({
      SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: echoClaude(dir),
      PATH: limitedPath(dir, [...BASE_TOOLS, 'python3']),
    }, ['-p', 'hi'], project);
    assert.equal(run.code, 0);
    assert.match(run.stdout, /token=stub-token/);
    assert.equal(fs.existsSync(stolen), false, 'the project file was never imported');
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

test('a session stopped the way T3 stops one (its process group signalled) still reports and leaves no temp file', { skip }, async () => {
  const dir = tempDir('sb-test-');
  const tmp = path.join(dir, 'tmp');
  fs.mkdirSync(tmp);
  const broker = await startBroker();
  try {
    const slow = path.join(dir, 'slow-claude');
    fs.writeFileSync(slow, '#!/usr/bin/env bash\necho started\nsleep 30\n', { mode: 0o755 });
    const child = spawn('bash', [wrapper, '-p', 'hi'], {
      detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: broker.url, CLAUDE_BIN: slow, TMPDIR: tmp },
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.resume();
    const closed = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal })));
    for (let i = 0; i < 50 && !out.includes('started'); i += 1) await new Promise((r) => setTimeout(r, 100));
    process.kill(-child.pid, 'SIGTERM');
    const end = await closed;
    assert.equal(end.code, 143);
    assert.equal(broker.reports.length, 1);
    assert.deepEqual([broker.reports[0].outcome, broker.reports[0].exitCode], ['error', 143]);
    assert.deepEqual(fs.readdirSync(tmp), [], 'the usage-event file was removed');
  } finally {
    broker.server.close();
    removeTempDirs();
  }
});

test('the two shipped copies of the wrapper are the same file', () => {
  const a = fs.readFileSync(wrapper, 'utf8');
  const b = fs.readFileSync(path.join(here, '..', 'bin', 'claude-leased.sh'), 'utf8');
  assert.equal(a, b);
});
