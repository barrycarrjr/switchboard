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
    // The token lives in the OS keyring; the JSONC config records who is logged in
    // as objects like { "login": "someone", "host": "..." } under loggedInUsers.
    credContent: { file: 'config.json', pattern: /"login"\s*:\s*"[^"]+"/, identity: /"login"\s*:\s*"([^"]+)"/ },
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
    // Antigravity keeps its state in ~/.gemini too, so a credential sitting there is no
    // evidence that Gemini CLI itself is on this machine. See `sharedDir` below.
    sharedDir: true,
    // Google retired Gemini CLI for personal accounts (free / AI Pro / Ultra) on
    // 2026-06-18 and points those users at Antigravity (agy). Enterprise licenses
    // and paid API keys still work, so the card stays while the tool is present.
    note: 'Retired by Google for personal accounts in June 2026, replaced by Antigravity (agy). Still works with enterprise licenses or paid API keys. A separate Google login from Antigravity.',
  },
];

function credentialState(entry, homeDir) {
  try {
    if (entry.credFiles) {
      return { signedIn: entry.credFiles.some((f) => fs.existsSync(path.join(homeDir, f))), who: null };
    }
    if (entry.credContent) {
      const raw = fs.readFileSync(path.join(homeDir, entry.credContent.file), 'utf8');
      const who = entry.credContent.identity ? (entry.credContent.identity.exec(raw)?.[1] ?? null) : null;
      return { signedIn: entry.credContent.pattern.test(raw), who };
    }
    if (entry.credPattern) {
      return { signedIn: fs.readdirSync(homeDir).some((f) => entry.credPattern.test(f) && fs.statSync(path.join(homeDir, f)).isFile()), who: null };
    }
  } catch { /* unreadable is not signed in */ }
  return { signedIn: false, who: null };
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

/**
 * Detect all presence entries. whichFn is injectable for tests.
 *
 * A card needs the tool on the machine, or a sign-in that proves it was. The second half
 * matters for a tool whose command is not on PATH at all: Junie is an IDE plugin, so its
 * credential is the only evidence it exists, and requiring the binary would hide a tool
 * the person plainly has.
 *
 * That reasoning breaks for a config folder shared with another product. Antigravity
 * writes credentials into ~/.gemini, so finding one there says nothing about Gemini CLI,
 * and after the CLI was uninstalled the page went on advertising a signed-in Gemini
 * account that had nothing left to run it. For those entries the tool itself has to be
 * present. `accounts.js` refuses to read the same folder as evidence for the same reason.
 */
export async function detectPresence({ whichFn = null } = {}) {
  const out = [];
  for (const entry of PRESENCE) {
    const home = entry.home();
    const cliInstalled = await onPath(entry.bin, whichFn);
    const { signedIn, who } = credentialState(entry, home);
    if (!cliInstalled && (!signedIn || entry.sharedDir)) continue; // nothing real to show
    out.push({
      id: entry.id,
      name: entry.name,
      account: entry.account,
      url: entry.url,
      bin: entry.bin,
      note: entry.note,
      cliInstalled,
      signedIn,
      who,
    });
  }
  return out;
}
