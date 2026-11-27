import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findRealClaude } from '../bin/switchboard-lease.mjs';
import {
  LOCAL_TARGET, PROOF_PROMPT, OTHER_SIGN_INS_NOTE, lendableClaudeAccounts, mergeT3EnvironmentSettings,
  t3HubSecretFileName, sha256, signInsFor, enabledAntigravityIds, codexAccountsFor,
  ANTIGRAVITY_TOKEN_FILES, antigravityTokenStore, signedInAntigravityProfiles,
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
 * - Only those two files may be in such a folder, because T3 decides what to start, and what to
 *   offer, from what else it finds there (read from T3 Code 0.1.12). It looks for
 *   node_modules/@anthropic-ai/claude-code/bin/claude.exe BEFORE cli.js, so a real Claude put
 *   there is started in the wrapper's place, with the sign-in of the entry's config folder and
 *   nothing borrowed, while T3 goes on showing the entry as healthy. And a package.json beside
 *   cli.js makes T3 take the folder for an npm install of Claude and offer to update it with
 *   `npm install -g --prefix <that folder>`, which is how a real Claude gets there. So no
 *   package.json is written, and every setup and start-up refresh moves anything else out.
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
    // Beside the wrappers, not among them, and on the same drive, so moving is a rename.
    aside: path.join(home, '.local', 'share', 'switchboard', 't3-set-aside'),
    userdata,
    settings: path.join(userdata, 'settings.json'),
    secrets: path.join(userdata, 'secrets'),
    conf: path.join(home, '.config', 'switchboard'),
    providers: path.join(userdata, 'providers', 'antigravity'),
    tools: path.join(home, '.t3', 'tools', 'antigravity-acp'),
  };
}

const WRAPPER_NAME = /^(t3-claude-[A-Za-z0-9._-]+|switchboard-lease)$/;

/** The files of one wrapper folder, by the wrapper name (`t3-claude-default`, `switchboard-lease`). */
export function localWrapperFiles(root, file) {
  if (!WRAPPER_NAME.test(file)) throw new Error(`unexpected wrapper name ${file}`);
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
 * name with quotes or backslashes cannot change the code. Nothing beside it tells node whether
 * it is CommonJS or an ES module (see RETIRED_LOCAL_PACKAGE_JSON), so it uses only what both
 * allow: import() and no require.
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
    id ? `process.env.SWITCHBOARD_ACCOUNT = ${JSON.stringify(id)};` : 'delete process.env.SWITCHBOARD_ACCOUNT;',
    "import('node:url')",
    `  .then(({ pathToFileURL }) => import(pathToFileURL(${JSON.stringify(leasePath)}).href))`,
    `  .then((m) => m.main(process.argv.slice(2), { wrappersDir: ${JSON.stringify(root)} }))`,
    '  .then((code) => { process.exitCode = code; })',
    "  .catch((e) => { process.stderr.write(`claude-leased: ${(e && e.message) || e}\\n`); process.exitCode = 78; });",
    '',
  ].join('\n');
}

/**
 * Versions up to 0.36.6 wrote this beside cli.js, so node read it as CommonJS. It is no longer
 * written: a package.json there is what makes T3 Code offer to install Claude over the wrapper
 * (see the note at the top of this file). The text is kept so that a copy an earlier version
 * left behind is known to be Switchboard's own and is simply removed.
 */
export const RETIRED_LOCAL_PACKAGE_JSON = `${JSON.stringify({ name: 'switchboard-t3-wrapper', private: true, type: 'commonjs' }, null, 2)}\n`;

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

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** A real folder. A link to one, which isDir follows, is not. */
function isOwnDir(p) {
  try { return fs.lstatSync(p).isDirectory(); } catch { return false; }
}

/**
 * The wrapper folders under `root`, by name: a folder named as one that holds its own
 * <name>.cmd, which is the file a T3 entry points at. The name alone is not enough to go by. A
 * copy someone kept as t3-claude-default-old fits the pattern too; no T3 entry runs it, so
 * nothing true can be said about what T3 starts there, and it is not Switchboard's to take apart.
 */
