// This machine's own T3 Code (Windows), set up by core/t3local.js, and the Node.js lease client
// it runs (bin/switchboard-lease.mjs).
//
// T3 on Windows refuses to start a .cmd as Claude but accepts the folder layout an npm install
// of Claude leaves, so these tests check that layout is what gets written and that the cli.js
// in it really borrows an account, by running it under node against a stand-in broker.
//
// T3 also decides from what else lies in such a folder: it starts a real Claude found there in
// the wrapper's place, and a package.json there makes it offer to install one. So the tests
// below also check that only the two wrapper files are written and that anything else is moved
// out, noticed and reported.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { tempDir } from '../test-support/tempdir.js';
import { parseT3Target, mergeT3EnvironmentSettings, t3EnvironmentStatus, rememberT3Environment, signInsFor, LOCAL_TARGET } from '../core/t3env.js';
import {
  localLayout, localPaths, localWrapperFiles, localCliText, localCmdText, localWrapperAccountId, inspectLocal,
  setupLocalT3Environment, readLocalLeaseClient, localCodexAccounts, hasAntigravityKeyringTarget,
  localWrapperContents, localWrapperFolders, proveLocal, RETIRED_LOCAL_PACKAGE_JSON,
} from '../core/t3local.js';
import { rateLimitScanner, rateLimitDetails, findRealClaude, withoutClientKey } from '../bin/switchboard-lease.mjs';

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

/** Every file under a folder, as paths inside it with forward slashes, in order. */
function filesIn(dir, rel = '') {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? filesIn(dir, `${rel}${e.name}/`) : [`${rel}${e.name}`]))
    .sort();
}

/**
 * What `npm install -g --prefix <wrapper folder> @anthropic-ai/claude-code` leaves, which is
 * the update T3 offered for these folders: the real package where the wrapper's cli.js was
 * (npm replaces the folder, so the cli.js goes), and its launchers beside the .cmd.
 */
function installClaudeOver(w, { keepCli = false } = {}) {
  const pkg = path.dirname(w.cli);
  if (!keepCli) fs.rmSync(w.cli, { force: true });
  fs.mkdirSync(path.join(pkg, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'bin', 'claude.exe'), 'the real claude');
  fs.writeFileSync(path.join(pkg, 'cli-wrapper.cjs'), '');
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"@anthropic-ai/claude-code","type":"module"}\n');
  fs.writeFileSync(path.join(w.dir, 'claude.cmd'), '');
  return path.join(pkg, 'bin', 'claude.exe');
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
      // No package.json: with one beside the cli.js, T3 offers to install Claude over the wrapper.
      assert.deepEqual(filesIn(w.dir), ['node_modules/@anthropic-ai/claude-code/cli.js', `${file}.cmd`], file);
    }
    assert.deepEqual(localWrapperFolders(home), { takenOver: [], extras: [] });
    assert.equal(r.setAside, null);
    assert.equal(r.restartT3, false);
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

test('a real Claude installed over a wrapper is moved out by the setup, which puts the wrapper back and says to restart T3', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    await setupLocalT3Environment(deps(home, env, broker.port));
    const w = localWrapperFiles(p.root, 't3-claude-default');
    const exe = installClaudeOver(w);
    // This is the state T3 runs the real Claude in, on this machine's own sign-in.
    assert.deepEqual(localWrapperFolders(home), { takenOver: ['t3-claude-default'], extras: ['t3-claude-default'] });
    assert.equal(localWrapperContents(p.root, 't3-claude-default').takeover, exe);

    const r = await setupLocalT3Environment(deps(home, env, broker.port), { now: Date.parse('2026-11-27T21:00:00Z') });
    assert.equal(r.error, null, r.steps.join('\n'));
    assert.equal(r.ok, true);
    assert.deepEqual(filesIn(w.dir), ['node_modules/@anthropic-ai/claude-code/cli.js', 't3-claude-default.cmd']);
    assert.equal(localWrapperAccountId(fs.readFileSync(w.cli, 'utf8')), 'claude-default', 'the wrapper npm removed is back');
    assert.deepEqual(localWrapperFolders(home), { takenOver: [], extras: [] });

    assert.equal(r.setAside, path.join(p.aside, '20261127T210000Z'));
    const kept = path.join(r.setAside, 't3-claude-default');
    assert.deepEqual(filesIn(kept), [
      'claude.cmd',
      'node_modules/@anthropic-ai/claude-code/bin/claude.exe',
      'node_modules/@anthropic-ai/claude-code/cli-wrapper.cjs',
      'node_modules/@anthropic-ai/claude-code/package.json',
    ], 'moved with its place in the folder kept, not deleted');
    assert.equal(fs.readFileSync(path.join(kept, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'utf8'), 'the real claude');
    assert.equal(r.restartT3, true);
    assert.ok(r.steps.some((s) => /A copy of Claude was in t3-claude-default.*Restart T3 Code now/.test(s)), r.steps.join('\n'));
    assert.ok(r.steps.some((s) => s.includes(`kept in ${r.setAside}`)), r.steps.join('\n'));

    const again = await setupLocalT3Environment(deps(home, env, broker.port));
    assert.equal(again.restartT3, false, 'a run that moves nothing asks for no restart');
    assert.equal(again.setAside, null);
  } finally {
    broker.server.close();
  }
});

