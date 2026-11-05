// This machine's own T3 Code (Windows), set up by core/t3local.js, and the Node.js lease client
// it runs (bin/switchboard-lease.mjs).
//
// T3 on Windows refuses to start a .cmd as Claude but accepts the folder layout an npm install
// of Claude leaves, so these tests check that layout is what gets written and that the cli.js
// in it really borrows an account, by running it under node against a stand-in broker.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempDir } from '../test-support/tempdir.js';
import { parseT3Target, mergeT3EnvironmentSettings, t3EnvironmentStatus, signInsFor, LOCAL_TARGET } from '../core/t3env.js';
import {
  localLayout, localPaths, localWrapperFiles, localCliText, localCmdText, localWrapperAccountId, inspectLocal,
  setupLocalT3Environment, readLocalLeaseClient, localCodexAccounts,
} from '../core/t3local.js';
import { rateLimitScanner, rateLimitDetails, findRealClaude } from '../bin/switchboard-lease.mjs';

const KEY = 'sb-key-stub';
const accounts = [
  { id: 'claude-default', label: 'first', color: '#2563eb' },
  { id: 'claude-account-2', label: 'second', color: null },
];
const registry = { accounts: accounts.map((a) => ({ ...a, provider: 'claude', home: `/x/.${a.id}` })) };
const switchboardSettings = () => ({
  gateway: { enabled: true, port: 8318, scope: 'lan' },
  lanes: accounts.map((a, i) => ({ id: `lane-${i}`, accountId: a.id, harness: 'claude' })),
});

function startBroker({ leaseEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'stub-token' }, leaseStatus = 200 } = {}) {
  const leases = [];
  const reports = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== `Bearer ${KEY}`) return send(401, { ok: false });
      if (req.url === '/v1/info') return send(200, { ok: true, contract: 1 });
      if (req.url === '/v1/lease') {
        leases.push(JSON.parse(body));
        if (leaseStatus !== 200) return send(leaseStatus, { ok: false, reason: 'all-cooling', retryAfterSeconds: 60 });
        return send(200, { ok: true, leaseId: 'lease_1', laneId: 'lane-1', accountLabel: 'Stub', env: leaseEnv, headroom: { session: 90, weekly: 90 } });
      }
      if (req.url === '/v1/lease/report') { reports.push(JSON.parse(body)); return send(200, { ok: true }); }
      return send(404, { ok: false });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, leases, reports, port: server.address().port })));
}

/** A home folder with T3 run once, a claude.exe, and a node on PATH (both stand-ins). */
function makeHome(settings = { providerInstances: { claudeAgent: { driver: 'claudeAgent', enabled: true, config: { binaryPath: 'claude' } } } }) {
  const home = tempDir('sb-t3local-');
  const p = localPaths(home);
  fs.mkdirSync(p.userdata, { recursive: true });
  if (settings) fs.writeFileSync(p.settings, `${JSON.stringify(settings, null, 2)}\n`);
  fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(home, '.local', 'bin', 'claude.exe'), '');
  const nodeDir = path.join(home, 'nodejs');
  fs.mkdirSync(nodeDir);
  fs.writeFileSync(path.join(nodeDir, 'node.exe'), '');
  fs.mkdirSync(p.conf, { recursive: true });
  fs.writeFileSync(path.join(p.conf, 'client-key'), `${KEY}\n`);
  return { home, p, env: { PATH: nodeDir } };
}

function deps(home, env, port, extra = {}) {
  let sb = switchboardSettings();
  return {
    home, env, platform: 'win32', registry, canLend: () => true,
    loadSettings: () => sb, saveSettings: (s) => { sb = s; },
    leaseClient: readLocalLeaseClient(), port, hubUrl: `http://127.0.0.1:${port}`,
    codexAccounts: [], antigravity: false,
    createKey: () => { throw new Error('no key should be made'); },
    prove: async (files) => files.map((file) => ({ file, ok: true, cooling: false, code: 0, detail: 'ok' })),
    ...extra,
  };
}

test('"local" names this machine, and wsl:local or ssh:local still name a machine called local', () => {
  assert.deepEqual(parseT3Target('local'), { ...LOCAL_TARGET });
  assert.deepEqual(parseT3Target('LOCAL'), { ...LOCAL_TARGET });
  assert.equal(parseT3Target('wsl:local').kind, 'wsl');
  assert.equal(parseT3Target('ssh:local').kind, 'ssh');
});

