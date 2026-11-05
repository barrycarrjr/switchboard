import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings } from './settings.js';
import { loadRegistry } from './accounts.js';
import { t3SettingsFile } from './t3colors.js';
import { detectGatewayHostIp, gatewayEnabledSettings } from './gateway-keys.js';
import { listWslDistros, inspectLaneLeaseCredential } from './gateway.js';
import {
  parseT3Target, setupT3Environment, rememberT3Environment, forgetT3Environment, keyForEnvironment, runScript,
  t3EnvironmentStatus, lendableClaudeAccounts, sha256, codexAccountsFor, inspectScript, parseInspect, signInsFor,
  codexSignInCommand, enabledAntigravityIds, rememberSignIns, rememberAttempt,
} from './t3env.js';
import {
  setupLocalT3Environment, readLocalLeaseClient, currentLocalLeaseSha, inspectLocal, localCodexAccounts,
  localCodexSignInCommand,
} from './t3local.js';

/**
 * The real-machine wiring for core/t3env.js, shared by the CLI (`switchboard t3 ...`) and the
 * tray's Gateway tab so the two cannot disagree.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const LEASE_SCRIPT_PATH = path.join(here, '..', 'bin', 'switchboard-lease');

export function readLeaseScript(file = LEASE_SCRIPT_PATH) {
  return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
}

/** The hash of the lease wrapper this Switchboard ships, or null when it cannot be read. */
export function currentLeaseSha() {
  try { return sha256(readLeaseScript()); } catch { return null; }
}

/**
 * Whether Antigravity is in use here, so other machines get it too: this machine's T3 has an
 * enabled Antigravity entry, or Switchboard has an Antigravity lane. Someone who never uses it
 * gets no Antigravity entry and no reminder to sign in.
 */
export function usesAntigravity({ t3File = t3SettingsFile(), settings = loadSettings() } = {}) {
  try {
    if (enabledAntigravityIds(JSON.parse(fs.readFileSync(t3File, 'utf8'))).length) return true;
  } catch { /* no T3 settings here */ }
  return (settings.lanes ?? []).some((l) => l?.harness === 'antigravity');
}

/** The broker's own lending rule, so setup offers exactly the accounts the broker will lend. */
function brokerCanLend(settings) {
  return (lane, account) => inspectLaneLeaseCredential(lane, account, settings).ready === true;
}

/**
 * Where targets reach the broker. A machine on the LAN needs the gateway on scope `lan`; the
 * scope is never widened from here (a scope a person chose stays as chosen, decided
 * 2026-11-01), so a narrower scope is reported as the reason instead.
 */
export function brokerAddresses(settings, { hostIp = null } = {}) {
  const gw = settings.gateway;
  const lanIp = hostIp ?? detectGatewayHostIp('lan');
  const lan = gw.scope === 'lan' && lanIp && lanIp !== '127.0.0.1' ? `http://${lanIp}:${gw.port}` : null;
  return {
    port: gw.port,
    scope: gw.scope,
    lanUrl: lan,
    wslUrls: [`http://127.0.0.1:${gw.port}`],
  };
}

// `wsl.exe --list` takes a moment and the Gateway tab redraws every few seconds, so the answer
// is kept for a minute.
let distroCache = { at: 0, list: [] };
export async function wslDistrosCached({ now = Date.now(), maxAgeMs = 60000 } = {}) {
  if (process.platform !== 'win32') return [];
  if (now - distroCache.at > maxAgeMs) distroCache = { at: now, list: await listWslDistros() };
  return distroCache.list;
}

/** Turn targets as typed (or `--all`) into parsed targets, with the WSL distros on this machine. */
export async function resolveTargets(specs, { all = false, settings = loadSettings(), wslDistros = null } = {}) {
  const distros = wslDistros ?? await wslDistrosCached();
  if (all) return Object.values(settings.t3Environments ?? {}).map((e) => parseT3Target(`${e.kind}:${e.name}`, distros));
  if (!specs.length) return distros.map((d) => parseT3Target(`wsl:${d}`, distros));
  return specs.map((s) => parseT3Target(s, distros));
}

/**
 * Set up each target in turn and remember it. `onProgress(text)` gets a line as each target
 * starts and its steps when it ends. One target failing, even by an unexpected error, never
 * stops the others.
 */