test('the start-up refresh clears the folders too, and an earlier Switchboard\'s package.json is removed, not set aside', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    await setupLocalT3Environment(deps(home, env, broker.port));
    const names = ['t3-claude-default', 't3-claude-account-2', 'switchboard-lease'];
    for (const file of names) fs.writeFileSync(localWrapperFiles(p.root, file).packageJson, RETIRED_LOCAL_PACKAGE_JSON);
    assert.deepEqual(localWrapperFolders(home), { takenOver: [], extras: [...names].sort() });

    const quiet = await setupLocalT3Environment(deps(home, env, broker.port), { refreshOnly: true });
    assert.equal(quiet.error, null, quiet.steps.join('\n'));
    assert.equal(quiet.ok, true);
    assert.ok(quiet.steps.some((s) => /^Removed the package\.json an earlier Switchboard wrote beside 3 wrappers/.test(s)), quiet.steps.join('\n'));
    assert.deepEqual(localWrapperFolders(home), { takenOver: [], extras: [] });
    assert.equal(quiet.setAside, null);
    assert.equal(quiet.restartT3, false, 'T3 was running the wrapper all along');
    assert.equal(fs.existsSync(p.aside), false, 'nothing was set aside');

    // A wrapper whose cli.js went when Claude was installed over it is still one the refresh
    // puts right, though the refresh adds no wrapper that was never there.
    const any = localWrapperFiles(p.root, 'switchboard-lease');
    installClaudeOver(any);
    fs.rmSync(localWrapperFiles(p.root, 't3-claude-account-2').dir, { recursive: true });
    const r = await setupLocalT3Environment(deps(home, env, broker.port), { refreshOnly: true, now: Date.parse('2026-11-27T21:00:00Z') });
    assert.equal(r.error, null, r.steps.join('\n'));
    assert.equal(r.ok, true);
    assert.deepEqual(filesIn(any.dir), ['node_modules/@anthropic-ai/claude-code/cli.js', 'switchboard-lease.cmd']);
    assert.equal(localWrapperAccountId(fs.readFileSync(any.cli, 'utf8')), '*');
    assert.equal(r.restartT3, true);
    assert.ok(fs.existsSync(path.join(r.setAside, 'switchboard-lease', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')));
    assert.equal(fs.existsSync(localWrapperFiles(p.root, 't3-claude-account-2').dir), false);
  } finally {
    broker.server.close();
  }
});

test('a folder that cannot be renamed is emptied piece by piece, and a copy of Claude that will not move stops the setup', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    await setupLocalT3Environment(deps(home, env, broker.port));
    const w = localWrapperFiles(p.root, 't3-claude-default');
    const bin = path.join(path.dirname(w.cli), 'bin');

    // Windows refuses to rename a folder that a process has open (as its working folder, or
    // through a file open inside it), but lets the files in it be renamed, a running program's
    // own file included.
    installClaudeOver(w, { keepCli: true });
    const folderHeld = (from, to) => { if (from === bin) throw new Error('EPERM: the folder is in use'); fs.renameSync(from, to); };
    const moved = await setupLocalT3Environment(deps(home, env, broker.port, { rename: folderHeld }), { now: Date.parse('2026-11-27T21:00:00Z') });
    assert.equal(moved.error, null, moved.steps.join('\n'));
    assert.equal(fs.existsSync(bin), false);
    assert.ok(fs.existsSync(path.join(moved.setAside, 't3-claude-default', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe')));
    assert.equal(moved.restartT3, true);

    // The program file itself will not move either (another program has it open): nothing
    // Switchboard can do, so it stops and passes on what the system said instead of a guess.
    const exe = installClaudeOver(w, { keepCli: true });
    const held = (from, to) => { if (from === bin || from === exe) throw Object.assign(new Error('resource busy or locked'), { code: 'EBUSY' }); fs.renameSync(from, to); };
    const r = await setupLocalT3Environment(deps(home, env, broker.port, { rename: held }), { now: Date.parse('2026-11-27T22:00:00Z') });
    assert.equal(r.ok, false);
    assert.match(r.error, /^a copy of Claude is in t3-claude-default \(the system said EBUSY\) and could not be moved out, .*Close T3 Code and anything else that may have the file open, then run the setup again\.$/);
    assert.ok(r.steps.some((s) => /^Could not move .*claude\.exe \(the system said EBUSY\) in t3-claude-default\.$/.test(s)), r.steps.join('\n'));
    assert.ok(fs.existsSync(exe));
    assert.equal(r.restartT3, false, 'nothing changed for T3, so there is nothing to restart it for');
    assert.deepEqual(localWrapperFolders(home).takenOver, ['t3-claude-default'], 'and the status list goes on saying so');
  } finally {
    broker.server.close();
  }
});

test('when one copy of Claude will not move, every wrapper that was cleared still gets its cli.js back', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    await setupLocalT3Environment(deps(home, env, broker.port));
    // Claude was installed over two wrappers, so npm removed both cli.js files.
    const first = localWrapperFiles(p.root, 't3-claude-default');
    const second = localWrapperFiles(p.root, 't3-claude-account-2');
    installClaudeOver(first);
    const heldExe = installClaudeOver(second);
    const heldBin = path.dirname(heldExe);
    const held = (from, to) => { if (from === heldBin || from === heldExe) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); fs.renameSync(from, to); };

    // The unattended path: the tray's start-up refresh. It stops on the copy that is held, but
    // not before it has put back the wrapper of the folder it did clear, which would otherwise
    // be left with neither a real Claude nor a cli.js, and with nothing to say so.
    const stopped = await setupLocalT3Environment(deps(home, env, broker.port, { rename: held }), { refreshOnly: true });
    assert.match(stopped.error, /a copy of Claude is in t3-claude-account-2 \(the system said EBUSY\) and could not be moved out/);
    assert.equal(localWrapperAccountId(fs.readFileSync(first.cli, 'utf8')), 'claude-default');
    assert.deepEqual(filesIn(first.dir), ['node_modules/@anthropic-ai/claude-code/cli.js', 't3-claude-default.cmd']);
    assert.equal(localWrapperAccountId(fs.readFileSync(second.cli, 'utf8')), 'claude-account-2', 'the held folder has its cli.js back too; T3 passes it over while the copy lies there');
    assert.equal(stopped.restartT3, true, 'the copy that did move was one T3 was starting');

    // Once nothing holds the file, the next refresh finishes the job.
    const done = await setupLocalT3Environment(deps(home, env, broker.port), { refreshOnly: true });
    assert.equal(done.error, null, done.steps.join('\n'));
    assert.deepEqual(localWrapperFolders(home), { takenOver: [], extras: [] });
    for (const w of [first, second]) assert.ok(fs.existsSync(w.cli));
  } finally {
    broker.server.close();
  }
});