test('this machine gets one entry per account and an any-account entry, each in the npm layout T3 accepts', () => {
  const home = path.join(path.sep, 'home-x');
  const layout = localLayout(home);
  const current = { providerInstances: { claudeAgent: { driver: 'claudeAgent', enabled: true, config: { binaryPath: 'claude', homePath: path.join(home, '.claude') } } } };
  const r = mergeT3EnvironmentSettings(current, { home, accounts, layout });
  const ours = Object.entries(r.settings.providerInstances).filter(([id]) => id !== 'claudeAgent');
  assert.equal(ours.length, 3);
  const { root } = localPaths(home);
  for (const [, inst] of ours) {
    assert.equal(inst.driver, 'claudeAgent');
    assert.match(inst.config.binaryPath, /\.cmd$/);
    assert.ok(inst.config.binaryPath.startsWith(root), inst.config.binaryPath);
    // Not left empty: T3 would pass on whatever CLAUDE_CONFIG_DIR it started with.
    assert.equal(inst.config.homePath, path.join(home, '.claude'));
  }
  assert.equal(r.settings.providerInstances.claudeAgent_sb_default.config.binaryPath, localWrapperFiles(root, 't3-claude-default').cmd);
  assert.equal(r.settings.providerInstances.claudeAgent_sb_any.config.binaryPath, localWrapperFiles(root, 'switchboard-lease').cmd);
  assert.deepEqual(r.leftovers.map((l) => l.id), ['claudeAgent']);
  assert.deepEqual(r.settings.providerInstances.claudeAgent, current.providerInstances.claudeAgent);

  const again = mergeT3EnvironmentSettings(r.settings, { home, accounts, layout });
  assert.deepEqual(again.changes, [], 'a second run finds every entry and changes nothing');
});

test('a local wrapper names its account in a form read back exactly, and paths cannot change the code', () => {
  const opts = { leasePath: 'C:\\odd "dir"\\switchboard-lease.mjs', root: 'C:\\odd "dir"' };
  const text = localCliText(accounts[0], opts);
  assert.equal(localWrapperAccountId(text), 'claude-default');
  assert.ok(text.includes(JSON.stringify(opts.leasePath)));
  assert.equal(localWrapperAccountId(localCliText(null, opts)), '*');
  assert.throws(() => localCliText({ id: 'x"; evil()' }, opts));
  assert.match(localCmdText(), /node "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli\.js" %\*\r\n$/);
});

test('setting up this machine writes the wrappers, the lease client and T3 settings, with a backup, and a second run changes nothing', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    const r = await setupLocalT3Environment(deps(home, env, broker.port), { now: Date.parse('2026-11-05T12:00:00Z') });
    assert.equal(r.error, null, r.steps.join('\n'));
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(p.lease, 'utf8'), readLocalLeaseClient());
    for (const file of ['t3-claude-default', 't3-claude-account-2', 'switchboard-lease']) {
      const w = localWrapperFiles(p.root, file);
      assert.ok(fs.existsSync(w.cmd) && fs.existsSync(w.cli) && fs.existsSync(w.packageJson), file);
    }
    const written = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
    assert.ok(written.providerInstances.claudeAgent_sb_default && written.providerInstances.claudeAgent_sb_any);
    assert.ok(written.providerInstances.claudeAgent, 'the entry on this machine\'s own sign-in is kept');
    assert.ok(r.backup && fs.existsSync(r.backup));
    assert.equal(written.usageLimitSources[Object.keys(written.usageLimitSources)[0]].url, `http://127.0.0.1:${broker.port}`);
    assert.deepEqual(r.proof.map((x) => x.label), ['first', 'second', 'any account']);

    const before = fs.readFileSync(p.settings, 'utf8');
    const r2 = await setupLocalT3Environment(deps(home, env, broker.port));
    assert.equal(r2.ok, true);
    assert.ok(r2.steps.includes('T3 already had every entry; its settings were not touched.'));
    assert.ok(r2.steps.includes('The account wrappers here are already up to date.'));
    assert.equal(fs.readFileSync(p.settings, 'utf8'), before);
  } finally {
    broker.server.close();
  }
});