export function localWrapperNames(root) {
  let names = [];
  try { names = fs.readdirSync(root); } catch { names = []; }
  return names.filter((name) => WRAPPER_NAME.test(name) && isFile(path.join(root, name, `${name}.cmd`))).sort();
}

/**
 * The program T3 would start in place of this wrapper, or null: a file at
 * node_modules/@anthropic-ai/claude-code/bin/claude.exe, the one place T3 looks before cli.js.
 */
export function localWrapperTakeover(root, file) {
  const exe = path.join(path.dirname(localWrapperFiles(root, file).cli), 'bin', 'claude.exe');
  try { return fs.statSync(exe).isFile() ? exe : null; } catch { return null; }
}

/**
 * What is in one wrapper folder besides the two files Switchboard writes there. Read-only.
 *   extras           everything else, as paths inside the folder; a folder that does not
 *                    belong is one entry, whatever it holds
 *   retiredManifest  the package.json an earlier Switchboard wrote is still there
 *   takeover         the program T3 would start in the wrapper's place, or null
 * A file that a write in progress has not renamed yet (`.tmp-<pid>`) is left out, so one
 * Switchboard never moves a file another is in the middle of writing. A wrapper folder that is
 * itself a link is not looked into: what lies behind it is someone else's folder, so nothing in
 * it is listed and nothing is ever moved out of it. A real Claude that T3 would start through
 * the link is still reported, and stops the setup.
 */
export function localWrapperContents(root, file) {
  const f = localWrapperFiles(root, file);
  const extras = [];
  let retiredManifest = false;
  if (!isOwnDir(f.dir)) return { extras, retiredManifest, takeover: localWrapperTakeover(root, file) };
  // null marks a file, an object a folder and what may be in it.
  const ours = { [`${file}.cmd`]: null, node_modules: { '@anthropic-ai': { 'claude-code': { 'cli.js': null } } } };
  const walk = (dir, wanted, rel) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (/\.tmp-\d+$/.test(entry.name)) continue;
      const at = rel ? path.join(rel, entry.name) : entry.name;
      const want = Object.hasOwn(wanted, entry.name) ? wanted[entry.name] : undefined;
      // A link counts as neither a file nor a folder of ours, so it is never followed.
      const fits = want === null ? entry.isFile() : want !== undefined && entry.isDirectory();
      if (fits) {
        if (want !== null) walk(path.join(dir, entry.name), want, at);
      } else if (path.join(dir, entry.name) === f.packageJson && readText(f.packageJson) === RETIRED_LOCAL_PACKAGE_JSON) {
        retiredManifest = true;
      } else {
        extras.push(at);
      }
    }
  };
  walk(f.dir, ours, '');
  return { extras, retiredManifest, takeover: localWrapperTakeover(root, file) };
}

/**
 * The wrapper folders on this machine that are not as Switchboard left them, for `t3 status`,
 * the Gateway tab, Health and the start-up refresh. Looking at the folders is the only way to
 * know: T3 shows an entry whose wrapper was taken over as healthy, and so did Switchboard's proof.
 *   takenOver  folders where T3 starts a real Claude in the wrapper's place
 *   extras     folders holding anything Switchboard does not write, those above included
 */
export function localWrapperFolders(home = os.homedir()) {
  const { root } = localPaths(home);
  const out = { takenOver: [], extras: [] };
  for (const name of localWrapperNames(root)) {
    const c = localWrapperContents(root, name);
    if (c.takeover) out.takenOver.push(name);
    if (c.takeover || c.extras.length || c.retiredManifest) out.extras.push(name);
  }
  return out;
}

/** A folder under `base` named for this moment, that nothing is in yet. It is not created. */
function freshAsideDir(base, now) {
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let dir = path.join(base, stamp);
  for (let n = 2; fs.existsSync(dir); n += 1) dir = path.join(base, `${stamp}-${n}`);
  return dir;
}

