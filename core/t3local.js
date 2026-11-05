import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRealClaude } from '../bin/switchboard-lease.mjs';
import {
  LOCAL_TARGET, PROOF_PROMPT, OTHER_SIGN_INS_NOTE, lendableClaudeAccounts, mergeT3EnvironmentSettings,
  t3HubSecretFileName, sha256, signInsFor, enabledAntigravityIds, codexAccountsFor,
} from './t3env.js';
import { samePath } from './paths.js';

/**
 * Pointing this machine's own T3 Code (Windows) at Switchboard's Claude accounts.
 *
 * core/t3env.js does this for WSL distros and ssh machines with bash scripts. Here T3 runs on
 * Windows, which needs three things done differently:
 * - T3 on Windows cannot start a .cmd, .bat or .ps1 file as Claude (Node refuses to start them
 *   without a shell). It does start the layout an npm install of Claude leaves: a .cmd with
 *   node_modules/@anthropic-ai/claude-code/cli.js beside it, which it runs with node, and whose
 *   .cmd it uses for its `--version` check. So each account gets a folder of that shape, and the
 *   cli.js in it borrows that account through bin/switchboard-lease.mjs (the Node.js lease
 *   client) instead of being Claude itself.
 * - The work is done here in Node.js, against this machine's files, instead of in a script.
 * - A new Claude entry names ~/.claude as its config folder. An empty field makes T3 pass on
 *   whatever CLAUDE_CONFIG_DIR it was started with, which Switchboard changes when an account is
 *   picked, so an entry's conversations would land in a different folder from one start to the
 *   next. The account still comes from the lent token.
 * The entries T3 already has for this machine's own sign-ins are left as they are and reported.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_LEASE_CLIENT_PATH = path.join(here, '..', 'bin', 'switchboard-lease.mjs');

export function readLocalLeaseClient(file = LOCAL_LEASE_CLIENT_PATH) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** The hash of the Node.js lease client this Switchboard ships, or null when it cannot be read. */
export function currentLocalLeaseSha() {
  try { return sha256(readLocalLeaseClient()); } catch { return null; }
}

/** Every place on this machine the local setup reads or writes. */
export function localPaths(home = os.homedir()) {
  const root = path.join(home, '.local', 'share', 'switchboard', 't3');
  const userdata = path.join(home, '.t3', 'userdata');
  return {
    home,
    root,
    lease: path.join(root, 'switchboard-lease.mjs'),
    userdata,
    settings: path.join(userdata, 'settings.json'),
    secrets: path.join(userdata, 'secrets'),
    conf: path.join(home, '.config', 'switchboard'),
    providers: path.join(userdata, 'providers', 'antigravity'),
    tools: path.join(home, '.t3', 'tools', 'antigravity-acp'),
  };
}

/** The files of one wrapper folder, by the wrapper name (`t3-claude-default`, `switchboard-lease`). */
export function localWrapperFiles(root, file) {
  if (!/^(t3-claude-[A-Za-z0-9._-]+|switchboard-lease)$/.test(file)) throw new Error(`unexpected wrapper name ${file}`);
  const dir = path.join(root, file);
  const pkg = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code');
  return { dir, cmd: path.join(dir, `${file}.cmd`), cli: path.join(pkg, 'cli.js'), packageJson: path.join(pkg, 'package.json') };
}

/** Where this machine's T3 entries point, for mergeT3EnvironmentSettings (see posixLayout). */
export function localLayout(home = os.homedir()) {
  const { root } = localPaths(home);
  return {
    binaryPath: (file) => localWrapperFiles(root, file).cmd,
    fileOf: (p) => (String(p ?? '').split(/[\\/]/).filter(Boolean).pop() ?? '').replace(/\.cmd$/i, ''),
    claudeHome: path.join(home, '.claude'),
    join: (rel) => path.join(home, ...String(rel).split('/')),
    codexDefaultHomes: ['', '~/.codex', '~\\.codex', path.join(home, '.codex')],
  };
}