export async function runT3Setup(targets, { replaceSymlink = false, prove = true, refreshOnly = false, onProgress = () => {}, run = runScript, hostIp = null, setupLocal = setupLocalT3Environment } = {}) {
  const leaseScript = readLeaseScript();
  const leaseSha = sha256(leaseScript);
  // This machine's own T3 runs the Node.js lease client; it is read only when it is needed.
  const localClient = targets.some((t) => t.kind === 'local') ? readLocalLeaseClient() : null;
  // The broker must be on for anything to borrow; turning it on keeps the chosen scope and port.
  if (!refreshOnly) {
    const enabled = gatewayEnabledSettings(loadSettings());
    if (!enabled.wasEnabled) {
      saveSettings(enabled.settings);
      onProgress(`Turned the gateway on (scope ${enabled.scope}, port ${enabled.port}).`);
    }
  }
  const addresses = brokerAddresses(loadSettings(), { hostIp });
  const registry = loadRegistry();
  const reports = [];
  for (const target of targets) {
    onProgress(`Setting up ${target.id} ...`);
    const blank = { target: target.id, ok: false, reached: false, steps: [], accounts: [], skipped: [], leftovers: [], proof: [], signIns: [] };
    let report;
    if (target.kind === 'ssh' && !addresses.lanUrl) {
      report = { ...blank, error: `the gateway's scope is ${addresses.scope}, so machines on the LAN cannot reach it. Run: switchboard gateway scope lan` };
    } else if (target.kind === 'local') {
      try {
        report = await setupLocal({
          registry,
          loadSettings,
          saveSettings,
          canLend: brokerCanLend(loadSettings()),
          leaseClient: localClient,
          port: addresses.port,
          // The quota hub this machine's T3 already shows is usually the LAN address; without a
          // LAN scope it is the loopback one.
          hubUrl: addresses.lanUrl ?? `http://127.0.0.1:${addresses.port}`,
          codexAccounts: localCodexAccounts(registry),
          antigravity: usesAntigravity(),
          createKey: (s, label) => keyForEnvironment(s, label),
        }, { prove, refreshOnly });
      } catch (e) {
        report = { ...blank, error: `setup stopped on an unexpected error: ${String(e?.message || e)}` };
      }
    } else {
      try {
        report = await setupT3Environment(target, {
          registry,
          loadSettings,
          saveSettings,
          canLend: brokerCanLend(loadSettings()),
          leaseScript,
          port: addresses.port,
          brokerUrl: addresses.lanUrl,
          wslBrokerUrls: addresses.wslUrls,
          hubUrl: addresses.lanUrl,
          codexAccounts: codexAccountsFor(registry),
          antigravity: usesAntigravity(),
          createKey: (s, label) => keyForEnvironment(s, label),
          run: (t, script, opts) => run(t, script, opts),
        }, { replaceSymlink, prove, refreshOnly });
      } catch (e) {
        report = { ...blank, error: `setup stopped on an unexpected error: ${String(e?.message || e)}` };
      }
    }
    for (const line of report.steps) onProgress(`  ${line}`);
    if (report.error) onProgress(`  Stopped: ${report.error}`);
    saveSettings(rememberT3Environment(loadSettings(), target, report, { leaseSha: target.kind === 'local' ? sha256(localClient) : leaseSha }));
    reports.push(report);
  }
  return reports;
}

/**
 * One setup at a time, shared by the CLI-free paths in the tray (the Gateway tab's buttons and
 * the start-up refresh), so two cannot write the same machine's files at once.
 */
let busy = false;
export async function withT3Lock(fn) {
  if (busy) return { busy: true };
  busy = true;
  try { return { busy: false, value: await fn() }; } finally { busy = false; }
}

/**
 * The tray's start-up refresh: every remembered environment whose lease wrapper is older than
 * this Switchboard gets the current wrappers, nothing more (see setupT3Environment's
 * refreshOnly: no key is made, T3's settings are not written, nothing is proved).
 */
export async function refreshStaleT3Environments() {
  const stale = currentT3Status().filter((e) => e.wrapperOld);
  if (!stale.length) return [];
  const res = await withT3Lock(async () => runT3Setup(await resolveTargets(stale.map((e) => e.id)), { refreshOnly: true }));
  return res.value ?? [];
}

/** Stop listing and checking an environment. Nothing on the machine itself is touched. */
export function forgetT3(targetId) {
  saveSettings(forgetT3Environment(loadSettings(), targetId));
}

