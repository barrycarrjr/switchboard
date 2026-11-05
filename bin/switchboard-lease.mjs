// Reference client for Switchboard's Contract v1 lease broker, for Windows (Node.js).
//
// The same job as bin/switchboard-lease, which is bash and serves WSL and LAN machines: asks the
// Switchboard broker for a credential lease, runs the real claude with that lease's env for this
// one process, and reports the outcome so the broker can cool the lane down or mark a revoked
// setup-token dead. Credentials stay in this process's memory and the child's environment;
// nothing is written to a credential file and nothing is passed on a command line.
//
// T3 Code on Windows cannot start a .cmd or .ps1 file as Claude, but it does start the layout an
// npm install of Claude leaves (a .cmd with node_modules/@anthropic-ai/claude-code/cli.js beside
// it), and runs that cli.js with node. `switchboard t3 setup local` writes that layout per account,
// and each cli.js imports this file and calls main(). Plain Node, no dependencies, Node 18 or newer.
//
// Env in:
//   SWITCHBOARD_CLIENT_KEY  optional if saved in ~/.config/switchboard/client-key (or ~/.switchboard-key)
//   SWITCHBOARD_BROKER_URL  optional if saved in ~/.config/switchboard/broker-url (or ~/.switchboard-url);
//                           otherwise 127.0.0.1 on the port in ~/.config/switchboard/broker-port or 8318
//   SWITCHBOARD_ACCOUNT     optional account id hint
//   CLAUDE_BIN              optional path to the real claude (otherwise ~/.local/bin/claude.exe, then PATH)
//
// Exit codes match the bash client: 75 when no broker or no lane is free right now (try later),
// 78 for a configuration fault (no key, key refused, no claude), else claude's own code.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const say = (text) => process.stderr.write(`claude-leased: ${text}\n`);

/** The first line of the first readable file, CR stripped, or ''. */
export function firstLineOf(files) {
  for (const f of files) {
    try {
      const v = fs.readFileSync(f, 'utf8').split(/\r?\n/)[0].trim();
      if (v) return v;
    } catch { /* not there */ }
  }
  return '';
}

function isFile(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * The real claude: CLAUDE_BIN, else the native installer's place, else the first claude.exe on
 * PATH. An npm install (a claude.cmd shim) is followed to the program beside it, because a .cmd
 * cannot be started without a shell. Anything inside `skipDir` (Switchboard's own wrappers) is
 * passed over, so a wrapper never runs itself.
 */
export function findRealClaude({ env = process.env, home = os.homedir(), skipDir = null } = {}) {
  if (env.CLAUDE_BIN) return isFile(env.CLAUDE_BIN) ? env.CLAUDE_BIN : null;
  const native = path.join(home, '.local', 'bin', 'claude.exe');
  if (isFile(native)) return native;
  const skip = skipDir ? path.resolve(skipDir).toLowerCase() + path.sep : null;
  const pathVar = Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
  for (const dir of pathVar.split(path.delimiter).filter(Boolean)) {
    if (skip && (path.resolve(dir).toLowerCase() + path.sep).startsWith(skip)) continue;
    const exe = path.join(dir, 'claude.exe');
    if (isFile(exe)) return exe;
    if (isFile(path.join(dir, 'claude.cmd'))) {
      for (const tail of [['bin', 'claude.exe'], ['cli.js']]) {
        const entry = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', ...tail);
        if (isFile(entry)) return entry;
      }
    }
  }
  return null;
}

/** How to start a program: a .js/.mjs entry runs under this node, anything else directly. */
function launchOf(bin, args) {
  return /\.(c|m)?js$/i.test(bin) ? { file: process.execPath, args: [bin, ...args] } : { file: bin, args };
}

async function call(method, url, key, body = null) {
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body == null ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    let json = null;
    try { json = await res.json(); } catch { json = null; }
    return { status: res.status, json };
  } catch {
    return { status: 0, json: null };
  }
}

/**
 * The broker's address. A saved or given address is still checked, so one that stopped
 * answering is "no broker" (75, try later), not a configuration error. Returns { url } or
 * { refused: code } or {}.
 */
async function discover(conf, home, key, env) {
  const explicit = env.SWITCHBOARD_BROKER_URL || env.SWITCHBOARD_URL
    || firstLineOf([path.join(conf, 'broker-url'), path.join(home, '.switchboard-url')]);
  let port = firstLineOf([path.join(conf, 'broker-port')]);
  if (!/^\d+$/.test(port)) port = '8318';
  const candidates = explicit ? [explicit.replace(/\/+$/, '')] : [`http://127.0.0.1:${port}`];
  for (const url of candidates) {
    const r = await call('GET', `${url}/v1/info`, key);
    if (r.status === 200) return { url };
    if (r.status === 401 || r.status === 403) return { refused: r.status, url };
  }
  return {};
}

/** Run a program with every stream passed through, resolving its exit code. */
function runPassThrough(bin, args, env) {
  const { file, args: argv } = launchOf(bin, args);
  return new Promise((resolve) => {
    const child = spawn(file, argv, { stdio: 'inherit', env, windowsHide: true });
    child.on('error', (e) => { say(`could not start ${bin}: ${e.message}`); resolve(78); });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 143 : 1)));
  });
}