/** The .cmd T3 checks with `--version`; it starts the cli.js beside it, as npm's shim does. */
export function localCmdText() {
  return [
    '@echo off',
    'rem Written by Switchboard (switchboard t3 setup local). T3 Code runs this instead of claude.',
    'rem The program it starts sits beside it, where an npm install of Claude keeps its own.',
    'node "%~dp0node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
    '',
  ].join('\r\n');
}

/**
 * The cli.js T3 runs with node: it names the account (or, for "any account", makes sure none is
 * named) and hands over to the lease client. Paths are written in as JSON strings, so a folder
 * name with quotes or backslashes cannot change the code.
 */
export function localCliText(account, { leasePath, root }) {
  const id = account?.id ?? null;
  if (id !== null && !/^[A-Za-z0-9._-]+$/.test(String(id))) throw new Error('an account id is required');
  const label = String(account?.label ?? id ?? 'any account').replace(/[^\x20-\x7e]/g, '?');
  return [
    `// Written by Switchboard (switchboard t3 setup local). T3 Code runs this with node instead of`,
    `// claude: it borrows ${id ? `the ${label} account` : 'whichever account has the most room'} from Switchboard's lease broker.`,
    '// Running the setup again rewrites it.',
    "'use strict';",
    "const { pathToFileURL } = require('node:url');",
    id ? `process.env.SWITCHBOARD_ACCOUNT = ${JSON.stringify(id)};` : 'delete process.env.SWITCHBOARD_ACCOUNT;',
    `import(pathToFileURL(${JSON.stringify(leasePath)}).href)`,
    `  .then((m) => m.main(process.argv.slice(2), { wrappersDir: ${JSON.stringify(root)} }))`,
    '  .then((code) => { process.exitCode = code; })',
    "  .catch((e) => { process.stderr.write(`claude-leased: ${(e && e.message) || e}\\n`); process.exitCode = 78; });",
    '',
  ].join('\n');
}

/** Beside cli.js, so node reads it as CommonJS whatever a package.json further up says. */
export const LOCAL_PACKAGE_JSON = `${JSON.stringify({ name: 'switchboard-t3-wrapper', private: true, type: 'commonjs' }, null, 2)}\n`;

/** The account a local cli.js names, '*' for the "any account" one, or null. */
export function localWrapperAccountId(text) {
  const s = String(text ?? '');
  const m = /^process\.env\.SWITCHBOARD_ACCOUNT = "([A-Za-z0-9._-]+)";$/m.exec(s);
  if (m) return m[1];
  return /^delete process\.env\.SWITCHBOARD_ACCOUNT;$/m.test(s) ? '*' : null;
}

function readText(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return null; }
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Write-then-rename, as writeJsonAtomic, for text that must land exactly as given. */
export function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** The first file by one of these names in a PATH folder, or null. */
export function findOnPath(names, env = process.env) {
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    for (const n of names) {
      const p = path.join(dir, n);
      try { if (fs.statSync(p).isFile()) return p; } catch { /* not here */ }
    }
  }
  return null;
}