test('a wrapper file that was moved out with the rest is written again in the same run', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    await setupLocalT3Environment(deps(home, env, broker.port));
    // A folder where the cli.js belongs is not Switchboard's file, so it goes with the rest.
    const w = localWrapperFiles(p.root, 'switchboard-lease');
    fs.rmSync(w.cli);
    fs.mkdirSync(w.cli);
    fs.writeFileSync(path.join(w.cli, 'note.txt'), 'x');
    const r = await setupLocalT3Environment(deps(home, env, broker.port), { refreshOnly: true });
    assert.equal(r.error, null, r.steps.join('\n'));
    assert.equal(localWrapperAccountId(fs.readFileSync(w.cli, 'utf8')), '*');
    assert.ok(r.steps.includes('Wrote 1 account wrapper: switchboard-lease.'), r.steps.join('\n'));
    assert.ok(fs.existsSync(path.join(r.setAside, 'switchboard-lease', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js', 'note.txt')));
  } finally {
    broker.server.close();
  }
});

test('a piece that will not move leaves no empty folders behind where things are set aside', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    await setupLocalT3Environment(deps(home, env, broker.port));
    const w = localWrapperFiles(p.root, 't3-claude-default');
    const stray = path.join(path.dirname(w.cli), 'notes.txt');
    fs.writeFileSync(stray, 'x');
    const never = (from, to) => { if (from === stray) throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); fs.renameSync(from, to); };
    // While it stays stuck the folder stays out of date, so this runs at every start.
    for (const hour of ['21', '22', '23']) {
      const r = await setupLocalT3Environment(deps(home, env, broker.port, { rename: never }), { refreshOnly: true, now: Date.parse(`2026-11-27T${hour}:00:00Z`) });
      assert.equal(r.error, null, 'a stray file T3 does not start is no reason to stop');
      assert.equal(r.setAside, null);
      assert.ok(r.steps.some((s) => s === `Could not move ${path.join('node_modules', '@anthropic-ai', 'claude-code', 'notes.txt')} (the system said EPERM) in t3-claude-default.`), r.steps.join('\n'));
    }
    assert.ok(fs.existsSync(stray));
    assert.deepEqual(fs.existsSync(p.aside) ? fs.readdirSync(p.aside) : [], [], 'no dated folder was left for a move that never happened');
  } finally {
    broker.server.close();
  }
});

