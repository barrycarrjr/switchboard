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

/** Clean list of folder names: refuses a bad name rather than quietly dropping it. */
export function normalizeBackupFolders(names) {
  if (!Array.isArray(names)) throw new Error('backup folders must be a list of folder names');
  const out = [];
  for (const raw of names) {
    const name = String(raw ?? '').trim();
    if (!isPlainFolderName(name)) throw new Error(`not a plain folder name: ${raw}`);
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

/** The shared folder when it is set AND exists; null otherwise, so callers treat it as absent. */
export function activeSharedFolder(settings, { home = os.homedir() } = {}) {
  const p = sharedFolderPath(settings, { home });
  return p && isDirectory(p) ? p : null;
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
    .filter((e) => isPlainFolderName(e.name) && (e.isDirectory() || (e.isSymbolicLink() && isDirectory(path.join(folder, e.name)))))
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
 * `subfolders` lists only folders that exist, each with whether it is ticked.
 */
export function sharedFolderState(settings, { home = os.homedir() } = {}) {
  const setting = sharedFolderSetting(settings);
  const resolved = sharedFolderPath(settings, { home });
  const exists = Boolean(resolved && isDirectory(resolved));
  const ticks = backupFolderSetting(settings);
  const subfolders = exists
    ? listSharedSubfolders(resolved).map((name) => ({ name, ticked: ticks.some((t) => t.toLowerCase() === name.toLowerCase()) }))
    : [];
  return { setting, path: resolved, exists, backupFolders: ticks, subfolders };
}

/** Settings with a new shared folder. `''` (or null) switches it off. */
export function withSharedFolder(settings, value, { home = os.homedir() } = {}) {
  const raw = value == null ? '' : String(value).trim();
  if (/\0/.test(raw)) throw new Error('not a folder path');
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
