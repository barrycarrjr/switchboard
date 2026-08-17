import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
import { findBinIn } from './providers.js';
import { freshPathDirs } from './env.js';

/**
 * Account-holding tools that cannot be multiplexed the way Claude and Codex can
 * (their vendors offer one sign-in and no account/usage API). They still deserve a
 * card on the Accounts page: installed or not, signed in or not, and honest notes.
 * A card appears only when there is something real to show (CLI installed, or a
 * credential present).
 */
export const PRESENCE = [
  {
    id: 'junie',
    name: 'Junie',
    account: 'JetBrains account',
    url: 'https://www.jetbrains.com/junie',
    bin: 'junie',
    home: () => path.join(os.homedir(), '.junie'),
    credFiles: ['secure_credentials.json'],
    note: 'Runs on JetBrains AI credits; usage shows in the JetBrains account pages, no local API.',
  },
  {
    id: 'copilot',
    name: 'Copilot CLI',
    account: 'GitHub account',
    url: 'https://github.com/github/copilot-cli',
    bin: 'copilot',
    home: () => path.join(os.homedir(), '.copilot'),
    credPattern: /auth|token|credential|host/i,
    note: 'Signs in with GitHub; usage and plan live in GitHub settings, no local API.',
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    account: 'Google account',
    url: 'https://github.com/google-gemini/gemini-cli',
    bin: 'gemini',
    home: () => path.join(os.homedir(), '.gemini'),
    credFiles: ['oauth_creds.json'],
    note: 'A separate Google login from Antigravity, even for the same person.',
  },
];

function hasCredential(entry, homeDir) {
  try {
    if (entry.credFiles) {
      return entry.credFiles.some((f) => fs.existsSync(path.join(homeDir, f)));
    }
    if (entry.credPattern) {
      return fs.readdirSync(homeDir).some((f) => entry.credPattern.test(f) && fs.statSync(path.join(homeDir, f)).isFile());
    }
  } catch { /* unreadable is not signed in */ }
  return false;
}

async function onPath(bin, whichFn) {
  if (whichFn) return whichFn(bin);
  try {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const { stdout } = await run(finder, [bin], { windowsHide: true, timeout: 4000 });
    if (stdout.trim().length > 0) return true;
  } catch { /* fall through to the persisted PATH */ }
  return process.platform === 'win32' && findBinIn(freshPathDirs(), bin) != null;
}

/** Detect all presence entries. whichFn is injectable for tests. */
export async function detectPresence({ whichFn = null } = {}) {
  const out = [];
  for (const entry of PRESENCE) {
    const home = entry.home();
    const cliInstalled = await onPath(entry.bin, whichFn);
    const signedIn = hasCredential(entry, home);
    if (!cliInstalled && !signedIn) continue; // nothing real to show
    out.push({
      id: entry.id,
      name: entry.name,
      account: entry.account,
      url: entry.url,
      bin: entry.bin,
      note: entry.note,
      cliInstalled,
      signedIn,
    });
  }
  return out;
}
