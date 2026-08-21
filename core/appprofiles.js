import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath } from './paths.js';
import { defaultClaudeDesktopProfile, readClaudeAccountIdentity, readDesktopOrganization } from './quota.js';

/**
 * Desktop apps that can be opened on a chosen account.
 *
 * A desktop app keeps its sign-in in a data folder, so a second folder is a second
 * account, exactly as a CLI's config folder is. The difference is that no environment
 * variable selects it: the folder is named on the command line. That makes this
 * possible only where the vendor's own binary takes such a flag AND Switchboard can
 * find that binary, so the table lists the flag rather than assuming one.
 *
 * Nothing here signs anything in or out. Switchboard opens the app pointed at a
 * folder; the vendor's own sign-in owns what is in it, as with every account here.
 *
 * Deliberately absent, because a second folder would mislead rather than help:
 *   Antigravity  keeps one Google login per machine in the OS keyring, so a second
 *                folder would silently share the first one's identity.
 *   T3 Code      switches accounts inside itself, so a second folder would duplicate
 *                the account list instead of adding an account.
 *   LM Studio    runs local models and has no account to open on.
 * The Codex app is absent for a different reason: it is Chromium-based and very
 * likely takes the same flag, but nobody has verified it, and a button wired to an
 * unverified flag is worse than no button.
 */
export const APP_PROFILES = {
  'claude-desktop': {
    provider: 'claude',
    // Chromium's own switch, which Claude Desktop inherits from Electron.
    flag: (dir) => `--user-data-dir=${dir}`,
    defaultDir: (env = process.env) => defaultClaudeDesktopProfile(env),
    // Where a second profile is looked for: a dot-folder in the home directory, beside
    // the config folders the CLIs keep. Deliberately nowhere else. Folders sitting
    // beside the standard profile were tried and dropped, because the app leaves its
    // own backups there ("Claude.RESET-BACKUP-...") and a backup offered as an account
    // is the kind of thing that looks configured and fails on first use. Anything kept
    // somewhere else is added by hand, once.
    scans: ({ homeDir = os.homedir() } = {}) => [{ dir: homeDir, match: /^\.claude-desktop/i }],
    organizationOf: readDesktopOrganization,
    accountOrganization: (home) => readClaudeAccountIdentity(home)?.organizationUuid ?? null,
  },
};

export function appProfileDef(appId) {
  return APP_PROFILES[appId] ?? null;
}

/**
 * Files a Chromium-based app writes the first time it runs in a folder. Requiring one
 * of them keeps detection to folders the app has genuinely used: a name that merely
 * looks right is not evidence, and offering the wrong folder would point a launch at
 * somebody else's data.
 */
const PROFILE_MARKERS = ['Local State', 'Preferences'];

export function looksLikeProfile(dir, exists = fs.existsSync) {
  return PROFILE_MARKERS.some((marker) => exists(path.join(dir, marker)));
}

function subdirNames(dir, readdir) {
  try {
    return readdir(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/**
 * Every folder this app can be opened on, most-expected first: the standard profile,
 * then the ones found beside it, then any the person added by hand.
 *
 * The standard profile is always listed even when it does not exist yet, because it
 * is what the plain Launch button has always opened. Detected folders must look like
 * a profile; added folders are listed as given, since asking for one is the person
 * saying what it is.
 */
export function discoverProfileDirs(appId, {
  homeDir = os.homedir(),
  env = process.env,
  extra = [],
  readdir = fs.readdirSync,
  exists = fs.existsSync,
} = {}) {
  const def = appProfileDef(appId);
  if (!def) return [];
  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.some((seen) => samePath(seen, dir))) dirs.push(dir);
  };
  add(def.defaultDir(env));
  for (const place of def.scans({ homeDir, env })) {
    for (const name of subdirNames(place.dir, readdir)) {
      if (!place.match.test(name)) continue;
      const candidate = path.join(place.dir, name);
      if (looksLikeProfile(candidate, exists)) add(candidate);
    }
  }
  for (const dir of extra) add(dir);
  return dirs;
}

/**
 * Name each folder for the panel. A profile is named after the registered account it
 * is signed in as, matched on the organization both sides report, so the Apps row and
 * the Terminals row say the same word for the same subscription. A folder that has
 * never reported one is named after itself rather than guessed at.
 *
 * `accounts` are already reduced to { id, label, organizationUuid } so this stays
 * pure and testable; reading those values is the caller's job.
 */
export function describeProfiles(dirs, { accounts = [], organizationOf = () => null, defaultDir = null } = {}) {
  return dirs.map((dir) => {
    const isDefault = samePath(dir, defaultDir);
    const organization = organizationOf(dir);
    const account = organization
      ? accounts.find((a) => a.organizationUuid && a.organizationUuid === organization) ?? null
      : null;
    return {
      dir,
      accountId: account?.id ?? null,
      label: account?.label ?? (isDefault ? 'Default' : path.basename(dir)),
      isDefault,
    };
  });
}

/**
 * Which profile the button itself opens: the one belonging to the account that is the
 * machine default right now, so switching account in Switchboard moves the app along
 * with the terminals. With no match it opens the standard profile, which is what the
 * button did before any of this existed.
 */
export function chooseOpenProfile(profiles = [], activeAccountId = null) {
  if (!profiles.length) return null;
  const byAccount = activeAccountId ? profiles.find((p) => p.accountId === activeAccountId) : null;
  return byAccount ?? profiles.find((p) => p.isDefault) ?? profiles[0];
}

/**
 * The arguments that open this app on one folder. Returned as a list, never as a
 * command string: a Windows folder name may legally contain a quote or an ampersand,
 * and a list never gets re-parsed by a shell.
 */
export function profileLaunchArgs(appId, dir) {
  const def = appProfileDef(appId);
  if (!def) throw new Error(`${appId} cannot be opened on a chosen account`);
  if (!dir) throw new Error('a profile folder is required');
  return [def.flag(dir)];
}

/**
 * Whether a folder is safe to hand an app as its data folder. Empty is fine (the app
 * fills it), and an existing profile of that same app is fine. Anything else is
 * refused: pointing an app at a folder holding other work scatters its files through
 * it, and there is no undo for that.
 */
export function profileFolderProblem(dir, { readdir = fs.readdirSync, exists = fs.existsSync } = {}) {
  let entries;
  try {
    entries = readdir(dir);
  } catch {
    return 'that folder cannot be read';
  }
  if (entries.length === 0) return null;
  if (looksLikeProfile(dir, exists)) return null;
  return 'that folder already holds something else, so it is not safe to use as an app profile';
}
