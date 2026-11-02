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
  codexSignInCommand, enabledAntigravityIds,
} from './t3env.js';

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
export async function runT3Setup(targets, { replaceSymlink = false, prove = true, refreshOnly = false, onProgress = () => {}, run = runScript, hostIp = null } = {}) {
  const leaseScript = readLeaseScript();
  const leaseSha = sha256(leaseScript);
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
    saveSettings(rememberT3Environment(loadSettings(), target, report, { leaseSha }));
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
export function currentT3Status({ hostIp = null } = {}) {
  const settings = loadSettings();
  const addresses = brokerAddresses(settings, { hostIp });
  const lendableIds = lendableClaudeAccounts(loadRegistry(), settings, { canLend: brokerCanLend(settings) }).lendable.map((a) => a.id);
  const codexIds = codexAccountsFor(loadRegistry()).map((a) => a.id);
  return t3EnvironmentStatus(settings, { leaseSha: currentLeaseSha(), lendableIds, codexIds, antigravity: usesAntigravity({ settings }), port: addresses.port, brokerUrl: addresses.lanUrl });
}

/**
 * `switchboard t3 sign-in <target>`: Codex's one-time device-code sign-in for every Codex
 * account that is not signed in on that machine yet, each attached to this terminal so the code
 * and link show. Antigravity's sign-in lives inside T3 and is only reported. When a sign-in ran,
 * the machine is asked again so the remembered list is current; if it cannot be asked, the list
 * is left as it was and that is said. Returns the Codex rows (what this command acts on) and
 * the Antigravity row separately. `spawnImpl`, `run` and `resolve` exist for tests.
 */
export async function runT3SignIn(targetSpec, { onProgress = () => {}, spawnImpl = spawn, run = runScript, resolve = resolveTargets, antigravity = null } = {}) {
  const [target] = await resolve([targetSpec]);
  const codexAccounts = codexAccountsFor(loadRegistry());
  if (!codexAccounts.length) onProgress('Switchboard knows no Codex account, so there is nothing to sign in.');
  const ask = async () => parseInspect((await run(target, inspectScript({ codexHomes: codexAccounts.map((a) => a.relHome) }), { timeoutMs: 60000 + 20000 * codexAccounts.length })).stdout);
  let inspected = await ask();
  if (!inspected) throw new Error(`could not reach ${target.id}`);
  const wantAntigravity = antigravity ?? usesAntigravity();
  const listFor = (insp) => signInsFor(target, insp, codexAccounts, { antigravityIds: wantAntigravity ? enabledAntigravityIds(insp.settings) : null });
  const todo = listFor(inspected).filter((x) => x.provider === 'codex' && x.state === 'needs-sign-in');
  if (codexAccounts.length && !inspected.codexBin) onProgress(`Codex is not installed on ${target.id}; install it there first (sudo npm install -g @openai/codex, or without sudo where npm installs into your home folder).`);
  else if (codexAccounts.length && !todo.length) onProgress(`Every Codex account is already signed in on ${target.id}.`);
  for (const item of todo) {
    const acc = codexAccounts.find((a) => a.id === item.account);
    // Codex refuses a CODEX_HOME that does not exist yet.
    await run(target, `set -u\nmkdir -p "$HOME/${acc.relHome}"\n`, { timeoutMs: 30000 });
    onProgress(`Signing in ${item.what} on ${target.id}. Codex shows a link and a code: open the link in your browser and enter the code. (Device code sign-in must be on in ChatGPT: Settings, Security.)`);
    const { file, args } = codexSignInCommand(target, { codexBin: inspected.codexBin, home: inspected.home, relHome: acc.relHome });
    const code = await new Promise((done) => {
      const child = spawnImpl(file, args, { stdio: 'inherit' });
      child.on('error', () => done(null));
      child.on('close', (c) => done(c));
    });
    onProgress(code === 0 ? `  ${item.what}: done.` : `  ${item.what}: the sign-in did not finish (exit ${code ?? 'unknown'}).`);
  }
  if (todo.length) {
    const again = await ask();
    if (again) inspected = again;
    else onProgress(`Could not ask ${target.id} again, so its saved list of missing sign-ins was left as it was.`);
    if (again) {
      const settings = loadSettings();
      if (settings.t3Environments?.[target.id]) {
        const envs = { ...settings.t3Environments };
        envs[target.id] = { ...envs[target.id], signInsMissing: listFor(again).filter((x) => x.state !== 'signed-in').map((x) => x.what) };
        saveSettings({ ...settings, t3Environments: envs });
      }
    }
  }
  const all = listFor(inspected);
  for (const x of all.filter((y) => y.state !== 'signed-in')) onProgress(`Still to sign in: ${x.what} (${x.how})`);
  return { codex: all.filter((x) => x.provider === 'codex'), antigravity: all.find((x) => x.provider === 'antigravity') ?? null };
}
