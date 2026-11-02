// The scripts core/t3env.js sends to a T3 environment, run for real under bash against a
// throwaway home folder. Skipped where bash and the coreutils they use are not present
// (plain Windows); run it inside WSL or on Linux.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { tempDir } from '../test-support/tempdir.js';
import { inspectScript, applyScript, proveScript, parseInspect, parseMarkedOutput, parseProve, sha256 } from '../core/t3env.js';

const hasTool = (cmd) => spawnSync('bash', ['-c', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
const skip = process.platform === 'win32' || !['base64', 'sha256sum', 'mktemp', 'curl'].every(hasTool)
  ? 'needs bash, base64, sha256sum, mktemp and curl on a POSIX system (run it inside WSL)'
  : false;

function run(home, script) {
  const r = spawnSync('bash', ['-s'], { input: script, env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function freshHome() {
  const home = tempDir('sb-t3env-');
  fs.mkdirSync(path.join(home, '.t3', 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude'), '#!/usr/bin/env bash\necho real\n', { mode: 0o755 });
  return home;
}

test('inspection reports the home, claude, the settings and the account each existing wrapper names', { skip }, () => {
  const home = freshHome();
  const settingsText = '{"providerInstances":{}}\n';
  fs.writeFileSync(path.join(home, '.t3', 'userdata', 'settings.json'), settingsText);
  fs.writeFileSync(path.join(home, '.local', 'bin', 't3-claude-old'), '#!/bin/bash\nexport SWITCHBOARD_ACCOUNT=claude-default\nexec x\n', { mode: 0o755 });
  const r = parseInspect(run(home, inspectScript({ brokerUrls: ['http://127.0.0.1:9'] })).stdout);
  assert.equal(r.home, home);
  assert.equal(r.claude, path.join(home, '.local', 'bin', 'claude'));
  assert.equal(r.t3, true);
  assert.deepEqual(r.settings, { providerInstances: {} });
  assert.equal(r.settingsSha, sha256(settingsText), 'the hash is of the file as it is on disk');
  assert.deepEqual(r.wrappers, { 't3-claude-old': 'claude-default' });
  assert.equal(r.key, 'missing');
  assert.equal(r.broker, null, 'nothing listens on port 9');
});

test('inspection sends the key on the target to the broker, so a good key reads as accepted', { skip }, async () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.config', 'switchboard'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'switchboard', 'client-key'), 'sb-key-good\r\n');
  const server = http.createServer((req, res) => {
    res.writeHead(req.headers.authorization === 'Bearer sb-key-good' ? 200 : 401);
    res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    // spawnSync would block the event loop the stand-in broker answers on, so run it async.
    const out = await new Promise((resolve) => {
      const child = spawn('bash', ['-s'], { env: { PATH: process.env.PATH, HOME: home } });
      let stdout = '';
      child.stdout.on('data', (c) => { stdout += c; });
      child.on('close', () => resolve(stdout));
      child.stdin.end(inspectScript({ brokerUrls: [url] }));
    });
    assert.deepEqual(parseInspect(out).broker, { url, code: 200 });
  } finally {
    server.close();
  }
});

test('applying writes the key 0600, the wrappers 0755, the hub key and the settings, keeping a backup', { skip }, () => {
  const home = freshHome();
  const sfile = path.join(home, '.t3', 'userdata', 'settings.json');
  fs.writeFileSync(sfile, '{"old":true}\n');
  const script = applyScript({
    key: 'sb-key-test', brokerUrl: 'http://192.0.2.10:8318', leaseScript: '#!/usr/bin/env bash\necho lease\n',
    wrappers: [{ file: 't3-claude-default', text: '#!/usr/bin/env bash\necho a\n' }],
    settingsText: '{"new":true}\n', expectSha: sha256('{"old":true}\n'), backupSuffix: 'before-switchboard-test',
    hubSecretFile: 'usage-limit-source-abc.bin',
  });
  const r = run(home, script);
  const out = parseMarkedOutput(r.stdout, ['wrapper']);
  assert.equal(out.done, '1', r.stderr);
  const mode = (p) => (fs.statSync(path.join(home, p)).mode & 0o777).toString(8);
  assert.equal(fs.readFileSync(path.join(home, '.config/switchboard/client-key'), 'utf8'), 'sb-key-test\n');
  assert.equal(mode('.config/switchboard/client-key'), '600');
  assert.equal(fs.readFileSync(path.join(home, '.config/switchboard/broker-url'), 'utf8'), 'http://192.0.2.10:8318\n');
  assert.equal(mode('.local/bin/switchboard-lease'), '755');
  assert.equal(mode('.local/bin/t3-claude-default'), '755');
  assert.equal(fs.readFileSync(path.join(home, '.t3/userdata/secrets/usage-limit-source-abc.bin'), 'utf8'), 'sb-key-test', 'no newline, as T3 stores it');
  assert.equal(mode('.t3/userdata/secrets/usage-limit-source-abc.bin'), '600');
  assert.equal(fs.readFileSync(sfile, 'utf8'), '{"new":true}\n');
  assert.equal(fs.readFileSync(`${sfile}.before-switchboard-test`, 'utf8'), '{"old":true}\n');
  assert.deepEqual(fs.readdirSync(path.join(home, '.local', 'bin')).filter((f) => f.startsWith('.switchboard')), [], 'no temp files left');
});

test('a quota hub key left over from an older client key is replaced, and a current one is left alone', { skip }, () => {
  const home = freshHome();
  fs.mkdirSync(path.join(home, '.config', 'switchboard'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'switchboard', 'client-key'), 'sb-key-now\n');
  const secrets = path.join(home, '.t3', 'userdata', 'secrets');
  fs.mkdirSync(secrets, { recursive: true });
  fs.writeFileSync(path.join(secrets, 'usage-limit-source-abc.bin'), 'sb-key-revoked');
  const first = parseMarkedOutput(run(home, applyScript({ hubSecretFile: 'usage-limit-source-abc.bin' })).stdout);
  assert.equal(first.hubsecret, 'written');
  assert.equal(fs.readFileSync(path.join(secrets, 'usage-limit-source-abc.bin'), 'utf8'), 'sb-key-now');
  const second = parseMarkedOutput(run(home, applyScript({ hubSecretFile: 'usage-limit-source-abc.bin' })).stdout);
  assert.equal(second.hubsecret, 'unchanged');
});

test('a hand-written wrapper is copied aside before it is replaced, and a non-default broker port is saved', { skip }, () => {
  const home = freshHome();
  const bin = path.join(home, '.local', 'bin');
  fs.writeFileSync(path.join(bin, 't3-claude-mine'), 'hand written\n', { mode: 0o755 });
  const out = parseMarkedOutput(run(home, applyScript({
    brokerPort: 9000, backupSuffix: 'before-switchboard-t',
    wrappers: [{ file: 't3-claude-mine', text: 'generated\n', backup: true }],
  })).stdout, ['wrapperbackup']);
  assert.equal(out.done, '1');
  assert.deepEqual(out.wrapperbackup, ['t3-claude-mine.before-switchboard-t']);
  assert.equal(fs.readFileSync(path.join(bin, 't3-claude-mine.before-switchboard-t'), 'utf8'), 'hand written\n');
  assert.equal(fs.readFileSync(path.join(bin, 't3-claude-mine'), 'utf8'), 'generated\n');
  assert.equal(fs.readFileSync(path.join(home, '.config', 'switchboard', 'broker-port'), 'utf8'), '9000\n');
});

test('the proof runs from the home folder, not the folder the setup was started from', { skip }, () => {
  const home = freshHome();
  fs.writeFileSync(path.join(home, '.local', 'bin', 't3-claude-pwd'), '#!/usr/bin/env bash\npwd\necho ok\n', { mode: 0o755 });
  const r = spawnSync('bash', ['-s'], { input: proveScript(['t3-claude-pwd'], { timeoutSeconds: 10 }), cwd: '/tmp', env: { PATH: process.env.PATH, HOME: home }, encoding: 'utf8' });
  const [p] = parseProve(r.stdout, ['t3-claude-pwd']);
  assert.equal(p.ok, true);
  assert.match(p.detail, new RegExp(`^${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'));
});

test('inspection names the GNU tools a machine lacks', { skip }, () => {
  const home = freshHome();
  const limited = path.join(home, 'limited');
  fs.mkdirSync(limited);
  for (const t of ['bash', 'base64', 'tr', 'cat', 'head', 'basename', 'dirname', 'cut', 'grep', 'ip', 'awk', 'which', 'readlink', 'curl', 'mktemp', 'cp', 'rm']) {
    const real = spawnSync('bash', ['-c', `command -v ${t}`], { encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, path.join(limited, t));
  }
  const r = spawnSync(path.join(limited, 'bash'), ['-s'], { input: inspectScript({}), env: { PATH: limited, HOME: home }, encoding: 'utf8' });
  assert.deepEqual(parseInspect(r.stdout).missingTools, ['sha256sum', 'timeout']);
});

test('a settings file T3 changed after inspection is left alone and reported as a conflict', { skip }, () => {
  const home = freshHome();
  const sfile = path.join(home, '.t3', 'userdata', 'settings.json');
  fs.writeFileSync(sfile, '{"t3":"saved meanwhile"}\n');
  const r = run(home, applyScript({ settingsText: '{"mine":1}\n', expectSha: sha256('{"before":1}\n') }));
  assert.equal(r.code, 3);
  assert.equal(parseMarkedOutput(r.stdout).conflict, '1');
  assert.equal(fs.readFileSync(sfile, 'utf8'), '{"t3":"saved meanwhile"}\n');
});

test('a symlinked lease wrapper is kept unless replacing it was asked for', { skip }, () => {
  const home = freshHome();
  const target = path.join(home, 'checkout-lease');
  fs.writeFileSync(target, 'dev copy\n');
  const link = path.join(home, '.local', 'bin', 'switchboard-lease');
  fs.symlinkSync(target, link);
  const kept = parseMarkedOutput(run(home, applyScript({ leaseScript: 'new\n' })).stdout);
  assert.match(kept.lease, /^symlink-kept /);
  assert.equal(fs.readFileSync(target, 'utf8'), 'dev copy\n', 'never written through the link');
  const replaced = parseMarkedOutput(run(home, applyScript({ leaseScript: 'new\n', replaceSymlink: true })).stdout);
  assert.equal(replaced.lease, 'written');
  assert.equal(fs.lstatSync(link).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(target, 'utf8'), 'dev copy\n');
});

test('the proof runs each wrapper with stdin closed and reports its exit code and last words', { skip }, () => {
  const home = freshHome();
  const bin = path.join(home, '.local', 'bin');
  // Reads stdin first: if the proof did not give it /dev/null it would eat the rest of the script.
  fs.writeFileSync(path.join(bin, 't3-claude-good'), '#!/usr/bin/env bash\ncat >/dev/null\necho ok\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 't3-claude-bad'), '#!/usr/bin/env bash\necho "Invalid API key" >&2\nexit 1\n', { mode: 0o755 });
  const files = ['t3-claude-good', 't3-claude-bad'];
  const r = parseProve(run(home, proveScript(files, { timeoutSeconds: 10 })).stdout, files);
  assert.deepEqual(r.map((x) => [x.file, x.ok, x.code]), [['t3-claude-good', true, 0], ['t3-claude-bad', false, 1]]);
  assert.match(r[1].detail, /Invalid API key/);
});