test('a wrapper folder that is itself a link is never emptied, and a copy of a wrapper kept under another name is left alone', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    await setupLocalT3Environment(deps(home, env, broker.port));

    // Someone's own folder, reached through a link named like a wrapper. It even holds a file
    // by the wrapper's .cmd name, so it is found; what lies behind the link is still theirs.
    const theirs = path.join(home, 'their-folder');
    fs.mkdirSync(theirs);
    fs.writeFileSync(path.join(theirs, 'my-notes.txt'), 'mine');
    fs.writeFileSync(path.join(theirs, 't3-claude-linked.cmd'), '');
    fs.symlinkSync(theirs, path.join(p.root, 't3-claude-linked'), 'junction');

    // A copy kept while tidying up, with everything a taken-over wrapper has. No T3 entry
    // points at it (its .cmd still carries the old name), so nothing is known of what T3 starts
    // there, and nothing is said.
    const copy = path.join(p.root, 't3-claude-default-old');
    fs.cpSync(localWrapperFiles(p.root, 't3-claude-default').dir, copy, { recursive: true });
    fs.mkdirSync(path.join(copy, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'));
    fs.writeFileSync(path.join(copy, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'real');

    assert.deepEqual(localWrapperFolders(home), { takenOver: [], extras: [] });
    const r = await setupLocalT3Environment(deps(home, env, broker.port), { refreshOnly: true });
    assert.equal(r.error, null, r.steps.join('\n'));
    assert.equal(r.restartT3, false);
    assert.deepEqual(fs.readdirSync(theirs).sort(), ['my-notes.txt', 't3-claude-linked.cmd']);
    assert.deepEqual(filesIn(copy), ['node_modules/@anthropic-ai/claude-code/bin/claude.exe', 'node_modules/@anthropic-ai/claude-code/cli.js', 't3-claude-default.cmd']);
    assert.equal(fs.existsSync(p.aside), false);
  } finally {
    broker.server.close();
  }
});

test('a link found in a wrapper folder is moved as the link it is, and what it points at is never touched', async () => {
  const broker = await startBroker();
  try {
    const { home, p, env } = makeHome();
    await setupLocalT3Environment(deps(home, env, broker.port));
    // Something of the user's own, elsewhere, that a link in the wrapper folder points at.
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'keep.txt'), 'not Switchboard\'s to move');
    const w = localWrapperFiles(p.root, 't3-claude-default');
    const link = path.join(path.dirname(w.cli), 'node_modules');
    // A junction needs no special rights on Windows; elsewhere the type is ignored.
    fs.symlinkSync(elsewhere, link, 'junction');
    assert.deepEqual(localWrapperContents(p.root, 't3-claude-default').extras, [path.join('node_modules', '@anthropic-ai', 'claude-code', 'node_modules')]);

    // Even when the link will not move, the folder behind it is not emptied in its stead.
    const held = (from, to) => { if (from === link) throw new Error('EPERM'); fs.renameSync(from, to); };
    const stuck = await setupLocalT3Environment(deps(home, env, broker.port, { rename: held }));
    assert.equal(stuck.error, null, 'a link is no program T3 starts, so the setup goes on');
    assert.ok(stuck.steps.some((s) => /^Could not move .*node_modules \(the system said EPERM\) in t3-claude-default\.$/.test(s)), stuck.steps.join('\n'));
    assert.deepEqual(fs.readdirSync(elsewhere), ['keep.txt']);

    const r = await setupLocalT3Environment(deps(home, env, broker.port), { now: Date.parse('2026-11-27T21:00:00Z') });
    assert.equal(r.error, null, r.steps.join('\n'));
    assert.equal(fs.existsSync(link), false);
    assert.deepEqual(fs.readdirSync(elsewhere), ['keep.txt'], 'the link moved; its target stayed where it was, whole');
    assert.equal(fs.lstatSync(path.join(r.setAside, 't3-claude-default', 'node_modules', '@anthropic-ai', 'claude-code', 'node_modules')).isSymbolicLink(), true);
  } finally {
    broker.server.close();
  }
});

