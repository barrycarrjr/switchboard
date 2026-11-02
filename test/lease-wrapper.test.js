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

function startBroker() {
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
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'stub-token' }, headroom: { session: 90, weekly: 90 },
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

function runWrapper(env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [wrapper, '-p', 'hi'], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
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

test('the two shipped copies of the wrapper are the same file', () => {
  const a = fs.readFileSync(wrapper, 'utf8');
  const b = fs.readFileSync(path.join(here, '..', 'bin', 'claude-leased.sh'), 'utf8');
  assert.equal(a, b);
});