/**
 * Take everything Switchboard does not write out of one wrapper folder. What an earlier
 * Switchboard wrote (the retired package.json) is removed; the rest is moved under `aside`,
 * keeping its place in the folder. Moved rather than deleted for two reasons: it is not
 * Switchboard's to throw away, and it may be a program that is running, which Windows lets be
 * renamed, its folder with it, but not deleted. A folder that a process has open (as its
 * working folder, or through a file open inside it) cannot be renamed, so one that will not
 * move whole is moved piece by piece. Returns what moved, what would not (`stuck`), and for each
 * of those what the system said (`why`), so the reason reported is never a guess.
 * `rename` exists for tests.
 */
export function clearLocalWrapper(root, file, aside, { rename = fs.renameSync } = {}) {
  const f = localWrapperFiles(root, file);
  const found = localWrapperContents(root, file);
  const result = { file, moved: [], stuck: [], why: {}, removedManifest: false, takeover: Boolean(found.takeover) };
  const refused = (rel, e) => { result.stuck.push(rel); result.why[rel] = String(e?.code || e?.message || e); };
  if (found.retiredManifest) {
    try { fs.rmSync(f.packageJson); result.removedManifest = true; } catch (e) { refused(path.relative(f.dir, f.packageJson), e); }
  }
  const move = (rel) => {
    const from = path.join(f.dir, rel);
    const to = path.join(aside, file, rel);
    let refusal = null;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      rename(from, to);
      result.moved.push(rel);
      return;
    } catch (e) {
      refusal = e;
      // The folders just made for it are taken away again while they are empty. A piece that
      // never moves would otherwise leave one more empty tree under `aside` at every start.
      for (let dir = path.dirname(to); !path.relative(aside, dir).startsWith('..'); dir = path.dirname(dir)) {
        try { fs.rmdirSync(dir); } catch { break; }
      }
    }
    // lstat, not stat: a link to a folder elsewhere is moved as the link it is or not at all.
    let inside = null;
    try { if (fs.lstatSync(from).isDirectory()) inside = fs.readdirSync(from); } catch { inside = null; }
    if (inside === null) { refused(rel, refusal); return; }
    const stuckBefore = result.stuck.length;
    for (const name of inside) move(path.join(rel, name));
    try { fs.rmdirSync(from); } catch (e) { if (result.stuck.length === stuckBefore) refused(rel, e); }
  };
  for (const rel of found.extras) move(rel);
  return result;
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
 *   antigravityKeyring()  whether Credential Manager holds the Antigravity sign-in, for tests
 */