/** The status list with the facts it is judged against filled in from this machine. */
export function currentT3Status({ hostIp = null, settings = loadSettings(), registry = loadRegistry(), antigravity = null } = {}) {
  const addresses = brokerAddresses(settings, { hostIp });
  const lendableIds = lendableClaudeAccounts(registry, settings, { canLend: brokerCanLend(settings) }).lendable.map((a) => a.id);
  const codexIds = codexAccountsFor(registry).map((a) => a.id);
  return t3EnvironmentStatus(settings, {
    leaseSha: currentLeaseSha(), localLeaseSha: currentLocalLeaseSha(), lendableIds, codexIds, antigravity: antigravity ?? usesAntigravity({ settings }),
    port: addresses.port, brokerUrl: addresses.lanUrl,
  });
}

// One allowance for asking a machine, shared by status, sign-in and setup's inspection: up to
// 60 s to connect and answer, plus up to 15 s for each Codex account's own status check.
const askTimeoutMs = (codexAccounts) => 60000 + 20000 * codexAccounts.length;

/**
 * Ask one machine which of its Codex and Antigravity sign-ins are done. Read-only: nothing is
 * written there and nothing is borrowed. Returns { inspected, signIns, askedAt }, or
 * { error } when the machine did not answer or its T3 settings could not be read (a reading
 * then would drop the Antigravity line, so none is taken).
 */
export async function checkT3SignIns(target, { run = runScript, codexAccounts, antigravity, inspectHere = inspectLocal }) {
  const askedAt = Date.now();
  if (target.kind === 'local') {
    // This machine's accounts are asked in their own folders, not under ~/.codex-t3.
    const ids = new Set(codexAccounts.map((a) => a.id));
    const here = localCodexAccounts(loadRegistry()).filter((a) => ids.has(a.id));
    const inspected = await inspectHere({ codexAccounts: here });
    if (antigravity && (!inspected.t3 || inspected.settingsError)) return { error: `its T3 settings could not be read${inspected.settingsError ? ` (${inspected.settingsError})` : ''}` };
    const signIns = signInsFor(target, inspected, here, { antigravityIds: antigravity ? enabledAntigravityIds(inspected.settings) : null });
    return { inspected, signIns, askedAt, codexAccounts: here };
  }
  const res = await run(target, inspectScript({ codexHomes: codexAccounts.map((a) => a.relHome), antigravity: Boolean(antigravity), wsl: target.kind === 'wsl' }), { timeoutMs: askTimeoutMs(codexAccounts) });
  const inspected = parseInspect(res.stdout);
  if (!inspected) return { error: (res.stderr || '').trim().split(/\r?\n/).filter(Boolean).pop() || 'no answer' };
  if (antigravity && (!inspected.t3 || inspected.settingsError)) return { error: `its T3 settings could not be read${inspected.settingsError ? ` (${inspected.settingsError})` : ''}` };
  const signIns = signInsFor(target, inspected, codexAccounts, { antigravityIds: antigravity ? enabledAntigravityIds(inspected.settings) : null });
  return { inspected, signIns, askedAt };
}

/**
 * Save a reading or a failed attempt for one remembered environment, re-reading the settings
 * file first and writing only when that environment is in it, so a file that could not be read
 * at that moment is never replaced by defaults.
 */
function saveReading(targetId, outcome) {
  const settings = loadSettings();
  if (!settings.t3Environments?.[targetId]) return;
  const next = outcome.signIns
    ? rememberSignIns(settings, targetId, outcome.signIns, { now: outcome.askedAt })
    : rememberAttempt(settings, targetId, outcome.error);
  if (next !== settings) saveSettings(next);
}

/**
 * `switchboard t3 sign-in <target>`: Codex's one-time device-code sign-in for every Codex
 * account that is not signed in on that machine yet, each attached to this terminal so the code
 * and link show. Antigravity's sign-in lives inside T3 and is only reported. Every reading it
 * takes is saved, so the remembered list is current; if the machine cannot be asked afterwards,
 * the list is left as it was and that is said. Returns the Codex rows (what this command acts
 * on) and the Antigravity row separately. `spawnImpl`, `run` and `resolve` exist for tests.
 */
