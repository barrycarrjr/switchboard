import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dataDir, ensureDir, writeJsonAtomic } from './paths.js';
import { expandHome } from './shared-folder.js';

/**
 * Rule file history.
 *
 * Since 0.34.0 a rule source is not one tool's file any more: one save reaches every
 * tool on every account within seconds (the tray watches the sources), and many agent
 * sessions edit those files. So one bad edit, a half-finished rewrite or an agent
 * deleting the wrong section, is everywhere at once, and the generated copies cannot
 * help because they are rebuilt from the bad text. Every time a source's text changes,
 * a dated copy is kept here, so any earlier version can be put back.
 *
 * Copies live in `%APPDATA%\Switchboard\rules-history`, one folder per source file,
 * newest 20 kept. A version is named by the time it was saved, which is also its id.
 */

export const HISTORY_KEPT = 20;

const VERSION_RX = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

export function rulesHistoryDir() {
  return path.join(dataDir(), 'rules-history');
}

/**
 * One folder per source: its file name (so a person browsing can tell them apart) and a
 * short hash of its full path (so two `global.md` files in different folders never share
 * a history). Case is folded first because Windows treats paths that way.
 */
function folderFor(src, dir) {
  const full = path.resolve(src);
  const hash = crypto.createHash('sha256').update(full.toLowerCase()).digest('hex').slice(0, 12);
  const name = path.basename(full).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80) || 'rules';
  return path.join(dir, `${name}-${hash}`);
}

function versionName(now) {
  return now.toISOString().replace(/[:.]/g, '-');
}

/** Saved versions of one source, newest first, as stored file names without extension. */
function versionIds(folder) {
  let names = [];
  try { names = fs.readdirSync(folder); } catch { return []; }
  return names
    .filter((n) => n.endsWith('.txt') && VERSION_RX.test(n.slice(0, -4)))
    .map((n) => n.slice(0, -4))
    .sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}

function versionDate(id) {
  const m = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

function prune(folder, keep) {
  for (const id of versionIds(folder).slice(keep)) {
    try { fs.unlinkSync(path.join(folder, `${id}.txt`)); } catch { /* gone already */ }
  }
}

/**
 * Keep a copy of the source's current text, unless it equals the newest copy already
 * kept. The first time a source is seen it is always kept, so there is something to go
 * back to before the first change. Returns the new version id, or null.
 */
export function recordRuleVersion(src, { dir = rulesHistoryDir(), now = new Date(), keep = HISTORY_KEPT } = {}) {
  const text = fs.readFileSync(src, 'utf8');
  const folder = folderFor(src, dir);
  const [newest] = versionIds(folder);
  if (newest) {
    try {
      if (fs.readFileSync(path.join(folder, `${newest}.txt`), 'utf8') === text) return null;
    } catch { /* unreadable: keep a fresh copy */ }
  }
  ensureDir(folder);
  // Written once so a person browsing the folder can tell which file it holds.
  const about = path.join(folder, 'source.json');
  if (!fs.existsSync(about)) writeJsonAtomic(about, { source: path.resolve(src) });
  // Two saves within one millisecond, or a clock that stepped back, must neither collide
  // with nor sort below a copy already kept, so the time is nudged past the newest.
  let at = now.getTime();
  const newestAt = newest ? Date.parse(versionDate(newest)) : NaN;
  if (Number.isFinite(newestAt) && at <= newestAt) at = newestAt + 1;
  let id = versionName(new Date(at));
  while (fs.existsSync(path.join(folder, `${id}.txt`))) id = versionName(new Date(++at));
  fs.writeFileSync(path.join(folder, `${id}.txt`), text, 'utf8');
  prune(folder, keep);
  return id;
}

/**
 * Record every readable source. History must never stop a sync, so a source that
 * cannot be read here is left for the sync itself to report.
 */
export function recordRulesHistory(sources, opts = {}) {
  const saved = [];
  for (const src of sources ?? []) {
    try {
      const id = recordRuleVersion(src, opts);
      if (id) saved.push({ source: src, version: id });
    } catch { /* the sync names an unreadable source */ }
  }
  return saved;
}

function resolveSource(file, home) {
  if (!String(file ?? '').trim()) throw new Error('name a rule file');
  return expandHome(file, home);
}

/** Saved versions of one rule file, newest first: `{ version, at, size }`. */
export function listRuleVersions(file, { dir = rulesHistoryDir(), home = os.homedir() } = {}) {
  const folder = folderFor(resolveSource(file, home), dir);
  return versionIds(folder).map((version) => {
    let size = null;
    try { size = fs.statSync(path.join(folder, `${version}.txt`)).size; } catch { /* listed, unreadable */ }
    return { version, at: versionDate(version), size };
  });
}

/**
 * Find a version by id, or by its place in the list (1 is the newest), which is what a
 * person reading `switchboard rules history` will naturally type.
 */
function pickVersion(file, version, opts) {
  const list = listRuleVersions(file, opts);
  const v = String(version ?? '').trim();
  const byIndex = /^\d{1,3}$/.test(v) ? list[Number(v) - 1] : null;
  const hit = byIndex ?? list.find((x) => x.version === v);
  if (!hit) throw new Error(`no saved version ${v || '(none given)'} of ${file}; list them with: switchboard rules history <file>`);
  return hit.version;
}

/** The text of one saved version. */
export function readRuleVersion(file, version, opts = {}) {
  const { dir = rulesHistoryDir(), home = os.homedir() } = opts;
  const id = pickVersion(file, version, { dir, home });
  return fs.readFileSync(path.join(folderFor(resolveSource(file, home), dir), `${id}.txt`), 'utf8');
}

/**
 * Put a saved version back. The current text is kept in the history first, so a
 * restore can itself be undone. The write goes to the file a link points at, through a
 * temporary file and a rename, so a crash cannot leave half a rule file behind and a
 * linked source stays a link. The caller runs a rules sync afterwards.
 */
export function restoreRuleVersion(file, version, opts = {}) {
  const { dir = rulesHistoryDir(), home = os.homedir(), now = new Date(), keep = HISTORY_KEPT } = opts;
  const src = resolveSource(file, home);
  const id = pickVersion(src, version, { dir, home });
  const text = fs.readFileSync(path.join(folderFor(src, dir), `${id}.txt`), 'utf8');
  if (fs.existsSync(src)) recordRuleVersion(src, { dir, now, keep });
  let target = src;
  try { target = fs.realpathSync.native(src); } catch { /* a missing source is written where it was */ }
  ensureDir(path.dirname(target));
  const tmp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  return { source: src, version: id, size: Buffer.byteLength(text, 'utf8') };
}

export const __testing = { folderFor, VERSION_RX };
