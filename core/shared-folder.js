import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The shared AI folder.
 *
 * Rule files, skills and scripts meant for every AI tool on the machine live in one
 * folder the user owns, `~/.ai` unless they choose another. Switchboard does not own
 * that folder and never creates it just because the setting names it: until it exists,
 * everything that depends on it simply treats it as absent. Only a restore, which has
 * files to put there, makes it.
 *
 * The setting is stored as typed, with a leading `~` meaning the current user's home,
 * resolved at use time. So the stored value never carries one person's profile path,
 * and a settings export restored on another machine or under another user name still
 * points at that user's own folder.
 */

export const DEFAULT_SHARED_AI_FOLDER = '~/.ai';

/** Ticked on a fresh install; a name is only offered when that folder exists. */
export const DEFAULT_BACKUP_FOLDERS = Object.freeze(['rules', 'skills']);

/**
 * A top-level folder name inside the shared folder, and nothing else. A separator or a
 * `..` would let a stored tick (or an imported one) reach outside the shared folder.
 */
export function isPlainFolderName(name) {
  if (typeof name !== 'string') return false;
  const n = name.trim();
  if (!n || n !== name || n.length > 255) return false;
  if (n === '.' || n.includes('..')) return false;
  return !/[\\/:\0*?"<>|]/.test(n);
}

/**
 * Why a folder name cannot be ticked for backups, or null when it can. A hidden name
 * (one starting with a dot) is refused as well as an unsafe one: `.ssh`, `.aws` and
 * `.claude` are where keys and tool settings live, and a tick is what puts a folder's
 * files into every export and lets an import write into it. A shared folder has no
 * business holding one of those, so no route (the page, the command line, an import)
 * may tick one.
 */
export function backupFolderNameProblem(name) {
  if (!isPlainFolderName(name)) return 'not a plain folder name';
  if (name.startsWith('.')) return 'a hidden folder, which a backup never carries';
  return null;
}

/** Clean list of folder names: refuses a bad name rather than quietly dropping it. */
export function normalizeBackupFolders(names) {
  if (!Array.isArray(names)) throw new Error('backup folders must be a list of folder names');
  const out = [];
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    const problem = backupFolderNameProblem(name);
    if (problem) throw new Error(`${problem}: ${raw}`);
    if (!out.some((n) => n.toLowerCase() === name.toLowerCase())) out.push(name);
  }
  return out;
}

/** Expand a leading `~` to the home folder and make the result absolute. */
export function expandHome(value, home = os.homedir()) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  return path.resolve(/^~(?=$|[\\/])/.test(s) ? path.join(home, s.slice(1)) : s);
}

/**
 * How a chosen folder is stored: under the home folder it becomes `~/...`, so the
 * setting stays portable and never spells out a user name.
 */
export function toSettingPath(folder, home = os.homedir()) {
  const s = String(folder ?? '').trim();
  if (!s) return '';
  if (/^~(?=$|[\\/])/.test(s)) return `~${s.slice(1).split(/[\\/]+/).join('/')}`.replace(/\/$/, '') || '~';
  const abs = path.resolve(s);
  const rel = path.relative(home, abs);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return `~/${rel.split(path.sep).join('/')}`;
  return abs;
}

/** `\\server\share`, `//server/share`, and the `\\?\` and `\\.\` device forms alike. */
function isNetworkPath(p) {
  return /^[\\/]{2}/.test(String(p ?? ''));
}

function realOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

/**
 * Where `p` really is: the real location of the nearest part of it that exists, with
 * the rest added back. A folder that does not exist yet still lands wherever its
 * nearest existing parent leads, so a link in the way is seen before anything is made.
 */
function realLocation(p) {
  let probe = path.resolve(p);
  const rest = [];
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) {
    rest.unshift(path.basename(probe));
    probe = path.dirname(probe);
  }
  const real = realOrNull(probe);
  return real ? path.join(real, ...rest) : null;
}

