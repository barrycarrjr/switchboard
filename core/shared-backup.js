import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { customizationsDir } from './paths.js';
import {
  DEFAULT_SHARED_AI_FOLDER,
  activeSharedFolder,
  backupFolderSetting,
  expandHome,
  isInsideFolder,
  isPlainFolderName,
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
 * an export stays a file people can mail and keep. Every file left out is listed with
 * its reason, in the export itself, so nobody has to guess what is missing.
 *
 * Switchboard's own backup copies (`*.bak-*`, `*.before-switchboard-rules`,
 * `*.before-import-*`) are left out without a note: they are copies of files already in
 * the section, and there can be many.
 */

export const FILE_LIMIT = 1024 * 1024;
export const TOTAL_LIMIT = 15 * 1024 * 1024;
const MAX_ENTRIES = 100000;

const OWN_BACKUP_RX = /\.bak-|\.before-switchboard-rules$|\.before-import-|\.tmp-\d/;

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

/** Read every file under `start` into `list`, relative to `root`, noting what was left out. */
function gather(start, root, rootName, list, skipped, budget) {
  const visited = new Set();
  const visit = (full) => {
    const rel = toPosix(path.relative(root, full));
    if (OWN_BACKUP_RX.test(path.basename(full))) return;
    if (!sameOrInside(full, root)) {
      skipped.push({ root: rootName, path: rel, reason: 'a link to somewhere outside the folder' });
      return;
    }
    let st;
    try { st = fs.statSync(full); } catch {
      skipped.push({ root: rootName, path: rel, reason: 'cannot be read' });
      return;
    }
    if (st.isDirectory()) {
      const real = realOrNull(full)?.toLowerCase();
      if (!real || visited.has(real)) return;
      visited.add(real);
      let names = [];
      try { names = fs.readdirSync(full).sort((a, b) => a.localeCompare(b)); } catch {
        skipped.push({ root: rootName, path: rel, reason: 'cannot be read' });
        return;
      }
      for (const name of names) visit(path.join(full, name));
      return;
    }
    if (!st.isFile()) return;
    if (st.size > FILE_LIMIT) {
      skipped.push({ root: rootName, path: rel, reason: 'over 1 MB' });
      return;
    }
    let buf;
    try { buf = fs.readFileSync(full); } catch {
      skipped.push({ root: rootName, path: rel, reason: 'cannot be read' });
      return;
    }
    if (buf.includes(0)) {
      skipped.push({ root: rootName, path: rel, reason: 'not a text file' });
      return;
    }
    const text = buf.toString('utf8');
    // Decoding must give the same bytes back, or the restore would write a different file.
    if (!Buffer.from(text, 'utf8').equals(buf)) {
      skipped.push({ root: rootName, path: rel, reason: 'not UTF-8 text' });
      return;
    }
    if (budget.used + buf.length > budget.limit || list.length >= MAX_ENTRIES) {
      skipped.push({ root: rootName, path: rel, reason: 'the backup already holds its 15 MB of files' });
      return;
    }
    budget.used += buf.length;
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
  };
  const budget = { used: 0, limit: totalLimit };
  const shared = activeSharedFolder(settings, { home });
  if (shared) {
    for (const name of section.backupFolders) {
      const dir = path.join(shared, name);
      if (fs.existsSync(dir)) gather(dir, shared, 'shared', section.shared, section.skipped, budget);
    }
  }
  for (const src of rulesSources) {
    if (shared && sameOrInside(src, shared)) {
      let rel = path.relative(shared, src);
      // Reached through a link: say where it is inside the folder itself.
      if (rel.startsWith('..') || path.isAbsolute(rel)) rel = path.relative(realOrNull(shared), realOrNull(src));
      section.rulesSources.push(toPosix(rel));
    } else {
      section.skipped.push({ root: 'rules', path: src, reason: shared ? 'a rule file outside the shared AI folder' : 'no shared AI folder to keep it relative to' });
    }
  }
  if (skillsRoot && fs.existsSync(skillsRoot)) gather(skillsRoot, skillsRoot, 'skills', section.skills, section.skipped, budget);
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
  };
}

/** Counts for the confirmation: folders, files, bytes, and how many were left out. */
export function filesSummary(files) {
  const all = [...(files?.shared ?? []), ...(files?.skills ?? [])];
  return {
    folders: (files?.backupFolders?.length ?? 0) + ((files?.skills?.length ?? 0) ? 1 : 0),
    files: all.length,
    bytes: all.reduce((n, e) => n + Buffer.byteLength(e.text, 'utf8'), 0),
    skipped: files?.skipped?.length ?? 0,
  };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Lines naming each skipped file and why, for a dialog; long lists are cut with a count. */
export function describeSkipped(skipped = [], max = 15) {
  const lines = skipped.slice(0, max).map((s) => `${s.root}: ${s.path} (${s.reason})`);
  if (skipped.length > max) lines.push(`and ${skipped.length - max} more`);
  return lines;
}

/**
 * Where an import should put the shared folder by default: the backup's own setting,
 * resolved for this machine's home folder. A backup whose folder was off but that still
 * holds shared files is given the default folder, since the files need somewhere to go.
 */
export function planFilesImport(files, { home = os.homedir() } = {}) {
  const needsFolder = Boolean(files?.shared?.length || files?.rulesSources?.length);
  const suggested = expandHome(files?.sharedFolder || (needsFolder ? DEFAULT_SHARED_AI_FOLDER : ''), home) || null;
  return { needsFolder, suggested, summary: filesSummary(files) };
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
 * ticks with any unsafe name dropped.
 */
export function restoreFilesSection(files, { sharedRoot, skillsRoot = switchboardSkillsDir(), now = new Date() } = {}) {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const result = { created: [], replaced: [], same: [], aside: [], skipped: [], rulesSources: [], backupFolders: [] };
  const roots = [['shared', sharedRoot, files?.shared ?? []], ['skills', skillsRoot, files?.skills ?? []]];
  for (const [rootName, root, list] of roots) {
    for (const entry of list) {
      const target = safeTarget(root, entry.path);
      if (!target) {
        result.skipped.push({ root: rootName, path: String(entry.path), reason: root ? 'its path reaches outside its folder' : 'no folder to put it in' });
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
    const target = safeTarget(sharedRoot, rel);
    if (!target || escapesThroughLink(sharedRoot, target)) {
      result.skipped.push({ root: 'rules', path: String(rel), reason: 'its path reaches outside the shared folder' });
    } else if (fs.existsSync(target) && fs.statSync(target).isFile()) {
      result.rulesSources.push(target);
    } else {
      result.skipped.push({ root: 'rules', path: rel, reason: 'a listed rule file that is neither in the backup nor on this machine' });
    }
  }
  for (const name of files?.backupFolders ?? []) {
    if (isPlainFolderName(name)) {
      if (!result.backupFolders.some((n) => n.toLowerCase() === name.toLowerCase())) result.backupFolders.push(name);
    } else {
      result.skipped.push({ root: 'ticks', path: String(name), reason: 'not a plain folder name' });
    }
  }
  return result;
}

/** The shared folder setting to store after an import into `folder`. */
export function sharedSettingFor(folder, { home = os.homedir() } = {}) {
  return folder ? toSettingPath(folder, home) : '';
}
