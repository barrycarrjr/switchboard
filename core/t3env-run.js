import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSettings, saveSettings } from './settings.js';
import { loadRegistry } from './accounts.js';
import { detectGatewayHostIp, gatewayEnabledSettings } from './gateway-keys.js';
import { listWslDistros, inspectLaneLeaseCredential } from './gateway.js';
import {
  parseT3Target, setupT3Environment, rememberT3Environment, forgetT3Environment, keyForEnvironment, runScript,
  t3EnvironmentStatus, lendableClaudeAccounts, sha256,
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
  return t3EnvironmentStatus(settings, { leaseSha: currentLeaseSha(), lendableIds, port: addresses.port, brokerUrl: addresses.lanUrl });
}