test('what does not belong in a wrapper folder is listed whole, and a write in progress is left alone', () => {
  const { home, p } = makeHome();
  const w = localWrapperFiles(p.root, 'switchboard-lease');
  fs.mkdirSync(path.dirname(w.cli), { recursive: true });
  fs.writeFileSync(w.cmd, localCmdText());
  fs.writeFileSync(w.cli, localCliText(null, { leasePath: p.lease, root: p.root }));
  assert.deepEqual(localWrapperContents(p.root, 'switchboard-lease'), { extras: [], retiredManifest: false, takeover: null });
  assert.deepEqual(localWrapperFolders(home), { takenOver: [], extras: [] });

  fs.writeFileSync(`${w.cli}.tmp-123`, 'half written by another Switchboard');
  fs.writeFileSync(w.packageJson, RETIRED_LOCAL_PACKAGE_JSON);
  fs.mkdirSync(path.join(w.dir, 'node_modules', 'other', 'deep'), { recursive: true });
  const c = localWrapperContents(p.root, 'switchboard-lease');
  assert.deepEqual(c.extras, [path.join('node_modules', 'other')], 'a folder that does not belong is one entry');
  assert.equal(c.retiredManifest, true);
  assert.equal(c.takeover, null, 'none of this is started by T3 in the wrapper\'s place');
  assert.deepEqual(localWrapperFolders(home), { takenOver: [], extras: ['switchboard-lease'] });

  // A package.json that is not the one Switchboard used to write is someone else's file.
  fs.writeFileSync(w.packageJson, '{"type":"module"}\n');
  const foreign = localWrapperContents(p.root, 'switchboard-lease');
  assert.equal(foreign.retiredManifest, false);
  assert.ok(foreign.extras.includes(path.join('node_modules', '@anthropic-ai', 'claude-code', 'package.json')));
});

test('the proof fails an entry T3 would not run the wrapper for, without running it', async () => {
  const { home, p } = makeHome();
  const w = localWrapperFiles(p.root, 't3-claude-default');
  fs.mkdirSync(path.dirname(w.cli), { recursive: true });
  fs.writeFileSync(w.cli, localCliText(accounts[0], { leasePath: p.lease, root: p.root }));
  fs.writeFileSync(w.cmd, localCmdText());
  const exe = installClaudeOver(w, { keepCli: true });
  let ran = 0;
  const run = async () => { ran += 1; return { code: 0, out: 'ok\n' }; };
  const [taken] = await proveLocal(['t3-claude-default'], { home, node: 'node', run });
  assert.equal(taken.ok, false);
  assert.equal(taken.cooling, false);
  assert.ok(taken.detail.includes(`T3 Code starts ${exe} in place of this wrapper`), taken.detail);
  assert.equal(ran, 0, 'an answer through the cli.js would prove something T3 never does');

  fs.rmSync(path.dirname(exe), { recursive: true });
  const [fine] = await proveLocal(['t3-claude-default'], { home, node: 'node', run });
  assert.equal(fine.ok, true);
  assert.equal(ran, 2, 'the --version check and the borrowed run');
});

