import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { customizationsDir } from './paths.js';
import {
  DEFAULT_SHARED_AI_FOLDER,
  activeSharedFolder,
  backupFolderNameProblem,
  backupFolderSetting,
  expandHome,
  isInsideFolder,
  sharedFolderProblem,
  sharedFolderSetting,
  toSettingPath,
} from './shared-folder.js';

/**
 * The `files` section of a configuration export: the shared AI folder's ticked
 * folders and Switchboard's own skills, as text, so a backup taken before an import or
 * an upgrade (or carried to a new machine) brings the rules and skills back too.
 *
 * Two roots only, and nothing outside them: the shared folder (each ticked top-level
 * folder, recursively) and `customizationsDir()/skills`. Every path is stored relative
 * to its root, so a restore can put the files under a different folder on another
 * machine.
 *
 * Text only, and bounded: a file holding a NUL byte or that is not valid UTF-8 is not
 * text; one over 1 MB is not a rule or a skill; and the whole section stops at 15 MB so
 * an export stays a file people can mail and keep. The 15 MB is counted as the files
 * will be written into the export (quotes and line breaks escaped), not as they sit on
 * disk, so the export cannot outgrow the import limit by escaping alone. What is left
 * out is listed with its reason, in the export itself, so nobody has to guess what is
 * missing; the list keeps MAX_SKIPPED entries and counts the rest.
 *
 * Once the 15 MB is spent the walk stops, rather than noting every further file: a
 * ticked folder holding a package install would otherwise add a note per file, and a
 * list that long makes the export one an import refuses. Folders of installed or
 * generated files (BULK_FOLDERS) are left out whole for the same reason.
 *
 * Switchboard's own backup copies (`*.bak-*`, `*.before-switchboard-rules`,
 * `*.before-import-*`) are left out without a note: they are copies of files already in
 * the section, and there can be many.
 */

export const FILE_LIMIT = 1024 * 1024;
export const TOTAL_LIMIT = 15 * 1024 * 1024;
const MAX_ENTRIES = 100000;
export const MAX_SKIPPED = 200;

/**
 * The indentation, quotes, keys and commas a pretty-printed export puts around one file
 * entry, generously rounded up. Added to each entry's escaped size so the budget is
 * never an underestimate of what is written.
 */
const ENTRY_OVERHEAD = 64;

const BULK_FOLDERS = new Set(['node_modules', '.git', '__pycache__', '.venv']);

const OWN_BACKUP_RX = /\.bak-|\.before-switchboard-rules$|\.before-import-|\.tmp-\d/;

const FULL_REASON = 'the backup already holds its 15 MB of files, so this and everything after it were left out';

export function switchboardSkillsDir() {
  return path.join(customizationsDir(), 'skills');
}

