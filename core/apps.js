import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBinIn } from './providers.js';
import { freshPathDirs } from './env.js';

const run = promisify(execFile);

/**
 * Desktop applications. Same rules as the CLI table: installs delegate to a vendor
 * mechanism or link to the vendor; detection is by install path or the Windows app
 * registry (Get-StartApps), so store and classic installs both work. Launching is
 * where Switchboard's involvement ends: an app that keeps each account in its own data
 * folder can be opened on one of them (see core/appprofiles.js), but what the app then
 * does, and what it does with that folder, is the app's own business.
 */
export const APPS = [
  // packagedExe is the program file inside the Store package, relative to where the
  // package is installed. Opening the app normally never needs it (Windows activates
  // the package by id), but an activation cannot carry arguments, so opening on a
  // chosen account has to run the program file itself.
  { id: 'claude-desktop', name: 'Claude Desktop', url: 'https://claude.ai/download', startAppsMatch: /^Claude$/, packagedExe: 'app/Claude.exe', install: { via: 'winget', cmd: 'winget install --id Anthropic.Claude -e' } },
  // The alpha installs under Programs\t3code with "(Alpha)" in the exe name; the plain
  // names are kept for when the app leaves alpha.
  { id: 't3code', name: 'T3 Code', url: 'https://t3.codes', startAppsMatch: /^T3 Code/, exePaths: () => [
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'T3 Code', 'T3 Code.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 't3code', 'T3 Code.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 't3code', 'T3 Code (Alpha).exe'),
  ], install: { via: 'winget', cmd: 'winget install --id T3Tools.T3Code -e' } },
  // OpenAI shipped Codex inside the app that used to be ChatGPT: the window says Codex,
  // while the Store listing and the Start menu entry still say ChatGPT, so both names
  // count as a hit. The id stays 'chatgpt' because it keys the saved card order.
  // Uninstall names the installed package, not the Store product id: winget cannot find
  // an installed app by the id it installs with (verified on a machine that has it).
  { id: 'chatgpt', name: 'Codex', url: 'https://openai.com/codex/', startAppsMatch: /^(Codex|ChatGPT)$/, install: { via: 'winget', cmd: 'winget install --id 9PLM9XGG6VKS -e --source msstore', uninstallCmd: 'winget uninstall --id OpenAI.Codex' } },
  { id: 'antigravity', name: 'Antigravity', url: 'https://antigravity.google', startAppsMatch: /^Antigravity$/, exePaths: () => [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe')], install: { via: 'winget', cmd: 'winget install --id Google.Antigravity -e' } },
  { id: 'lmstudio', name: 'LM Studio', url: 'https://lmstudio.ai', startAppsMatch: /^LM Studio$/, exePaths: () => [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'LM Studio', 'LM Studio.exe')], install: { via: 'winget', cmd: 'winget install --id ElementLabs.LMStudio -e' } },
];

/** Pure parser for `Get-StartApps` output rendered as "Name|AppID" lines. */
export function parseStartApps(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('|'))
    .map((l) => {
      const i = l.indexOf('|');
      return { name: l.slice(0, i), appId: l.slice(i + 1) };
    })
    .filter((e) => e.name && e.appId);
}

export async function getStartApps() {
  try {
    const { stdout } = await run('powershell', ['-NoProfile', '-Command', "Get-StartApps | ForEach-Object { $_.Name + '|' + $_.AppID }"], { windowsHide: true, timeout: 15000 });
    return parseStartApps(stdout);
  } catch {
    return [];
  }
}

/** Detect the built-in apps. startApps may be injected (tests, or one shared fetch). */
export function detectApps(startApps) {
  return APPS.map((app) => {
    const out = { id: app.id, name: app.name, url: app.url ?? null, installed: false, exePath: null, appId: null, install: app.install };
    const exe = app.exePaths?.().find((p) => p && fs.existsSync(p));
    if (exe) {
      out.installed = true;
      out.exePath = exe;
    }
    const entry = startApps.find((e) => app.startAppsMatch.test(e.name));
    if (entry) {
      out.installed = true;
      out.appId = entry.appId;
    }
    out.packagedExe = app.packagedExe ?? null;
    return out;
  });
}

/**
 * The package family inside a Windows app id ("Claude_pzs8sxrjxfjjc!Claude"), or null
 * when the id is not a packaged app at all. A classic install and a person's own
 * launcher both land here, so this has to say no rather than return something
 * plausible: the answer is used to find a program file on disk.
 */
export function packageFamilyFromAppId(appId) {
  const raw = String(appId || '');
  if (!raw.includes('!')) return null;
  const family = raw.slice(0, raw.indexOf('!'));
  return /^[A-Za-z0-9.-]+_[A-Za-z0-9]+$/.test(family) ? family : null;
}