/** Run a program to its end with a time limit, collecting its output. */
export function runToEnd(file, args, { env = process.env, cwd, timeoutMs = 15000, shell = false } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(file, args, { env, cwd, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, out: String(e.message || e) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: null, out: `${out}${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

/**
 * A .cmd needs cmd.exe, and cmd.exe reads its command line by its own rules, so it is only ever
 * given a quoted path and fixed words.
 */
function cmdLine(file, words) {
  if (/["%^&|<>]/.test(file)) throw new Error(`a path cmd.exe cannot be given safely: ${file}`);
  return `"${file}" ${words.join(' ')}`;
}

/**
 * The Codex accounts as they are on this machine: each one's sign-in is in its own registered
 * folder, so that is the folder its T3 entry uses (other machines use ~/.codex-t3/<name>).
 */
export function localCodexAccounts(registry, home = os.homedir()) {
  const byId = new Map((registry?.accounts ?? []).map((a) => [a.id, a]));
  return codexAccountsFor(registry).map((acc) => {
    const own = byId.get(acc.id)?.home;
    const absHome = own ? path.resolve(own) : path.join(home, ...acc.relHome.split('/'));
    return { ...acc, absHome, shadow: !samePath(absHome, path.join(home, '.codex')) };
  });
}

/**
 * Facts about this machine that the plan depends on, in the shape parseInspect gives for a
 * remote target, so the same planner and sign-in rules read it. Read-only.
 *   brokerUrls      tried in order with the saved key
 *   fetchImpl       fetch, for tests
 *   codexStatus(a)  Codex's own answer for one account: signed-in | not-signed-in | unknown
 */
export async function inspectLocal({ home = os.homedir(), env = process.env, brokerUrls = [], fetchImpl = fetch, codexAccounts = [], codexStatus = null } = {}) {
  const p = localPaths(home);
  const out = {
    home, claude: findRealClaude({ env, home, skipDir: p.root }), node: findOnPath(['node.exe', 'node'], env),
    t3: isDir(p.userdata), settings: null, settingsError: null, settingsSha: 'none', settingsText: null,
    wrappers: {}, wrapperTexts: {}, lease: 'missing', key: 'missing', keyText: null, broker: null, probes: [],
    hubSecrets: [], codexBin: null, codexStatus: {}, antigravityTokenProfiles: [], antigravityRuntime: null,
    nodeState: null, osFamily: '', missingTools: [],
  };
  out.nodeState = out.node ? 'found' : 'missing';

  const settingsText = readText(p.settings);
  if (settingsText != null) {
    out.settingsText = settingsText;
    out.settingsSha = sha256(settingsText);
    try { out.settings = JSON.parse(settingsText); } catch (e) { out.settingsError = String(e.message || e); }
  }

  const lease = readText(p.lease);
  if (lease != null) out.lease = `file:${sha256(lease.replace(/\r\n/g, '\n'))}`;

  let names = [];
  try { names = fs.readdirSync(p.root); } catch { names = []; }
  for (const name of names) {
    if (!/^(t3-claude-[A-Za-z0-9._-]+|switchboard-lease)$/.test(name)) continue;
    const text = readText(localWrapperFiles(p.root, name).cli);
    if (text == null) continue;
    out.wrapperTexts[name] = text;
    const who = localWrapperAccountId(text);
    if (who && who !== '*') out.wrappers[name] = who;
  }

  const key = env.SWITCHBOARD_CLIENT_KEY || (readText(path.join(p.conf, 'client-key')) ?? '').split(/\r?\n/)[0].trim();
  if (key) { out.key = 'present'; out.keyText = key; }
  for (const url of brokerUrls) {
    let code = 0;
    try {
      const res = await fetchImpl(`${url}/v1/info`, { headers: { Authorization: `Bearer ${key || 'sb-key-none'}` }, signal: AbortSignal.timeout(5000) });
      code = res.status;
    } catch { code = 0; }
    out.probes.push({ url, code });
    if ([200, 401, 403].includes(code)) { out.broker = { url, code }; break; }
  }

  try { out.hubSecrets = fs.readdirSync(p.secrets).filter((f) => /^usage-limit-source-.+\.bin$/.test(f)); } catch { out.hubSecrets = []; }

  out.codexBin = findOnPath(['codex.cmd', 'codex.exe'], env);
  if (out.codexBin && codexStatus) {
    for (const acc of codexAccounts) out.codexStatus[acc.relHome] = await codexStatus(acc, out.codexBin);
  } else if (out.codexBin) {
    for (const acc of codexAccounts) out.codexStatus[acc.relHome] = await localCodexStatus(acc, out.codexBin, env);
  }

  try {
    for (const profile of fs.readdirSync(p.providers)) {
      try { if (fs.statSync(path.join(p.providers, profile, 'antigravity-acp', 'acp_token.json')).size > 0) out.antigravityTokenProfiles.push(profile); } catch { /* none */ }
    }
  } catch { /* no Antigravity profile yet */ }
  out.antigravityRuntime = false;
  try {
    for (const plat of fs.readdirSync(p.tools)) {
      try { if (fs.readdirSync(path.join(p.tools, plat, 'versions')).length) out.antigravityRuntime = true; } catch { /* none */ }
    }
  } catch { /* not installed */ }
  return out;
}

/**
 * Codex's own answer about one account's sign-in. A folder that is not there has no sign-in, and
 * "not logged in" is the only answer read as signed out; anything else is unknown.
 */
export async function localCodexStatus(acc, codexBin, env = process.env) {
  if (!isDir(acc.absHome)) return 'not-signed-in';
  const shell = /\.cmd$/i.test(codexBin);
  const res = await runToEnd(shell ? cmdLine(codexBin, ['login', 'status']) : codexBin, shell ? [] : ['login', 'status'], { env: { ...env, CODEX_HOME: acc.absHome }, shell, timeoutMs: 15000 });
  if (res.code === 0) return 'signed-in';
  return /not logged in/i.test(res.out) ? 'not-signed-in' : 'unknown';
}

/** The program and environment for Codex's device-code sign-in on this machine. */
export function localCodexSignInCommand(codexBin, acc, env = process.env) {
  const shell = /\.cmd$/i.test(codexBin);
  return {
    file: shell ? cmdLine(codexBin, ['login', '--device-auth']) : codexBin,
    args: shell ? [] : ['login', '--device-auth'],
    shell,
    env: { ...env, CODEX_HOME: acc.absHome },
  };
}

/**
 * One tiny borrowed run per wrapper, the way T3 starts it (node running the cli.js), plus T3's
 * own `--version` check through the .cmd. Returns parseProve's shape.
 */
export async function proveLocal(files, { home = os.homedir(), node, env = process.env, run = runToEnd, timeoutMs = 150000, model = 'haiku' } = {}) {
  const { root } = localPaths(home);
  const results = [];
  for (const file of files) {
    const w = localWrapperFiles(root, file);
    const version = await run(cmdLine(w.cmd, ['--version']), [], { env, cwd: home, shell: true, timeoutMs: 30000 });
    if (version.code !== 0) {
      results.push({ file, ok: false, cooling: false, code: version.code, detail: `T3's --version check through ${path.basename(w.cmd)} failed: ${String(version.out).trim().slice(-300)}` });
      continue;
    }
    const res = await run(node, [w.cli, '-p', PROOF_PROMPT, '--model', model], { env, cwd: home, timeoutMs });
    const detail = String(res.out ?? '').trim();
    const said = detail.split(/\r?\n/).map((l) => l.trim().toLowerCase().replace(/[.!]$/, ''));
    results.push({ file, ok: res.code === 0 && said.includes('ok'), cooling: res.code === 75, code: res.code, detail: detail.slice(-300) });
  }
  return results;
}