test('T3 saving its settings during the setup makes it plan again instead of overwriting', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    let calls = 0;
    const inspect = async (o) => {
      const res = await inspectLocal(o);
      calls += 1;
      if (calls === 1) {
        const s = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
        s.favorites = [{ provider: 'claudeAgent', model: 'm' }];
        fs.writeFileSync(p.settings, JSON.stringify(s));
      }
      return res;
    };
    const r = await setupLocalT3Environment(deps(home, env, broker.port, { inspect }));
    assert.equal(r.ok, true, r.error ?? '');
    assert.equal(calls, 2);
    const written = JSON.parse(fs.readFileSync(p.settings, 'utf8'));
    assert.deepEqual(written.favorites, [{ provider: 'claudeAgent', model: 'm' }], 'T3\'s own save survives');
    assert.ok(written.providerInstances.claudeAgent_sb_default);
  } finally {
    broker.server.close();
  }
});

test('the local setup refuses to start where it cannot work, and says what to do', async () => {
  const broker = await startBroker();
  try {
    const a = makeHome(null);
    fs.rmSync(a.p.userdata, { recursive: true });
    assert.match((await setupLocalT3Environment(deps(a.home, a.env, broker.port))).error, /T3 Code has never run/);

    const b = makeHome();
    assert.match((await setupLocalT3Environment(deps(b.home, { PATH: '' }, broker.port))).error, /Node\.js is not on PATH/);

    assert.match((await setupLocalT3Environment(deps(b.home, b.env, broker.port, { platform: 'linux' }))).error, /Windows machine/);
    assert.equal(fs.existsSync(localPaths(b.home).root), false, 'nothing was written');
  } finally {
    broker.server.close();
  }
});

test('the local entry is compared with the Node.js lease client, the others with the bash one', () => {
  const settings = { t3Environments: {
    local: { id: 'local', kind: 'local', name: 'this computer', lastOk: true, leaseSha: 'node-1', accounts: [] },
    'wsl:U': { id: 'wsl:U', kind: 'wsl', name: 'U', lastOk: true, leaseSha: 'bash-1', accounts: [] },
  } };
  const rows = t3EnvironmentStatus(settings, { leaseSha: 'bash-1', localLeaseSha: 'node-1' });
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [['local', 'ok'], ['wsl:U', 'ok']]);
  const stale = t3EnvironmentStatus(settings, { leaseSha: 'bash-1', localLeaseSha: 'node-2' });
  assert.equal(stale.find((r) => r.id === 'local').wrapperOld, true);
});

test('Codex accounts on this machine are checked in their own registered folders', () => {
  const home = path.join(path.sep, 'h');
  const reg = { accounts: [
    { id: 'codex-default', provider: 'codex', label: 'Default', home: path.join(home, '.codex') },
    { id: 'codex-work', provider: 'codex', label: 'Work', home: path.join(home, '.codex-work') },
  ] };
  const list = localCodexAccounts(reg, home);
  assert.deepEqual(list.map((a) => [a.id, a.shadow, a.absHome]), [
    ['codex-default', false, path.resolve(home, '.codex')],
    ['codex-work', true, path.resolve(home, '.codex-work')],
  ]);
  const rows = signInsFor(LOCAL_TARGET, { codexBin: 'codex.cmd', codexStatus: {} }, list);
  assert.ok(rows[1].how.includes(path.resolve(home, '.codex-work')), rows[1].how);
});

test('only a rejected rate_limit_event counts, even split across chunks, and huge lines are not held', () => {
  const s = rateLimitScanner();
  s.push('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed"}}\n');
  s.push('x'.repeat(70000));
  s.push('y\n{"type":"rate_limit_event","rate_limit_info":{"stat');
  s.push('us":"rejected","rateLimitType":"seven_day","resetsAt":1790000000}}\n');
  const line = s.end();
  assert.ok(line);
  assert.deepEqual(rateLimitDetails(line), { type: 'seven_day', resets: 1790000000 });
  const quiet = rateLimitScanner();
  quiet.push('{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning"}}\n');
  assert.equal(quiet.end(), null);
});

test('the real claude is never one of Switchboard\'s own wrappers', () => {
  const home = tempDir('sb-t3local-');
  const ours = path.join(home, 'ours');
  const real = path.join(home, 'real');
  for (const d of [ours, real]) { fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'claude.exe'), ''); }
  assert.equal(findRealClaude({ env: { PATH: [ours, real].join(path.delimiter) }, home, skipDir: ours }), path.join(real, 'claude.exe'));
  assert.equal(findRealClaude({ env: { CLAUDE_BIN: path.join(home, 'missing.exe') }, home }), null);
});