/** Where Windows installed a packaged app, asked of Windows rather than guessed. */
async function queryInstallLocation(family) {
  try {
    // The family name reaches PowerShell as an environment variable, never spliced
    // into the command text: the same rule the sign-in terminal follows.
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-Command', 'Get-AppxPackage | Where-Object { $_.PackageFamilyName -eq $env:SB_PACKAGE_FAMILY } | Select-Object -First 1 -ExpandProperty InstallLocation'],
      { windowsHide: true, timeout: 15000, env: { ...process.env, SB_PACKAGE_FAMILY: family } },
    );
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * The program file of a Store-installed app, or null when it cannot be found. Null is
 * a real answer here: the caller must refuse the launch rather than fall back to a
 * plain activation, which would open the app on the wrong account without saying so.
 */
export async function resolvePackagedExe(appId, relativeExe, { query = queryInstallLocation, exists = fs.existsSync } = {}) {
  const family = packageFamilyFromAppId(appId);
  if (!family || !relativeExe) return null;
  const location = await query(family);
  if (!location) return null;
  const exe = path.join(location, ...String(relativeExe).split('/'));
  return exists(exe) ? exe : null;
}

/**
 * True when a `cmdkey /list:<target>` listing actually contains the credential.
 * cmdkey exits 0 either way and prints "* NONE *" on a miss, so only a Target
 * line naming the credential counts. Pure for tests.
 */
export function cmdkeyHasCredential(stdout, target) {
  const escaped = String(target).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('Target:\\s*(?:LegacyGeneric:target=)?' + escaped + '\\s*$', 'mi').test(String(stdout || ''));
}

/**
 * The one Google login Antigravity keeps per machine lives in the OS keyring under
 * the service name "gemini:antigravity" (shared by the desktop app and the agy CLI).
 * Listing it proves signed-in without ever reading the secret.
 */
async function antigravityKeyringPresent() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await run('cmdkey', ['/list:gemini:antigravity'], { windowsHide: true, timeout: 4000 });
      return cmdkeyHasCredential(stdout, 'gemini:antigravity');
    }
    if (process.platform === 'darwin') {
      // Exits non-zero (throws) when the item is absent; -s matches the service name.
      await run('security', ['find-generic-password', '-s', 'gemini:antigravity'], { timeout: 4000 });
      return true;
    }
  } catch { /* absent, or the keyring tool failed: treat as not signed in */ }
  return false;
}

/**
 * Extract identity from the Antigravity desktop app's state store, pure for tests.
 * The antigravityAuthStatus record also holds a live OAuth token: this reads ONLY
 * the name, email, and the plan word out of the status proto, and must never touch
 * or return the token. Plan comes from the printable strings of the base64 proto,
 * accepted only on an exact tier-name match so a person's name can never leak in.
 */
export function parseAntigravityAuth(raw) {
  const out = { who: null, name: null, plan: null };
  const text = String(raw || '');
  // The key string also shows up on SQLite index pages with no value attached, so
  // walk every occurrence and keep the first one actually followed by the record.
  for (let at = text.indexOf('antigravityAuthStatus'); at >= 0; at = text.indexOf('antigravityAuthStatus', at + 1)) {
    const win = text.slice(at, at + 4000);
    const who = win.match(/"email"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    if (!who) continue;
    out.who = who;
    out.name = win.match(/"name"\s*:\s*"([^"]+)"/)?.[1] ?? null;
    const b64 = win.match(/"userStatusProtoBinaryBase64"\s*:\s*"([A-Za-z0-9+/=]+)/)?.[1];
    if (b64) {
      try {
        const runs = Buffer.from(b64, 'base64').toString('latin1').match(/[\x20-\x7E]{3,}/g) ?? [];
        out.plan = runs.find((s) => /^(Free|Pro|Ultra)$/.test(s)) ?? null;
      } catch { /* not decodable, plan stays unknown */ }
    }
    break;
  }
  return out;
}

/** Where the desktop app keeps its state store, most-preferred first. */
function antigravityStateDbPaths() {
  const base = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'Antigravity')
    : process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'Antigravity')
      : path.join(os.homedir(), '.config', 'Antigravity');
  const dir = path.join(base, 'User', 'globalStorage');
  return [path.join(dir, 'state.vscdb'), path.join(dir, 'state.vscdb.backup')];
}

/**
 * Antigravity presence for the Accounts page. The vendor caches ONE Google login per
 * machine (no account switching, no usage API), but signed-in state IS knowable from
 * the keyring entry, and who/plan from the desktop app's state store when it exists.
 * A CLI-only machine still shows signed in, just without the account name.
 */
export async function antigravityPresence() {
  const out = { cliInstalled: false, appInstalled: false, signedIn: false, who: null, plan: null };
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await run(finder, ['agy'], { windowsHide: true, timeout: 4000 });
    out.cliInstalled = stdout.trim().length > 0;
  } catch { /* not on this process's PATH */ }
  if (!out.cliInstalled && process.platform === 'win32') {
    out.cliInstalled = findBinIn(freshPathDirs(), 'agy') != null;
  }
  out.appInstalled = fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'));
  out.signedIn = await antigravityKeyringPresent();
  if (out.signedIn) {
    for (const p of antigravityStateDbPaths()) {
      try {
        const id = parseAntigravityAuth(fs.readFileSync(p, 'latin1'));
        if (id.who || id.plan) {
          out.who = id.who;
          out.plan = id.plan;
          break;
        }
      } catch { /* no desktop state store to read, keep the keyring answer */ }
    }
  }
  return out;
}

/**
 * Apply the person's saved ordering. Known ids come first in their saved order;
 * anything new appends in default order until it gets placed.
 */
export function orderApps(apps, order = []) {
  if (!Array.isArray(order) || order.length === 0) return apps;
  const rank = new Map(order.map((id, i) => [id, i]));
  const known = apps.filter((a) => rank.has(a.id)).sort((x, y) => rank.get(x.id) - rank.get(y.id));
  const fresh = apps.filter((a) => !rank.has(a.id));
  return [...known, ...fresh];
}

/**
 * Launch by exe path when there is one, else through the Windows app registry.
 *
 * Arguments only ever go to a program file. A Windows app activation cannot carry
 * them, so an argument with nowhere to go is an error rather than a launch: dropping
 * it would open the app on the standard account while the person asked for another.
 */
export function launchApp({ exePath, appId, args = [] }) {
  if (exePath) {
    spawn(exePath, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  if (args.length) throw new Error('this app can only be opened on a chosen account through its program file');
  if (appId) {
    spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  throw new Error('nothing to launch');
}