function strictlyInside(p, dir) {
  const rel = path.relative(path.resolve(dir).toLowerCase(), path.resolve(p).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function placeProblem(p, home) {
  if (isNetworkPath(p)) return 'it is a network folder, and the shared AI folder must be on this computer';
  if (path.resolve(p).toLowerCase() === path.resolve(home).toLowerCase()) return 'it is your home folder itself; choose a folder inside it, such as ~/.ai';
  if (!strictlyInside(p, home)) return 'it is outside your home folder; choose a folder inside it, such as ~/.ai';
  return null;
}

/**
 * Why a folder cannot be the shared AI folder, or null when it can (or when the value
 * is empty, which switches the folder off).
 *
 * The folder is where an import writes files and what every export reads, and its
 * `skills` folder is copied into every tool. So it must be a folder of the user's own,
 * strictly inside the home folder: the home folder itself would let an import write a
 * tool's settings or a Startup entry, and its ticks would carry `.ssh` into every
 * export; a folder elsewhere could be anyone's; and a network folder would let a
 * remote server decide which skills every tool loads. A link is followed before the
 * check, so `~/x` leading to one of those places is refused too. A mapped drive that
 * is really a network share cannot be told from a local drive this way and is not
 * caught here.
 */
export function sharedFolderProblem(value, { home = os.homedir() } = {}) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (/\0/.test(raw)) return 'it is not a folder path';
  if (isNetworkPath(raw)) return placeProblem(raw, home);
  const resolved = expandHome(raw, home);
  const literal = placeProblem(resolved, home);
  if (literal) return literal;
  const real = realLocation(resolved);
  const realHome = realOrNull(home) ?? path.resolve(home);
  return real ? placeProblem(real, realHome) : null;
}

/** sharedFolderProblem as an error, for a route that is about to store or use the folder. */
export function checkSharedFolder(value, { home = os.homedir() } = {}) {
  const problem = sharedFolderProblem(value, { home });
  if (problem) throw new Error(`${expandHome(value, home) || value} cannot be the shared AI folder: ${problem}`);
}

/** The stored setting: the default when never set, an empty string when switched off. */
export function sharedFolderSetting(settings) {
  const v = settings?.sharedAiFolder;
  return typeof v === 'string' ? v : DEFAULT_SHARED_AI_FOLDER;
}

/** The resolved folder the setting names, whether or not it exists; null when off. */
export function sharedFolderPath(settings, { home = os.homedir() } = {}) {
  return expandHome(sharedFolderSetting(settings), home) || null;
}

function isDirectory(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/**
 * The shared folder when it is set, allowed AND exists; null otherwise, so callers treat
 * it as absent. A stored value that is not allowed (an older version stored it, or the
 * settings file was edited by hand) is checked here too, so nothing ever reads from or
 * writes into such a folder whichever way the value got there.
 */
export function activeSharedFolder(settings, { home = os.homedir() } = {}) {
  const p = sharedFolderPath(settings, { home });
  if (!p || sharedFolderProblem(sharedFolderSetting(settings), { home })) return null;
  return isDirectory(p) ? p : null;
}

/**
 * `<shared folder>/skills` when the shared folder is set and that folder exists in it;
 * null otherwise. Skills sync and the skills list both treat null as "no shared skills",
 * so nothing is created and nothing already copied out is removed on its account.
 */
export function activeSharedSkillsFolder(settings, { home = os.homedir() } = {}) {
  const shared = activeSharedFolder(settings, { home });
  if (!shared) return null;
  const dir = path.join(shared, 'skills');
  return isDirectory(dir) ? dir : null;
}

/**
 * The skills kept in a shared skills folder: each immediate subfolder (or link to one)
 * holding a SKILL.md. A name carrying `.bak-` or `.before-` is a copy some tool or
 * Switchboard set aside, not a skill of its own, so it is never handed out as one.
 */
export function listSharedSkillFolders(skillsDir) {
  if (!skillsDir || !isDirectory(skillsDir)) return [];
  let entries = [];
  try { entries = fs.readdirSync(skillsDir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => isPlainFolderName(e.name) && !/\.bak-|\.before-/.test(e.name))
    .map((e) => ({ name: e.name, dir: path.join(skillsDir, e.name) }))
    .filter((s) => isDirectory(s.dir) && fs.existsSync(path.join(s.dir, 'SKILL.md')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The folder names a person can tick: the top-level folders that exist in it now. */
export function listSharedSubfolders(folder) {
  if (!folder || !isDirectory(folder)) return [];
  let entries = [];
  try { entries = fs.readdirSync(folder, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => !backupFolderNameProblem(e.name) && (e.isDirectory() || (e.isSymbolicLink() && isDirectory(path.join(folder, e.name)))))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
}

/** The stored ticks, cleaned; anything unreadable falls back to the default. */
export function backupFolderSetting(settings) {
  try {
    return normalizeBackupFolders(settings?.sharedAiBackupFolders ?? DEFAULT_BACKUP_FOLDERS);
  } catch {
    return [...DEFAULT_BACKUP_FOLDERS];
  }
}

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** Is `file` inside `dir` (or the folder itself), once links on either side are resolved? */
export function isInsideFolder(file, dir) {
  const rel = path.relative(realOrSelf(dir).toLowerCase(), realOrSelf(file).toLowerCase());
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * Everything the Settings page and `switchboard settings` show about the folder.
 * `subfolders` lists only folders that exist, each with whether it is ticked. A stored
 * folder that is not allowed is reported with `problem` and treated as absent.
 */
export function sharedFolderState(settings, { home = os.homedir() } = {}) {
  const setting = sharedFolderSetting(settings);
  const resolved = sharedFolderPath(settings, { home });
  const problem = resolved ? sharedFolderProblem(setting, { home }) : null;
  const exists = Boolean(resolved && !problem && isDirectory(resolved));
  const ticks = backupFolderSetting(settings);
  const subfolders = exists
    ? listSharedSubfolders(resolved).map((name) => ({ name, ticked: ticks.some((t) => t.toLowerCase() === name.toLowerCase()) }))
    : [];
  return { setting, path: resolved, exists, problem, backupFolders: ticks, subfolders };
}

/** Settings with a new shared folder. `''` (or null) switches it off. */
export function withSharedFolder(settings, value, { home = os.homedir() } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (/\0/.test(raw)) throw new Error('not a folder path');
  checkSharedFolder(raw, { home });
  const stored = raw ? toSettingPath(raw, home) : '';
  if (stored) {
    const resolved = expandHome(stored, home);
    // An existing file is a typo, not a folder that will appear later.
    if (fs.existsSync(resolved) && !isDirectory(resolved)) throw new Error(`not a folder: ${resolved}`);
  }
  return { ...settings, sharedAiFolder: stored };
}

/** Settings with a new list of folders to back up. */
export function withBackupFolders(settings, names) {
  return { ...settings, sharedAiBackupFolders: normalizeBackupFolders(names) };
}