test('this machine reads as failed while T3 would start a real Claude in a wrapper folder, and as out of date while other files lie there', () => {
  const settings = { t3Environments: {
    local: { id: 'local', kind: 'local', name: 'this computer', lastOk: true, leaseSha: 'node-1', accounts: [] },
    'wsl:U': { id: 'wsl:U', kind: 'wsl', name: 'U', lastOk: true, leaseSha: 'bash-1', accounts: [] },
  } };
  const shas = { leaseSha: 'bash-1', localLeaseSha: 'node-1' };
  const row = (localFolders, id = 'local') => t3EnvironmentStatus(settings, { ...shas, localFolders }).find((r) => r.id === id);

  const taken = row({ takenOver: ['t3-claude-default', 'switchboard-lease'], extras: ['t3-claude-default', 'switchboard-lease'] });
  assert.equal(taken.state, 'failed', 'though its last setup and proof passed');
  assert.match(taken.detail, /^T3 Code starts a copy of Claude found in t3-claude-default, switchboard-lease in place of Switchboard's wrapper, so those entries use this computer's own Claude sign-in; set up/);
  assert.equal(taken.foldersDirty, true, 'the start-up refresh acts on this flag');

  const untidy = row({ takenOver: [], extras: ['switchboard-lease'] });
  assert.equal(untidy.state, 'stale');
  assert.match(untidy.detail, /^its wrapper folders hold files this Switchboard does not write \(switchboard-lease\); set up/);
  assert.equal(untidy.foldersDirty, true);

  assert.deepEqual([row({ takenOver: [], extras: [] }).state, row({ takenOver: [], extras: [] }).foldersDirty], ['ok', false]);
  assert.deepEqual([row(null).state, row(null).foldersDirty], ['ok', false], 'folders that were not looked at are not judged');
  const other = row({ takenOver: ['t3-claude-default'], extras: ['t3-claude-default'] }, 'wsl:U');
  assert.deepEqual([other.state, other.foldersDirty], ['ok', false], 'this machine\'s folders say nothing about another machine');
});

test('after a real Claude was moved out, the advice to restart T3 is shown for a day, with its age and where the copy went', () => {
  const good = { ok: true, reached: true, accounts: [], proof: [] };
  const hour = 60 * 60 * 1000;
  let s = rememberT3Environment({}, LOCAL_TARGET, { ...good, restartT3: true, setAside: '/kept/here' }, { leaseSha: 'v1', now: 1000 });
  assert.equal(s.t3Environments.local.restartT3At, 1000);
  const soon = t3EnvironmentStatus(s, { now: 1000 + 3 * hour })[0];
  assert.match(soon.detail, /; a copy of Claude was moved out of its wrapper folders 3 h ago \(kept in \/kept\/here\): restart T3 Code if its Switchboard entries do not start$/);
  assert.equal(soon.state, 'ok', 'the entries are right again; only T3 has to catch up');
  assert.equal(soon.restartT3, true, 'Health shows the advice on this flag, since the line is otherwise fine');
  const later = t3EnvironmentStatus(s, { now: 1000 + 25 * hour })[0];
  assert.doesNotMatch(later.detail, /restart T3 Code/);
  assert.equal(later.restartT3, false);

  s = rememberT3Environment(s, LOCAL_TARGET, good, { leaseSha: 'v1', now: 1000 + hour });
  assert.equal(s.t3Environments.local.restartT3At, 1000, 'a later run that moved nothing does not forget when it happened');
  assert.equal(s.t3Environments.local.setAside, '/kept/here');
  assert.equal(rememberT3Environment({}, LOCAL_TARGET, good, { leaseSha: 'v1', now: 5 }).t3Environments.local.restartT3At, null);
});