export async function inspectLocal({ home = os.homedir(), env = process.env, brokerUrls = [], fetchImpl = fetch, codexAccounts = [], codexStatus = null, antigravityKeyring = localAntigravityKeyring } = {}) {
  const p = localPaths(home);
  const out = {
    home, claude: findRealClaude({ env, home, skipDir: p.root }), node: findOnPath(['node.exe', 'node'], env),
    t3: isDir(p.userdata), settings: null, settingsError: null, settingsSha: 'none', settingsText: null,
    wrappers: {}, wrapperTexts: {}, wrapperExtras: {}, lease: 'missing', key: 'missing', keyText: null, broker: null, probes: [],
    hubSecrets: [], codexBin: null, codexStatus: {}, antigravityTokenProfiles: [], antigravityRuntime: null,
    antigravityKeyring: null, nodeState: null, osFamily: '', missingTools: [],
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
  const wrapperFolders = new Set(localWrapperNames(p.root));
  for (const name of names) {
    if (!WRAPPER_NAME.test(name)) continue;
    // Noted before the cli.js is read, because what is installed over a wrapper can remove it,
    // and a folder that lost its cli.js that way is still one of Switchboard's to put right.
    if (wrapperFolders.has(name)) {
      const contents = localWrapperContents(p.root, name);
      if (contents.takeover || contents.extras.length || contents.retiredManifest) out.wrapperExtras[name] = contents;
    }
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

  // The same reading as the inspection script: every non-empty token file, then the one the
  // program T3 runs now reads (ANTIGRAVITY_TOKEN_FILES in t3env.js).
  const found = [];
  try {
    for (const profile of fs.readdirSync(p.providers)) {
      for (const file of Object.values(ANTIGRAVITY_TOKEN_FILES)) {
        try { if (fs.statSync(path.join(p.providers, profile, 'antigravity-acp', file)).size > 0) found.push({ profile, file }); } catch { /* none */ }
      }
    }
  } catch { /* no Antigravity profile yet */ }
  let store = null;
  out.antigravityRuntime = false;
  try {
    for (const plat of fs.readdirSync(p.tools)) {
      try { if (fs.readdirSync(path.join(p.tools, plat, 'versions')).length) out.antigravityRuntime = true; } catch { /* none */ }
      try {
        const id = JSON.parse(fs.readFileSync(path.join(p.tools, plat, 'active.json'), 'utf8'))?.releaseId;
        if (typeof id !== 'string' || !/^[0-9a-f]{16,}$/.test(id)) continue;
        const s = antigravityTokenStore(fs.readdirSync(path.join(p.tools, plat, 'versions', id)));
        store = store === 'old' || s === 'old' ? 'old' : store ?? s;
      } catch { /* no active version */ }
    }
  } catch { /* not installed */ }
  out.antigravityTokenProfiles = signedInAntigravityProfiles(found, store);
  // On Windows the 1.5 program keeps its Google sign-in in Windows Credential Manager, whatever
  // T3 asks of it, so the profile folder holds no token file at all and only the old 1.4 file
  // is left there. One entry serves every T3 profile of this Windows user.
  out.antigravityKeyring = store === 'new' && antigravityKeyring ? await antigravityKeyring() : null;
  return out;
}

/**
 * Whether Windows Credential Manager holds the Antigravity 1.5 sign-in: true, false, or null
 * when it cannot be asked. cmdkey lists target and user names only and never prints a stored
 * secret, and only the presence of the target line is read.
 */
export function localAntigravityKeyring() {
  if (process.platform !== 'win32') return Promise.resolve(null);
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn('cmdkey', [`/list:${ANTIGRAVITY_KEYRING_TARGET}`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve(null); return; }
    const timer = setTimeout(() => { child.kill(); resolve(null); }, 5000);
    child.stdout.on('data', (c) => (out += c));
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? hasAntigravityKeyringTarget(out) : null);
    });
  });
}

export const ANTIGRAVITY_KEYRING_TARGET = 'gemini:antigravity';