/** Write the local layout into a temp home and run one wrapper's cli.js the way T3 does. */
function runWrapper(home, file, account, args, env) {
  const p = localPaths(home);
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.lease, readLocalLeaseClient());
  const w = localWrapperFiles(p.root, file);
  fs.mkdirSync(path.dirname(w.cli), { recursive: true });
  fs.writeFileSync(w.cli, localCliText(account, { leasePath: p.lease, root: p.root }));
  fs.writeFileSync(w.packageJson, '{"type":"commonjs"}\n');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [w.cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** A stand-in claude (a .mjs, which the lease client runs under node) that records what it got. */
function fakeClaude(dir, { lines = ['ok'], code = 0 } = {}) {
  const file = path.join(dir, 'fake-claude.mjs');
  const record = path.join(dir, 'seen.json');
  fs.writeFileSync(file, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, apiKey: process.env.ANTHROPIC_API_KEY ?? null }));`,
    `for (const l of ${JSON.stringify(lines)}) process.stdout.write(l + '\\n');`,
    `process.exitCode = ${code};`,
  ].join('\n'));
  return { file, seen: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

test('a local wrapper borrows its account, runs claude with the lent token and reports the run', async () => {
  const broker = await startBroker();
  try {
    const home = tempDir('sb-t3local-');
    const claude = fakeClaude(home, { lines: ['ok'] });
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_BIN: claude.file, SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: `http://127.0.0.1:${broker.port}`, ANTHROPIC_API_KEY: 'leftover' };
    const r = await runWrapper(home, 't3-claude-default', accounts[0], ['-p', 'hi'], env);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out.trim(), 'ok');
    assert.deepEqual(broker.leases, [{ provider: 'claude', harness: 'claude', account: 'claude-default' }]);
    assert.deepEqual(claude.seen(), { args: ['-p', 'hi'], token: 'stub-token', apiKey: null });
    assert.deepEqual(broker.reports.map((x) => [x.outcome, x.exitCode]), [['ok', 0]]);
  } finally {
    broker.server.close();
  }
});

test('the any-account wrapper names no account, and a rejected limit is reported with its reset', async () => {
  const broker = await startBroker();
  try {
    const home = tempDir('sb-t3local-');
    const claude = fakeClaude(home, { lines: ['{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","rateLimitType":"five_hour","resetsAt":1790000000}}'], code: 1 });
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_BIN: claude.file, SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: `http://127.0.0.1:${broker.port}`, SWITCHBOARD_ACCOUNT: 'claude-default' };
    const r = await runWrapper(home, 'switchboard-lease', null, ['-p', 'hi'], env);
    assert.equal(r.code, 1);
    assert.deepEqual(broker.leases, [{ provider: 'claude', harness: 'claude' }]);
    assert.deepEqual(broker.reports.map((x) => [x.outcome, x.rateLimitType, x.resetsAt]), [['rate-limited', 'five_hour', 1790000000]]);
  } finally {
    broker.server.close();
  }
});

test('T3\'s --version check borrows nothing, and no free lane exits 75 so the caller can try later', async () => {
  const broker = await startBroker({ leaseStatus: 503 });
  try {
    const home = tempDir('sb-t3local-');
    const claude = fakeClaude(home, { lines: ['2.1.0 (Claude Code)'] });
    const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_BIN: claude.file, SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: `http://127.0.0.1:${broker.port}` };
    const v = await runWrapper(home, 't3-claude-default', accounts[0], ['--version'], env);
    assert.equal(v.code, 0);
    assert.match(v.out, /Claude Code/);
    assert.equal(broker.leases.length, 0);
    const busy = await runWrapper(home, 't3-claude-default', accounts[0], ['-p', 'hi'], env);
    assert.equal(busy.code, 75, busy.err);
    assert.equal(broker.leases.length, 1);
  } finally {
    broker.server.close();
  }
});

test('the .cmd T3 checks with --version starts the cli.js beside it', { skip: process.platform !== 'win32' && 'needs cmd.exe' }, async () => {
  const home = tempDir('sb-t3local-');
  const claude = fakeClaude(home, { lines: ['2.1.0 (Claude Code)'] });
  const p = localPaths(home);
  await runWrapper(home, 't3-claude-default', accounts[0], ['--version'], { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_BIN: claude.file });
  const w = localWrapperFiles(p.root, 't3-claude-default');
  fs.writeFileSync(w.cmd, localCmdText());
  const res = await new Promise((resolve) => {
    const child = spawn(`"${w.cmd}" --version`, { shell: true, env: { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_BIN: claude.file }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.on('close', (code) => resolve({ code, out }));
  });
  assert.equal(res.code, 0);
  assert.match(res.out, /Claude Code/);
});