/**
 * Watches claude's output for the rate_limit_event it prints before a limit failure, without
 * keeping the output: a long T3 session prints megabytes of stream JSON. Only a line short
 * enough to be such an event is held while it is incomplete.
 */
export function rateLimitScanner() {
  let partial = '';
  let skipping = false;
  let last = null;
  const check = (line) => {
    if (line.includes('"type":"rate_limit_event"') && line.includes('"status":"rejected"')) last = line;
  };
  return {
    push(chunk) {
      const parts = String(chunk).split('\n');
      parts[0] = skipping ? '' : partial + parts[0];
      if (parts.length > 1) skipping = false;
      for (const line of parts.slice(0, -1)) check(line);
      const tail = parts[parts.length - 1];
      if (tail.length > 65536) { partial = ''; skipping = true; } else if (!skipping) partial = tail;
    },
    end() { if (partial) check(partial); partial = ''; return last; },
  };
}

/** The reset details of a rejected rate_limit_event line, each only when well formed. */
export function rateLimitDetails(line) {
  try {
    const info = JSON.parse(line)?.rate_limit_info ?? {};
    const type = /^[A-Za-z0-9_-]+$/.test(String(info.rateLimitType ?? '')) ? String(info.rateLimitType) : null;
    const resets = /^\d+$/.test(String(info.resetsAt ?? '')) ? Number(info.resetsAt) : null;
    return { type, resets };
  } catch {
    return { type: null, resets: null };
  }
}

/**
 * The whole client. Returns the exit code rather than exiting, so the caller (a wrapper's
 * cli.js, or a test) decides; process.exitCode lets stdout drain first.
 */