/** cmdkey names the entry "LegacyGeneric:target=gemini:antigravity" on the Target line. */
export function hasAntigravityKeyringTarget(cmdkeyOutput) {
  return /^\s*Target:.*[=:\s]gemini:antigravity\s*$/m.test(String(cmdkeyOutput ?? ''));
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
 * own `--version` check through the .cmd. A wrapper T3 would pass over for a real Claude in its
 * folder fails without being run: an answer through the cli.js would prove something T3 never
 * does. Returns parseProve's shape.
 */
export async function proveLocal(files, { home = os.homedir(), node, env = process.env, run = runToEnd, timeoutMs = 150000, model = 'haiku' } = {}) {
  const { root } = localPaths(home);
  const results = [];
  for (const file of files) {
    const w = localWrapperFiles(root, file);
    const takeover = localWrapperTakeover(root, file);
    if (takeover) {
      results.push({ file, ok: false, cooling: false, code: null, detail: `T3 Code starts ${takeover} in place of this wrapper, so the entry would use this computer's own Claude sign-in and borrow nothing. Run the setup again: it moves that copy out, or says why it cannot.` });
      continue;
    }
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
 *   rename(a, b)  fs.renameSync, for tests
 * and the same options. Returns the same report shape, so the CLI, the tray and the saved
 * environment list treat it like any other target, plus `setAside` (where what was moved out of
 * the wrapper folders went) and `restartT3` (a real Claude was moved out, and T3 keeps looking
 * for it until it is restarted).
 */
export async function setupLocalT3Environment(deps, { prove = true, refreshOnly = false, now = Date.now() } = {}) {
  const target = LOCAL_TARGET;
  const home = deps.home ?? os.homedir();
  const env = deps.env ?? process.env;
  const p = localPaths(home);
  const report = {
    target: target.id, ok: false, reached: false, steps: [], accounts: [], skipped: [], leftovers: [],
    proof: [], signIns: [], keyId: null, keyCreated: false, error: null, backup: null, port: deps.port ?? 8318, brokerUrl: null,
    setAside: null, restartT3: false, refreshOnly,
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
    // Folders are cleared before they are written, and by the start-up refresh too: what T3
    // starts is decided by what lies in the folder, not by anything the wrapper says.
    const extras = inspected.wrapperExtras ?? {};
    let cleared = [];
    if (Object.keys(extras).length) {
      const aside = freshAsideDir(p.aside, now);
      cleared = Object.keys(extras).map((file) => clearLocalWrapper(p.root, file, aside, { rename: deps.rename }));
      const manifests = cleared.filter((c) => c.removedManifest).length;
      if (manifests) step(`Removed the package.json an earlier Switchboard wrote beside ${manifests} wrapper${manifests === 1 ? '' : 's'}: it let T3 Code offer to install Claude over ${manifests === 1 ? 'it' : 'them'}.`);
      const movedFrom = cleared.filter((c) => c.moved.length).map((c) => c.file);
      if (movedFrom.length) {
        report.setAside = aside;
        step(`Moved what is not Switchboard's out of ${movedFrom.join(', ')}; it is kept in ${aside}.`);
      }
      const stuck = cleared.filter((c) => c.stuck.length);
      if (stuck.length) step(`Could not move ${stuck.map((c) => `${c.stuck.map((at) => `${at} (the system said ${c.why[at]})`).join(', ')} in ${c.file}`).join('; ')}.`);
      const freed = cleared.filter((c) => c.takeover && !localWrapperTakeover(p.root, c.file)).map((c) => c.file);
      if (freed.length) {
        report.restartT3 = true;
        step(`A copy of Claude was in ${freed.join(', ')}, and T3 Code was starting it in place of the wrapper, on this computer's own Claude sign-in. Restart T3 Code now: it goes on looking for that copy until it is restarted, so ${freed.length === 1 ? 'that entry does' : 'those entries do'} not start until then.`);
      }
    }

    // What to write is decided from the folders as they are now, after the clearing, not from
    // the earlier reading: a wrapper file that went when something was installed over the
    // wrapper, or that was moved out with the rest (a folder in its place, its name in other
    // letters), is written again in this same run.
    const toWrite = wanted
      .filter((w) => { const f = localWrapperFiles(p.root, w.file); return readText(f.cli) !== w.text || !isFile(f.cmd); })
      // The refresh brings the wrapper folders that are there up to date and adds none.
      .filter((w) => !refreshOnly || isDir(localWrapperFiles(p.root, w.file).dir));
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
      writeTextAtomic(f.cli, w.text);
    }
    step(toWrite.length ? `Wrote ${toWrite.length} account wrapper${toWrite.length === 1 ? '' : 's'}: ${toWrite.map((w) => w.file).join(', ')}.` : 'The account wrappers here are already up to date.');

    // Asked only now, after the wrappers are written, so that every folder that was cleared has
    // its wrapper back even when the run stops here. A cli.js beside a copy T3 prefers does no
    // harm. The reason given is what the system said when the copy would not move, never a
    // guess; a copy behind a wrapper folder that is a link was not tried at all, and has none.
    const taken = localWrapperNames(p.root).filter((name) => localWrapperTakeover(p.root, name));
    if (taken.length) {
      const said = (name) => [...new Set(Object.values(cleared.find((c) => c.file === name)?.why ?? {}))].join(', ');
      const named = taken.map((name) => (said(name) ? `${name} (the system said ${said(name)})` : name)).join(', ');
      return fail(`a copy of Claude is in ${named} and could not be moved out, so T3 Code starts it in place of Switchboard's wrapper and ${taken.length === 1 ? 'that entry borrows' : 'those entries borrow'} nothing. If something is still installing into that folder, let it finish. Close T3 Code and anything else that may have the file open, then run the setup again.`);
    }

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