function realOrNull(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

function sameOrInside(file, dir) {
  const a = realOrNull(file);
  const b = realOrNull(dir);
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase() || isInsideFolder(a, b);
}

const toPosix = (rel) => rel.split(path.sep).join('/');

/** A left-out note, kept while the list has room and counted once it is full. */
function leaveOut(section, entry) {
  if (section.skipped.length < MAX_SKIPPED) section.skipped.push(entry);
  else section.skippedMore += 1;
}

/** Read every file under `start` into `list`, relative to `root`, noting what was left out. */
function gather(start, root, rootName, list, section, budget) {
  const visited = new Set();
  const note = (rel, reason) => leaveOut(section, { root: rootName, path: rel, reason });
  const visit = (full) => {
    if (budget.full) return;
    const rel = toPosix(path.relative(root, full));
    if (OWN_BACKUP_RX.test(path.basename(full))) return;
    if (!sameOrInside(full, root)) {
      note(rel, 'a link to somewhere outside the folder');
      return;
    }
    let st;
    try { st = fs.statSync(full); } catch {
      note(rel, 'cannot be read');
      return;
    }
    if (st.isDirectory()) {
      if (full !== start && BULK_FOLDERS.has(path.basename(full).toLowerCase())) {
        note(rel, 'a folder of installed or generated files, left out whole');
        return;
      }
      const real = realOrNull(full)?.toLowerCase();
      if (!real || visited.has(real)) return;
      visited.add(real);
      let names = [];
      try { names = fs.readdirSync(full).sort((a, b) => a.localeCompare(b)); } catch {
        note(rel, 'cannot be read');
        return;
      }
      for (const name of names) visit(path.join(full, name));
      return;
    }
    if (!st.isFile()) return;
    if (st.size > FILE_LIMIT) {
      note(rel, 'over 1 MB');
      return;
    }
    let buf;
    try { buf = fs.readFileSync(full); } catch {
      note(rel, 'cannot be read');
      return;
    }
    if (buf.includes(0)) {
      note(rel, 'not a text file');
      return;
    }
    const text = buf.toString('utf8');
    // Decoding must give the same bytes back, or the restore would write a different file.
    if (!Buffer.from(text, 'utf8').equals(buf)) {
      note(rel, 'not UTF-8 text');
      return;
    }
    const cost = Buffer.byteLength(JSON.stringify(rel), 'utf8') + Buffer.byteLength(JSON.stringify(text), 'utf8') + ENTRY_OVERHEAD;
    if (budget.used + cost > budget.limit || list.length >= MAX_ENTRIES) {
      note(rel, FULL_REASON);
      budget.full = true;
      return;
    }
    budget.used += cost;
    list.push({ path: rel, text });
  };
  visit(start);
}

/**
 * Build the `files` section from what is on disk now. Never throws over a file: one
 * that cannot be read is listed as skipped, because this also runs before an upgrade,
 * and a stray unreadable file must not stop the safety copy being taken.
 */
export function collectFilesSection({
  settings,
  rulesSources = [],
  home = os.homedir(),
  skillsRoot = switchboardSkillsDir(),
  totalLimit = TOTAL_LIMIT,
} = {}) {
  const section = {
    sharedFolder: sharedFolderSetting(settings),
    backupFolders: backupFolderSetting(settings),
    rulesSources: [],
    shared: [],
    skills: [],
    skipped: [],
    skippedMore: 0,
  };
  const budget = { used: 0, limit: totalLimit, full: false };
  // Switchboard's own skills first: they are small, they live nowhere else, and a large
  // ticked folder in the shared folder must not be able to crowd them out of the budget.
  if (skillsRoot && fs.existsSync(skillsRoot)) gather(skillsRoot, skillsRoot, 'skills', section.skills, section, budget);
  const shared = activeSharedFolder(settings, { home });
  if (shared) {
    for (const name of section.backupFolders) {
      const dir = path.join(shared, name);
      if (!fs.existsSync(dir)) continue;
      if (budget.full) leaveOut(section, { root: 'shared', path: name, reason: 'not read: the backup already holds its 15 MB of files' });
      else gather(dir, shared, 'shared', section.shared, section, budget);
    }
  }
  for (const src of rulesSources) {
    if (shared && sameOrInside(src, shared)) {
      let rel = path.relative(shared, src);
      // Reached through a link: say where it is inside the folder itself.
      if (rel.startsWith('..') || path.isAbsolute(rel)) rel = path.relative(realOrNull(shared), realOrNull(src));
      section.rulesSources.push(toPosix(rel));
    } else {
      leaveOut(section, { root: 'rules', path: src, reason: shared ? 'a rule file outside the shared AI folder' : 'no shared AI folder to keep it relative to' });
    }
  }
  // The roots themselves are not files; drop the empty entry a root's own visit can add.
  section.skipped = section.skipped.filter((s) => s.path !== '');
  return section;
}

function shortText(value, field, max = 32767) {
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function entries(value, field) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > MAX_ENTRIES) throw new Error(`${field} must be a list`);
  return value.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${field}[${i}] must be an object`);
    if (typeof raw.text !== 'string') throw new Error(`${field}[${i}].text must be text`);
    return { path: shortText(raw.path, `${field}[${i}].path`, 4096), text: raw.text };
  });
}

/**
 * Check the shape of an imported `files` section. Paths are kept exactly as given:
 * whether each one is safe to write is decided when it is written (safeTarget), so an
 * unsafe entry is skipped and reported rather than refusing the whole import.
 */
export function normalizeFilesSection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('files must be an object');
  const list = (v, field) => {
    if (v == null) return [];
    if (!Array.isArray(v) || v.length > MAX_ENTRIES) throw new Error(`${field} must be a list`);
    return v.map((s, i) => shortText(s, `${field}[${i}]`, 4096));
  };
  const skipped = value.skipped == null ? [] : value.skipped;
  if (!Array.isArray(skipped) || skipped.length > MAX_ENTRIES) throw new Error('files.skipped must be a list');
  const more = value.skippedMore == null ? 0 : value.skippedMore;
  if (!Number.isSafeInteger(more) || more < 0) throw new Error('files.skippedMore must be a count');
  return {
    sharedFolder: value.sharedFolder == null ? DEFAULT_SHARED_AI_FOLDER : shortText(value.sharedFolder, 'files.sharedFolder'),
    backupFolders: list(value.backupFolders, 'files.backupFolders'),
    rulesSources: list(value.rulesSources, 'files.rulesSources'),
    shared: entries(value.shared, 'files.shared'),
    skills: entries(value.skills, 'files.skills'),
    skipped: skipped.map((s, i) => ({
      root: shortText(String(s?.root ?? ''), `files.skipped[${i}].root`, 64),
      path: shortText(String(s?.path ?? ''), `files.skipped[${i}].path`),
      reason: shortText(String(s?.reason ?? ''), `files.skipped[${i}].reason`, 512),
    })),
    skippedMore: more,
  };
}

/** Counts for the confirmation: folders, files, bytes, and how many were left out. */
export function filesSummary(files) {
  const all = [...(files?.shared ?? []), ...(files?.skills ?? [])];
  return {
    folders: (files?.backupFolders?.length ?? 0) + ((files?.skills?.length ?? 0) ? 1 : 0),
    files: all.length,
    bytes: all.reduce((n, e) => n + Buffer.byteLength(e.text, 'utf8'), 0),
    skipped: (files?.skipped?.length ?? 0) + (files?.skippedMore ?? 0),
  };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Lines naming each skipped file and why, for a dialog; long lists are cut with a count.
 * `uncounted` is how many more were left out than the list itself holds (skippedMore).
 */
export function describeSkipped(skipped = [], max = 15, uncounted = 0) {
  const lines = skipped.slice(0, max).map((s) => `${s.root}: ${s.path} (${s.reason})`);
  const rest = Math.max(0, skipped.length - max) + uncounted;
  if (rest) lines.push(`and ${rest} more`);
  return lines;
}

/**
 * Where an import should put the shared folder by default: the backup's own setting,
 * resolved for this machine's home folder. A backup whose folder was off but that still
 * holds shared files is given the default folder, since the files need somewhere to go.
 *
 * A backup is a file anyone can hand over, so its folder is checked like one typed in
 * Settings. One that is not allowed (the home folder itself, a folder outside it, a
 * network share) is never offered: `refused` says which and why, and the default folder
 * is offered instead. `suggested` is always the folder the import will store, null only
 * when the backup had the folder switched off and carries nothing that needs it, so the
 * confirmation can always name it.
 */
export function planFilesImport(files, { home = os.homedir() } = {}) {
  const needsFolder = Boolean(files?.shared?.length || files?.rulesSources?.length);
  const own = files?.sharedFolder || (needsFolder ? DEFAULT_SHARED_AI_FOLDER : '');
  const problem = own ? sharedFolderProblem(own, { home }) : null;
  const refused = problem ? { folder: own, reason: problem } : null;
  const suggested = expandHome(refused ? DEFAULT_SHARED_AI_FOLDER : own, home) || null;
  return { needsFolder, suggested, refused, summary: filesSummary(files) };
}

/**
 * Resolve an untrusted relative path under `root`, or null when it is not one:
 * absolute, a drive or stream name, a `..` or empty part, or anything else that would
 * land outside `root` once joined.
 */
export function safeTarget(root, rel) {
  if (!root || typeof rel !== 'string' || !rel || rel.length > 4096 || /[\0:]/.test(rel)) return null;
  if (path.posix.isAbsolute(rel) || path.win32.isAbsolute(rel)) return null;
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return null;
  const base = path.resolve(root);
  const full = path.resolve(base, ...parts);
  const back = path.relative(base, full);
  if (!back || back.startsWith('..') || path.isAbsolute(back)) return null;
  return full;
}

/**
 * Would writing `full` follow a link out of `root`? Checked on the nearest part of the
 * path that already exists, since that is what the write would go through.
 */
function escapesThroughLink(root, full) {
  const realRoot = realOrNull(root);
  if (!realRoot) return false; // the root does not exist yet, so nothing under it can be a link
  let probe = full;
  while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
  const real = realOrNull(probe);
  if (!real) return true;
  return !(real.toLowerCase() === realRoot.toLowerCase() || isInsideFolder(real, realRoot));
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/**
 * Put the files from a backup back. For each one: the same text already there is left
 * alone; different text is copied aside as `<file>.before-import-<time>` and then
 * replaced; a missing file is created with its folders. An entry that would land outside
 * its root is skipped and reported, never written. Returns what happened to each file,
 * the rule file list re-rooted onto `sharedRoot` (only files that now exist), and the
 * ticks with any unsafe or hidden name dropped.
 *
 * Nothing in the backup is trusted to say where it may write. `sharedRoot` is checked
 * here as well as by the caller, and a shared folder that is not allowed gets nothing
 * written into it. A shared file is restored only when the first part of its path is
 * one of the backup's own ticks, after those ticks have been checked, because an export
 * only ever holds files from ticked folders: anything else in the section was put there
 * by hand.
 */
export function restoreFilesSection(files, { sharedRoot, skillsRoot = switchboardSkillsDir(), home = os.homedir(), now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const result = { created: [], replaced: [], same: [], aside: [], skipped: [], rulesSources: [], backupFolders: [] };
  for (const name of files?.backupFolders ?? []) {
    const problem = backupFolderNameProblem(name);
    if (problem) {
      result.skipped.push({ root: 'ticks', path: String(name), reason: problem });
    } else if (!result.backupFolders.some((n) => n.toLowerCase() === name.toLowerCase())) {
      result.backupFolders.push(name);
    }
  }
  const ticked = new Set(result.backupFolders.map((n) => n.toLowerCase()));
  const sharedProblem = sharedRoot ? sharedFolderProblem(sharedRoot, { home }) : null;
  const refusedRoot = sharedProblem ? `${sharedRoot} cannot be the shared AI folder: ${sharedProblem}` : null;
  const roots = [['shared', sharedRoot, files?.shared ?? []], ['skills', skillsRoot, files?.skills ?? []]];
  for (const [rootName, root, list] of roots) {
    for (const entry of list) {
      if (rootName === 'shared' && refusedRoot) {
        result.skipped.push({ root: rootName, path: String(entry.path), reason: refusedRoot });
        continue;
      }
      const target = safeTarget(root, entry.path);
      if (!target) {
        result.skipped.push({ root: rootName, path: String(entry.path), reason: root ? 'its path reaches outside its folder' : 'no folder to put it in' });
        continue;
      }
      if (rootName === 'shared' && !ticked.has(entry.path.split(/[\\/]/)[0].toLowerCase())) {
        result.skipped.push({ root: rootName, path: entry.path, reason: 'not in one of the folders the backup carries' });
        continue;
      }
      if (escapesThroughLink(root, target)) {
        result.skipped.push({ root: rootName, path: entry.path, reason: 'a link would take it outside its folder' });
        continue;
      }
      const want = Buffer.from(entry.text, 'utf8');
      try {
        if (fs.existsSync(target)) {
          if (!fs.statSync(target).isFile()) {
            result.skipped.push({ root: rootName, path: entry.path, reason: 'something other than a file is in the way' });
            continue;
          }
          if (fs.readFileSync(target).equals(want)) { result.same.push(target); continue; }
          const aside = `${target}.before-import-${stamp}`;
          fs.copyFileSync(target, aside);
          result.aside.push(aside);
          writeAtomic(target, want);
          result.replaced.push(target);
        } else {
          writeAtomic(target, want);
          result.created.push(target);
        }
      } catch (e) {
        result.skipped.push({ root: rootName, path: entry.path, reason: `could not be written: ${e.message}` });
      }
    }
  }
  for (const rel of files?.rulesSources ?? []) {
    const target = refusedRoot ? null : safeTarget(sharedRoot, rel);
    if (refusedRoot) {
      result.skipped.push({ root: 'rules', path: String(rel), reason: refusedRoot });
    } else if (!target || escapesThroughLink(sharedRoot, target)) {
      result.skipped.push({ root: 'rules', path: String(rel), reason: 'its path reaches outside the shared folder' });
    } else if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      result.rulesSources.push(target);
    } else {
      result.skipped.push({ root: 'rules', path: rel, reason: 'a listed rule file that is neither in the backup nor on this machine' });
    }
  }
  return result;
}

/** The shared folder setting to store after an import into `folder`. */
export function sharedSettingFor(folder, { home = os.homedir() } = {}) {
  return folder ? toSettingPath(folder, home) : '';
}