export async function runT3SignIn(targetSpec, { onProgress = () => {}, spawnImpl = spawn, run = runScript, resolve = resolveTargets, antigravity = null } = {}) {
  const [target] = await resolve([targetSpec]);
  const codexAccounts = codexAccountsFor(loadRegistry());
  const wantAntigravity = antigravity ?? usesAntigravity();
  if (!codexAccounts.length) onProgress('Switchboard knows no Codex account, so there is nothing to sign in.');
  const ask = () => checkT3SignIns(target, { run, codexAccounts, antigravity: wantAntigravity });
  let reading = await ask();
  if (reading.error) throw new Error(`could not read ${target.id}: ${reading.error}`);
  saveReading(target.id, reading);
  const todo = reading.signIns.filter((x) => x.provider === 'codex' && x.state === 'needs-sign-in');
  if (codexAccounts.length && !reading.inspected.codexBin) onProgress(target.kind === 'local' ? 'Codex is not installed on this computer; install it first (npm install -g @openai/codex).' : `Codex is not installed on ${target.id}; install it there first (sudo npm install -g @openai/codex, or without sudo where npm installs into your home folder).`);
  else if (codexAccounts.length && !todo.length) onProgress(`Every Codex account is already signed in on ${target.id}.`);
  for (const item of todo) {
    const acc = (reading.codexAccounts ?? codexAccounts).find((a) => a.id === item.account);
    // Codex refuses a CODEX_HOME that does not exist yet.
    if (target.kind === 'local') fs.mkdirSync(acc.absHome, { recursive: true });
    else await run(target, `set -u\nmkdir -p "$HOME/${acc.relHome}"\n`, { timeoutMs: 30000 });
    onProgress(`Signing in ${item.what} on ${target.id}. Codex shows a link and a code: open the link in your browser and enter the code. (Device code sign-in must be on in ChatGPT: Settings, Security.)`);
    const launch = target.kind === 'local'
      ? localCodexSignInCommand(reading.inspected.codexBin, acc)
      : codexSignInCommand(target, { codexBin: reading.inspected.codexBin, home: reading.inspected.home, relHome: acc.relHome });
    const { file, args } = launch;
    const code = await new Promise((done) => {
      const child = spawnImpl(file, args, { stdio: 'inherit', ...(launch.env ? { env: launch.env } : {}), ...(launch.shell ? { shell: true } : {}) });
      child.on('error', () => done(null));
      child.on('close', (c) => done(c));
    });
    onProgress(code === 0 ? `  ${item.what}: done.` : `  ${item.what}: the sign-in did not finish (exit ${code ?? 'unknown'}).`);
  }
  if (todo.length) {
    const again = await ask();
    if (again.error) onProgress(`Could not ask ${target.id} again (${again.error}), so its saved list of missing sign-ins was left as it was.`);
    else {
      reading = again;
      saveReading(target.id, again);
    }
  }
  for (const x of reading.signIns.filter((y) => y.state !== 'signed-in')) onProgress(`${x.state === 'unknown' ? 'Could not tell' : 'Still to sign in'}: ${x.what} (${x.how})`);
  return { codex: reading.signIns.filter((x) => x.provider === 'codex'), antigravity: reading.signIns.find((x) => x.provider === 'antigravity') ?? null };
}

/**
 * `switchboard t3 status`: every remembered environment, with its sign-ins asked of the
 * machine itself, all machines at once. Each answer is saved (so `--saved` and the Gateway tab
 * show it afterwards, with its age); a machine that does not answer keeps its saved reading,
 * gets the failed attempt and its reason recorded, and is marked as not reached. When there is
 * nothing to ask (no Codex account and Antigravity not in use) no machine is contacted.
 * `run` exists for tests.
 */
export async function liveT3Status({ run = runScript, antigravity = null } = {}) {
  const settings = loadSettings();
  const envs = Object.entries(settings.t3Environments ?? {});
  if (!envs.length) return [];
  const registry = loadRegistry();
  const codexAccounts = codexAccountsFor(registry);
  const useAg = antigravity ?? usesAntigravity({ settings });
  const reached = new Map();
  if (codexAccounts.length || useAg) {
    // Targets come from what was remembered, keyed by the remembered id, so a reading always
    // lands on the record it belongs to.
    const outcomes = await Promise.all(envs.map(([, e]) => checkT3SignIns({ id: e.id, kind: e.kind, name: e.name }, { run, codexAccounts, antigravity: useAg })
      .catch((err) => ({ error: String(err?.message || err) }))));
    envs.forEach(([id], i) => {
      saveReading(id, outcomes[i]);
      reached.set(id, outcomes[i].error ? outcomes[i].error : true);
    });
  } else {
    envs.forEach(([id]) => {
      saveReading(id, { signIns: [], askedAt: Date.now() });
      reached.set(id, true);
    });
  }
  return currentT3Status({ registry, antigravity: useAg }).map((e) => {
    const r = reached.get(e.id);
    // The failed attempt and its reason are already in the detail, from the saved record.
    return { ...e, reached: r === true };
  });
}
