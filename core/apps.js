import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { findBinIn } from './providers.js';
import { freshPathDirs } from './env.js';

const run = promisify(execFile);

/**
 * Desktop applications. Same rules as the CLI table: installs delegate to a vendor
 * mechanism or link to the vendor; detection is by install path or the Windows app
 * registry (Get-StartApps), so store and classic installs both work. Launching is
 * where Switchboard's involvement ends: it never manages what the app then does.
 */
export const APPS = [
  { id: 'claude-desktop', name: 'Claude Desktop', url: 'https://claude.ai/download', startAppsMatch: /^Claude$/, install: { via: 'winget', cmd: 'winget install --id Anthropic.Claude -e' } },
  { id: 't3code', name: 'T3 Code', url: 'https://t3.codes', startAppsMatch: /^T3 Code/, exePaths: () => [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'T3 Code', 'T3 Code.exe')], install: { via: 'winget', cmd: 'winget install --id T3Tools.T3Code -e' } },
  { id: 'chatgpt', name: 'ChatGPT', url: 'https://chatgpt.com/download', startAppsMatch: /^ChatGPT$/, install: { via: 'manual', url: 'https://chatgpt.com/download' } },
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
    return out;
  });
}

/**
 * Antigravity presence for the Accounts page. The vendor caches ONE Google login per
 * machine in the OS keyring, offers no headless whoami/usage command, and no account
 * selection variable, so presence plus honest notes is everything that can be shown.
 */
export async function antigravityPresence() {
  const out = { cliInstalled: false, appInstalled: false };
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await run(finder, ['agy'], { windowsHide: true, timeout: 4000 });
    out.cliInstalled = stdout.trim().length > 0;
  } catch { /* not on this process's PATH */ }
  if (!out.cliInstalled && process.platform === 'win32') {
    out.cliInstalled = findBinIn(freshPathDirs(), 'agy') != null;
  }
  out.appInstalled = fs.existsSync(path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Antigravity', 'Antigravity.exe'));
  return out;
}

/** Launch by exe path when there is one, else through the Windows app registry. */
export function launchApp({ exePath, appId }) {
  if (exePath) {
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  if (appId) {
    spawn('explorer.exe', [`shell:AppsFolder\\${appId}`], { detached: true, stdio: 'ignore' }).unref();
    return true;
  }
  throw new Error('nothing to launch');
}