export async function main(args = process.argv.slice(2), { env = process.env, home = os.homedir(), wrappersDir = null } = {}) {
  const bin = findRealClaude({ env, home, skipDir: wrappersDir });
  if (!bin) {
    say(`no real claude found (CLAUDE_BIN=${env.CLAUDE_BIN || 'unset'}, no ${path.join(home, '.local', 'bin', 'claude.exe')}, none on PATH); set CLAUDE_BIN`);
    return 78;
  }

  // T3 Code checks each provider with --version every few minutes, and --help is asked for by
  // hand. Neither runs a model, so neither borrows an account.
  if (args.length === 1 && ['--version', '-v', '--help', '-h'].includes(args[0])) return runPassThrough(bin, args, env);

  const conf = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'switchboard');
  const key = env.SWITCHBOARD_CLIENT_KEY || firstLineOf([path.join(conf, 'client-key'), path.join(home, '.switchboard-key')]);
  if (!key) { say('SWITCHBOARD_CLIENT_KEY is not set (and no ~/.config/switchboard/client-key found)'); return 78; }

  // An account id goes into the lease request as it is, so only the characters an id is made of
  // are accepted.
  const account = env.SWITCHBOARD_ACCOUNT || '';
  if (account && !/^[A-Za-z0-9._-]+$/.test(account)) { say(`SWITCHBOARD_ACCOUNT "${account}" is not an account id`); return 78; }

  const found = await discover(conf, home, key, env);
  if (found.refused) { say(`the broker at ${found.url} rejected SWITCHBOARD_CLIENT_KEY (HTTP ${found.refused})`); return 78; }
  if (!found.url) { say('no Switchboard broker answered (is Switchboard running? set SWITCHBOARD_BROKER_URL or ~/.config/switchboard/broker-url)'); return 75; }
  const broker = found.url;

  const lease = await call('POST', `${broker}/v1/lease`, key, { provider: 'claude', harness: 'claude', ...(account ? { account } : {}) });
  const j = lease.json ?? {};
  if (lease.status !== 200) {
    say(`no lane leased (HTTP ${lease.status}, ${j.reason || 'no reason'}); retry after ${j.retryAfterSeconds ?? '?'} s, resets ${j.resetsAt ?? '?'}`);
    return lease.status === 503 ? 75 : 78;
  }
  say(`lane ${j.laneId} (${j.accountLabel}), lease ${j.leaseId}, headroom session ${j.headroom?.session ?? '?'}% weekly ${j.headroom?.weekly ?? '?'}%`);

  const report = async (outcome, exitCode, rateLimitType = null, resetsAt = null) => {
    const r = await call('POST', `${broker}/v1/lease/report`, key, {
      leaseId: j.leaseId, laneId: j.laneId, outcome, exitCode,
      ...(rateLimitType ? { rateLimitType } : {}), ...(resetsAt != null ? { resetsAt } : {}),
    });
    if (r.status !== 200) say(`report failed (lease ${j.leaseId}, ${outcome})`);
  };

  const childEnv = { ...env };
  let lent = 0;
  for (const [name, value] of Object.entries(j.env ?? {})) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    childEnv[name] = String(value);
    lent += 1;
  }
  // A lease with nothing in it would run claude on whatever sign-in this machine has, billing an
  // account nobody chose. Refused, and reported so the broker does not count it as a good run.
  if (!lent) {
    say('the broker lent no credential; not running claude');
    await report('error', 78);
    return 78;
  }
  // An API key in the environment outranks Claude's OAuth token, so a leftover one would bill the
  // API instead of the lent subscription.
  if (childEnv.CLAUDE_CODE_OAUTH_TOKEN) { delete childEnv.ANTHROPIC_API_KEY; delete childEnv.ANTHROPIC_AUTH_TOKEN; }

  // In a terminal claude gets the terminal itself. Otherwise (T3, a bridge) its output passes
  // through here so a limit failure can be reported with its reset time.
  const tty = Boolean(process.stdout.isTTY);
  const scanner = rateLimitScanner();
  const { file, args: argv } = launchOf(bin, args);
  let child;
  const code = await new Promise((resolve) => {
    child = spawn(file, argv, { stdio: ['inherit', tty ? 'inherit' : 'pipe', 'inherit'], env: childEnv, windowsHide: true });
    child.on('error', (e) => { say(`could not start ${bin}: ${e.message}`); resolve(78); });
    if (!tty) {
      child.stdout.on('data', (c) => { scanner.push(c); process.stdout.write(c); });
    }
    child.on('close', (c, signal) => resolve(c ?? (signal ? 143 : 1)));
    // A stop request reaches this process; claude is stopped with it and the run still reported.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK', 'SIGHUP']) {
      process.once(sig, () => { try { child.kill(); } catch { /* gone */ } });
    }
  });

  const rejected = scanner.end();
  if (rejected) {
    const { type, resets } = rateLimitDetails(rejected);
    await report('rate-limited', code, type, resets);
  } else {
    await report(code === 0 ? 'ok' : 'error', code);
  }
  return code;
}

// Run directly (node switchboard-lease.mjs ...): the "any account" form.
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === self.toLowerCase()) {
  main(process.argv.slice(2), { wrappersDir: path.dirname(self) }).then((c) => { process.exitCode = c; });
}