/**
 * Set up this machine's own T3. Takes the same `deps` as setupT3Environment (registry,
 * loadSettings, saveSettings, canLend, port, hubUrl, codexAccounts, antigravity, createKey), plus:
 *   leaseClient   the text of bin/switchboard-lease.mjs
 *   home, env     this machine's home folder and environment (tests point them elsewhere)
 *   platform      process.platform
 *   inspect(o)    inspectLocal, for tests
 *   prove(f, o)   proveLocal, for tests
 * and the same options. Returns the same report shape, so the CLI, the tray and the saved
 * environment list treat it like any other target.
 */
export async function setupLocalT3Environment(deps, { prove = true, refreshOnly = false, now = Date.now() } = {}) {
  const target = LOCAL_TARGET;
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const p = localPaths(home);
  const report = {
    target: target.id, ok: false, reached: false, steps: [], accounts: [], skipped: [], leftovers: [],
    proof: [], signIns: [], keyId: null, keyCreated: false, error: null, backup: null, port: deps.port ?? 8318, brokerUrl: null,
  };
  const step = (text) => report.steps.push(text);
  const fail = (text) => { report.error = text; return report; };

  if ((deps.platform ?? process.platform) !== 'win32') return fail('"local" is this Windows machine\'s own T3; on Linux or macOS set it up from the Windows machine with wsl: or ssh:.');
  const { lendable, skipped } = lendableClaudeAccounts(deps.registry, deps.loadSettings(), { canLend: deps.canLend ?? null });
  report.skipped = skipped;
  report.accounts = lendable.map((a) => ({ id: a.id, label: a.label }));
  if (!lendable.length) return fail('Switchboard has no Claude account it can lend (each needs a lane with a live setup token).');

  const port = report.port;
  const codexAccounts = refreshOnly ? [] : (deps.codexAccounts ?? []);
  const wantAntigravity = !refreshOnly && deps.antigravity === true;
  const inspect = deps.inspect ?? inspectLocal;
  const layout = localLayout(home);
  report.reached = true;

  let inspected = null;
  let applied = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    inspected = await inspect({ home, env, brokerUrls: [`http://127.0.0.1:${port}`], codexAccounts });
    if (inspected.settingsError) return fail(`T3's settings file on this computer cannot be read safely (${inspected.settingsError}); not touching it.`);
    if (attempt === 1) {
      if (!inspected.t3) return fail('T3 Code has never run as this user here (no ~/.t3/userdata). Open T3 Code first.');
      if (!inspected.node) return fail('Node.js is not on PATH here, and T3 runs the Switchboard entries with it. Install Node.js 22 from https://nodejs.org, then run this again.');
      if (!inspected.claude) return fail('Claude Code is not installed here (no ~/.local/bin/claude.exe and no claude on PATH). Install it, then run this again.');
      if (!inspected.broker) return fail(`Switchboard's broker does not answer on this computer (tried ${inspected.probes.map((x) => x.url).join(', ') || 'no address'}). Check Switchboard is running with the gateway on.`);
      step(`This computer: claude at ${inspected.claude}, node at ${inspected.node}, broker at ${inspected.broker.url}.`);

      // The key file here may be shared with other tools on this machine, so one the broker
      // accepts is kept. The start-up refresh never makes one (a refused key may be revoked on
      // purpose).
      if (inspected.broker.code === 200 && inspected.key === 'present') {
        step('Kept the client key already on this computer (the broker accepts it).');
      } else if (refreshOnly) {
        return fail('the broker refuses this computer\'s client key (revoked?). Run the setup for it to issue a new one.');
      } else {
        const made = deps.createKey(deps.loadSettings(), `T3 ${target.name}`);
        deps.saveSettings(made.settings);
        writeTextAtomic(path.join(p.conf, 'client-key'), `${made.secret}\n`);
        inspected.keyText = made.secret;
        report.keyId = made.key?.id ?? null;
        report.keyCreated = Boolean(made.created);
        step(`${inspected.key === 'present' ? 'The broker refused the key here, so this computer gets' : 'Gave this computer'} its own client key "${made.key?.label ?? `T3 ${target.name}`}".`);
      }
    }

    const merged = mergeT3EnvironmentSettings(inspected.settings ?? {}, {
      home, accounts: lendable, wrappers: inspected.wrappers, hubUrl: deps.hubUrl ?? null,
      codexAccounts, antigravity: wantAntigravity, layout,
    });
    report.leftovers = merged.leftovers;
    const anyFile = 'switchboard-lease';
    const wanted = [
      ...lendable.map((a) => ({ file: merged.wrapperFiles[a.id], text: localCliText(a, { leasePath: p.lease, root: p.root }) })),
      { file: anyFile, text: localCliText(null, { leasePath: p.lease, root: p.root }) },
    ];
    const toWrite = wanted
      .filter((w) => inspected.wrapperTexts[w.file] !== w.text)
      .filter((w) => !refreshOnly || w.file in inspected.wrapperTexts);
    const leaseCurrent = inspected.lease === `file:${sha256(deps.leaseClient)}`;
    if (!leaseCurrent) {
      writeTextAtomic(p.lease, deps.leaseClient);
      step(`Installed the lease client (${p.lease}).`);
    } else {
      step('The lease client here is already this version.');
    }
    for (const w of toWrite) {
      const f = localWrapperFiles(p.root, w.file);
      writeTextAtomic(f.cmd, localCmdText());
      writeTextAtomic(f.packageJson, LOCAL_PACKAGE_JSON);
      writeTextAtomic(f.cli, w.text);
    }
    step(toWrite.length ? `Wrote ${toWrite.length} account wrapper${toWrite.length === 1 ? '' : 's'}: ${toWrite.map((w) => w.file).join(', ')}.` : 'The account wrappers here are already up to date.');

    // The hub key follows the client key, as on the other machines.
    const hubKnown = merged.hubId && (!refreshOnly || inspected.settings?.usageLimitSources?.[merged.hubId]);
    if (hubKnown && inspected.keyText) {
      const hf = path.join(p.secrets, t3HubSecretFileName(merged.hubId));
      if (readText(hf) !== inspected.keyText) {
        try { writeTextAtomic(hf, inspected.keyText); step('Saved the quota hub key for T3.'); } catch { step('Could not save the quota hub key; add it in T3 (Settings, Providers, Usage providers).'); }
      }
    }

    if (!refreshOnly && merged.changes.length) {
      // Written only if T3 has not saved it since it was read; otherwise planned again.
      const nowText = readText(p.settings);
      if ((nowText == null ? 'none' : sha256(nowText)) !== inspected.settingsSha) {
        if (attempt === 1) { step('T3 saved its settings while this ran; planning again.'); continue; }
        return fail('T3 kept changing its settings here; try again in a moment.');
      }
      if (nowText != null) {
        const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
        report.backup = `${p.settings}.before-switchboard-${stamp}`;
        fs.copyFileSync(p.settings, report.backup);
      }
      writeTextAtomic(p.settings, `${JSON.stringify(merged.settings, null, 2)}\n`);
      for (const c of merged.changes) step(`T3: ${c}.`);
      if (report.backup) step(`T3's previous settings are kept at ${report.backup}.`);
    } else if (!refreshOnly) {
      step('T3 already had every entry; its settings were not touched.');
    }
    applied = { merged, files: wanted.map((w) => w.file) };
    break;
  }
  if (!applied) return fail('T3 kept changing its settings here; try again in a moment.');

  report.notes = [OTHER_SIGN_INS_NOTE];
  if (!refreshOnly) {
    report.signIns = signInsFor(target, inspected, codexAccounts, { antigravityIds: wantAntigravity ? enabledAntigravityIds(applied.merged.settings) : null });
    report.signInsChecked = true;
    report.codexAccountIds = codexAccounts.map((a) => a.id);
    report.antigravity = wantAntigravity;
  }
  const missing = report.signIns.filter((x) => x.state !== 'signed-in');
  if (report.signIns.length) step(missing.length ? `Still to sign in on this computer: ${missing.map((x) => x.what).join(', ')}.` : `Signed in here already: ${report.signIns.map((x) => x.what).join(', ')}.`);

  if (prove && !refreshOnly) {
    // The "any account" wrapper is proved too: it is the one that picks a lane by itself.
    const results = await (deps.prove ?? proveLocal)(applied.files, { home, node: inspected.node, env });
    report.proof = results.map((r) => {
      const account = lendable.find((a) => applied.merged.wrapperFiles[a.id] === r.file);
      return { ...r, account: account?.id ?? null, label: account?.label ?? (r.file === 'switchboard-lease' ? 'any account' : r.file) };
    });
    const bad = report.proof.filter((r) => !r.ok && !r.cooling);
    const cooling = report.proof.filter((r) => r.cooling);
    if (bad.length) step(`Proof: ${bad.length} of ${report.proof.length} entries did not answer.`);
    else step(`Proof: ${report.proof.length - cooling.length} of ${report.proof.length} entries answered through Switchboard.`);
    if (cooling.length) step(`Not proven, because the account is out of allowance right now (not a setup fault): ${cooling.map((r) => r.label).join(', ')}.`);
    report.ok = bad.length === 0;
  } else {
    if (!refreshOnly) step('Skipped the proof run.');
    report.ok = true;
  }
  return report;
}