test('a takeover is named beside an earlier failure, a revoked key and a failed refresh, which would otherwise hide it', () => {
  const local = { id: 'local', kind: 'local', name: 'this computer', accounts: [], leaseSha: 'v1' };
  const localFolders = { takenOver: ['switchboard-lease'], extras: ['switchboard-lease'] };
  const line = (record, settings = {}) => t3EnvironmentStatus({ ...settings, t3Environments: { local: { ...local, ...record } } }, { localLeaseSha: 'v1', localFolders })[0];
  const says = /; T3 Code starts a copy of Claude found in switchboard-lease in place of Switchboard's wrapper, so that entry uses this computer's own Claude sign-in; set up/;

  // T3 goes on running that entry on this computer's sign-in whatever else is wrong with it.
  const failedProof = line({ lastOk: false, proofFailed: ['second'] });
  assert.equal(failedProof.state, 'failed');
  assert.match(failedProof.detail, /^no answer from second/);
  assert.match(failedProof.detail, says);

  const revoked = line({ lastOk: true, keyId: 't3-gone' }, { gatewayKeys: {} });
  assert.match(revoked.detail, /^the client key it was given has been revoked/);
  assert.match(revoked.detail, says);

  const refreshFailed = line({ lastOk: true, refreshError: 'the broker refuses this computer\'s client key (revoked?).' });
  assert.equal(refreshFailed.state, 'failed');
  assert.match(refreshFailed.detail, /^the broker refuses this computer's client key/);
  assert.match(refreshFailed.detail, says);

  const alone = line({ lastOk: true });
  assert.match(alone.detail, /^T3 Code starts a copy of Claude found in switchboard-lease/, 'said once when it is the only thing wrong');
  assert.equal(alone.detail.split('T3 Code starts a copy').length, 2);
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

test('the client key is left out of claude\'s environment whatever case Windows kept its name in', () => {
  assert.deepEqual(withoutClientKey({ SWITCHBOARD_CLIENT_KEY: KEY, Switchboard_Client_Key: KEY, PATH: 'p', CLAUDE_BIN: 'c' }), { PATH: 'p', CLAUDE_BIN: 'c' });
});

/**
 * Write the local layout into a temp home and run one wrapper's cli.js the way T3 does. Nothing
 * is written beside the cli.js, as in a real setup, unless a test asks for a `manifest`.
 */
function runWrapper(home, file, account, args, env, { manifest = null } = {}) {
  const p = localPaths(home);
  fs.mkdirSync(p.root, { recursive: true });
  fs.writeFileSync(p.lease, readLocalLeaseClient());
  const w = localWrapperFiles(p.root, file);
  fs.mkdirSync(path.dirname(w.cli), { recursive: true });
  fs.writeFileSync(w.cli, localCliText(account, { leasePath: p.lease, root: p.root }));
  if (manifest == null) fs.rmSync(w.packageJson, { force: true });
  else fs.writeFileSync(w.packageJson, manifest);
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
    `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null, apiKey: process.env.ANTHROPIC_API_KEY ?? null, clientKeySeen: Object.values(process.env).includes(${JSON.stringify(KEY)}) }));`,
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
    assert.deepEqual(claude.seen(), { args: ['-p', 'hi'], token: 'stub-token', apiKey: null, clientKeySeen: false });
    assert.deepEqual(broker.reports.map((x) => [x.outcome, x.exitCode]), [['ok', 0]]);
  } finally {
    broker.server.close();
  }
});

test('a wrapper runs the same whether node takes its folder for CommonJS or for ES modules', async () => {
  const broker = await startBroker();
  try {
    // No package.json is written beside the cli.js any more, so nothing pins how node reads it;
    // and a package.json left by something installed over the wrapper says "module".
    for (const manifest of [null, '{"type":"module"}\n', '{"type":"commonjs"}\n']) {
      const home = tempDir('sb-t3local-');
      const claude = fakeClaude(home, { lines: ['ok'] });
      const env = { ...process.env, USERPROFILE: home, HOME: home, CLAUDE_BIN: claude.file, SWITCHBOARD_CLIENT_KEY: KEY, SWITCHBOARD_BROKER_URL: `http://127.0.0.1:${broker.port}` };
      const r = await runWrapper(home, 't3-claude-default', accounts[0], ['-p', 'hi'], env, { manifest });
      assert.equal(r.code, 0, `${manifest}: ${r.err}`);
      assert.equal(r.out.trim(), 'ok', String(manifest));
      assert.equal(claude.seen().token, 'stub-token', String(manifest));
    }
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
    assert.equal(claude.seen().clientKeySeen, false, 'the client key is not passed to claude');
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

test('on this machine, a sign-in the 1.4 Antigravity program left behind does not count once T3 runs 1.5', async () => {
  const { home, env } = makeHome();
  const p = localPaths(home);
  const acp = path.join(p.providers, 'profile-a', 'antigravity-acp');
  fs.mkdirSync(acp, { recursive: true });
  fs.writeFileSync(path.join(acp, 'acp_token.json'), '{"x":1}');
  const id = 'a'.repeat(64);
  fs.mkdirSync(path.join(p.tools, 'win32-x64', 'versions', id), { recursive: true });
  fs.writeFileSync(path.join(p.tools, 'win32-x64', 'versions', id, 'agy.exe'), '');
  fs.writeFileSync(path.join(p.tools, 'win32-x64', 'active.json'), JSON.stringify({ releaseId: id }));
  const antigravityKeyring = async () => false;
  const before = await inspectLocal({ home, env, antigravityKeyring });
  assert.deepEqual(before.antigravityTokenProfiles, [], 'only the old file is there');
  assert.equal(before.antigravityRuntime, true);
  assert.equal(before.antigravityKeyring, false);
  fs.writeFileSync(path.join(acp, 'antigravity-oauth-token'), '{"x":1}');
  assert.deepEqual((await inspectLocal({ home, env, antigravityKeyring })).antigravityTokenProfiles, ['profile-a']);
});

test('on Windows the 1.5 Antigravity sign-in in Credential Manager counts, and is only asked about for 1.5', async () => {
  const { home, env } = makeHome();
  const p = localPaths(home);
  let asked = 0;
  const antigravityKeyring = async () => { asked += 1; return true; };
  const id = 'b'.repeat(64);
  const versions = path.join(p.tools, 'win32-x64', 'versions', id);
  fs.mkdirSync(versions, { recursive: true });
  fs.writeFileSync(path.join(versions, 'agy_acp_server.exe'), '');
  fs.writeFileSync(path.join(p.tools, 'win32-x64', 'active.json'), JSON.stringify({ releaseId: id }));
  assert.equal((await inspectLocal({ home, env, antigravityKeyring })).antigravityKeyring, null, 'the 1.4 program does not use it');
  assert.equal(asked, 0);
  fs.rmSync(path.join(versions, 'agy_acp_server.exe'));
  fs.writeFileSync(path.join(versions, 'agy.exe'), '');
  assert.equal((await inspectLocal({ home, env, antigravityKeyring })).antigravityKeyring, true);
  assert.equal(asked, 1);
});

test('the Credential Manager listing is read for the Antigravity target line only', () => {
  assert.equal(hasAntigravityKeyringTarget('\r\nCurrently stored credentials:\r\n\r\n    Target: LegacyGeneric:target=gemini:antigravity\r\n    Type: Generic \r\n    User: someone\r\n'), true);
  assert.equal(hasAntigravityKeyringTarget('\r\nCurrently stored credentials:\r\n\r\n* NONE *\r\n'), false);
  assert.equal(hasAntigravityKeyringTarget('    Target: LegacyGeneric:target=gemini:antigravity-other\r\n'), false);
  assert.equal(hasAntigravityKeyringTarget(null), false);
  const insp = { codexStatus: {}, antigravityTokenProfiles: [], antigravityRuntime: true };
  const [signedIn] = signInsFor(LOCAL_TARGET, { ...insp, antigravityKeyring: true }, [], { antigravityIds: ['antigravity_1'] });
  assert.equal(signedIn.state, 'signed-in', 'no token file is needed when Credential Manager has it');
  const [unknown] = signInsFor(LOCAL_TARGET, { ...insp, antigravityKeyring: null }, [], { antigravityIds: ['antigravity_1'] });
  assert.equal(unknown.state, 'needs-sign-in');
});
