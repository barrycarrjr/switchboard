import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountsFile, customizationsDir, customizationsFile, ensureDir, samePath, writeJsonAtomic } from './paths.js';
import { readUserEnv } from './env.js';
import { loadSettings } from './settings.js';
import { activeSharedFolder, listSharedSkillFolders } from './shared-folder.js';
import {
  customizationClients,
  isSkillDisabledFor,
  loadCustomizationsState,
  recordSkillClientChoice,
  setSkillClientState,
  targetSkillDirForHome,
  writeCustomizationFile,
} from './customizations.js';

/**
 * Skills from one source.
 *
 * A skill meant for every tool is a folder (a SKILL.md plus whatever files it uses),
 * and every tool and every account of a tool keeps its own skills folder. Copied by
 * hand, those copies drift the same way the rules files did. So skills kept once in
 * `<shared AI folder>/skills/<name>/` are copied into every tool's skills folder in
 * every account folder Switchboard knows about, the same way core/rules-sync.js builds
 * the rules files.
 *
 * Switchboard has to tell its own copies from a person's, because it removes its own
 * when the source goes and must never remove anything else. Every folder it writes
 * holds a small marker file naming the skill and the hash of what was written. A
 * same-name folder without one is a hand-kept copy: before the first replacement it is
 * moved into a folder beside the skills folder (never pruned), not deleted.
 *
 * Deliberate limits:
 * - No shared folder, or no `skills` folder in it, means the feature does nothing at
 *   all, including no removals: a folder on a drive that is briefly missing must not
 *   take every copied skill with it.
 * - A skills folder that is the shared one (or inside it, usually through a link) is
 *   skipped, as is a same-name entry that is a link to the source: writing there would
 *   write onto the source itself.
 * - A link in a tool's skills folder is never treated as a copy Switchboard made, so it
 *   is never removed and nothing is deleted through it.
 */

export const SKILL_MARKER = '.switchboard-skill.json';

/**
 * Where hand-kept and hand-edited copies go, beside the tool's skills folder rather
 * than inside it. Inside, a tool that loads every subfolder holding a SKILL.md would
 * load the set-aside copy as a second skill with the same name.
 */
export const KEPT_FOLDER_SUFFIX = '.before-switchboard-skills';

/**
 * Files Switchboard itself writes into a skill folder (the marker, the timestamped
 * backups, the set-aside copies, an interrupted atomic write). They are never copied out
 * of a source and never count towards a folder's hash, so a backup left in a copy does
 * not make it look edited.
 */
export function isSwitchboardFile(name) {
  return name === SKILL_MARKER || /\.bak-/.test(name) || /\.before-/.test(name) || /\.tmp-\d+-\d+$/.test(name);
}

function realOrSelf(p) {
  try { return fs.realpathSync.native(p); } catch { return path.resolve(p); }
}

/** Is `p` the folder `dir` or inside it, once links on either side are resolved? */
function sameOrInside(p, dir) {
  const rel = path.relative(realOrSelf(dir).toLowerCase(), realOrSelf(p).toLowerCase());
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; }
}

/** Every file in a skill folder, as sorted `/`-separated relative paths, Switchboard's own left out. */
function listSkillFiles(dir) {
  const out = [];
  const seen = new Set();
  const walk = (abs, rel) => {
    // A link back up the tree would otherwise walk forever.
    const real = realOrSelf(abs).toLowerCase();
    if (seen.has(real)) return;
    seen.add(real);
    let entries = [];
    try { entries = fs.readdirSync(abs); } catch { return; }
    for (const name of entries) {
      if (isSwitchboardFile(name)) continue;
      const childAbs = path.join(abs, name);
      const childRel = rel ? `${rel}/${name}` : name;
      let st;
      try { st = fs.statSync(childAbs); } catch { continue; }
      if (st.isDirectory()) walk(childAbs, childRel);
      else if (st.isFile()) out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort();
}

/** The files and one hash over their names and bytes, so two copies compare in one step. */
export function skillContent(dir) {
  const files = listSkillFiles(dir);
  const h = crypto.createHash('sha256');
  for (const rel of files) {
    h.update(`${rel}\0`);
    h.update(fs.readFileSync(path.join(dir, ...rel.split('/'))));
    h.update('\0');
  }
  return { files, hash: h.digest('hex') };
}

/** The marker in a folder Switchboard wrote; null for anything else, a link included. */
function readMarker(dir) {
  if (isLink(dir)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(dir, SKILL_MARKER), 'utf8'));
    return m?.managedBy === 'switchboard' && typeof m.hash === 'string' ? m : null;
  } catch {
    return null;
  }
}

function writeMarker(dir, name, hash) {
  writeJsonAtomic(path.join(dir, SKILL_MARKER), {
    managedBy: 'switchboard',
    skill: name,
    hash,
    note: 'Copied by Switchboard from the shared AI folder. Edit the skill there, not here: the next sync replaces this folder.',
  });
}

/** A free place beside the skills folder for a copy that has to make way. */
function keepPathFor(skillsDir, name) {
  const base = path.join(`${skillsDir}${KEPT_FOLDER_SUFFIX}`, name);
  if (!fs.existsSync(base) && !isLink(base)) return base;
  for (let i = 2; ; i += 1) {
    const p = `${base}-${i}`;
    if (!fs.existsSync(p) && !isLink(p)) return p;
  }
}

function currentSharedFolder(home) {
  return activeSharedFolder(loadSettings(), { home });
}

/** `<shared>/skills` when it exists; null otherwise. */
function sharedSkillsDirOf(sharedFolder) {
  if (!sharedFolder) return null;
  const dir = path.join(sharedFolder, 'skills');
  try { return fs.statSync(dir).isDirectory() ? dir : null; } catch { return null; }
}

/**
 * Work out, without writing anything, what a sync would do to every tool's skills
 * folder. One entry per skill folder touched, plus one per skills folder skipped whole.
 *
 * `skillNames` and `clientIds` narrow the run (switching one skill on or off for one
 * tool). A narrowed run never looks for copies whose source has gone, so it cannot
 * remove a skill it was not asked about.
 *
 * @returns {{ sharedFolder: string|null, skillsDir: string|null, off?: string, skills: object[], overridesCentral: string[], targets: object[] }}
 */
export function planSkillsSync(opts = {}) {
  const {
    home = os.homedir(),
    envReader = readUserEnv,
    accountsPath = accountsFile(),
    installedToolIds = null,
    clientIds = null,
    skillNames = null,
    cDir = customizationsDir(),
    cFile = customizationsFile(),
  } = opts;
  const sharedFolder = opts.sharedFolder !== undefined ? opts.sharedFolder : currentSharedFolder(home);
  const skillsDir = sharedSkillsDirOf(sharedFolder);
  const empty = { sharedFolder: sharedFolder ?? null, skillsDir, skills: [], overridesCentral: [], targets: [] };
  if (!sharedFolder) return { ...empty, off: 'no shared AI folder is set, or it does not exist' };
  if (!skillsDir) return { ...empty, off: `there is no skills folder in the shared AI folder (${sharedFolder})` };

  const skills = listSharedSkillFolders(skillsDir).map((s) => ({ ...s, ...skillContent(s.dir) }));
  const wanted = skillNames ? skills.filter((s) => skillNames.includes(s.name)) : skills;
  // Switchboard's own store can hold a skill of the same name (made in the tab, or kept
  // when one was switched off). The shared copy is the one written, and the run says so.
  const overridesCentral = skills
    .filter((s) => fs.existsSync(path.join(cDir, 'skills', s.name, 'SKILL.md')))
    .map((s) => s.name);
  const disabledSkills = loadCustomizationsState(cFile).disabledSkills;

  // Group by folder first: two tools can share one skills folder, and then a skill stays
  // in it unless every tool reading that folder has it switched off.
  const folders = [];
  const clients = customizationClients({ home, envReader, accountsPath, installedToolIds })
    .filter((c) => c.available && c.supportsSkills && (!clientIds || clientIds.includes(c.id)));
  for (const client of clients) {
    for (const h of client.homes) {
      if (!fs.existsSync(h)) continue;
      const dir = targetSkillDirForHome(client.id, h);
      let entry = folders.find((f) => samePath(f.dir, dir));
      if (!entry) {
        entry = { clientId: client.id, clientIds: [], home: h, dir };
        folders.push(entry);
      }
      if (!entry.clientIds.includes(client.id)) entry.clientIds.push(client.id);
    }
  }

  const targets = [];
  for (const f of folders) {
    const base = { clientId: f.clientId, clientIds: f.clientIds, home: f.home, skillsDir: f.dir };
    if (sameOrInside(f.dir, skillsDir)) {
      targets.push({ ...base, skill: null, path: f.dir, action: 'skip', reason: 'this skills folder is the shared skills folder (or a link into it), so it already has every skill' });
      continue;
    }
    const off = (name) => f.clientIds.every((id) => isSkillDisabledFor(disabledSkills, name, id));
    for (const s of wanted) {
      const dest = path.join(f.dir, s.name);
      const t = { ...base, skill: s.name, path: dest, source: s.dir };
      const present = fs.existsSync(dest) || isLink(dest);
      if (present && sameOrInside(dest, s.dir)) {
        targets.push({ ...t, action: 'skip', reason: 'already a link to the shared copy' });
        continue;
      }
      const marker = present ? readMarker(dest) : null;
      let isDir = false;
      try { isDir = fs.statSync(dest).isDirectory(); } catch { /* absent or a broken link */ }
      const current = present && isDir ? skillContent(dest) : null;
      if (off(s.name)) {
        if (!present) continue;
        if (!marker) {
          targets.push({ ...t, action: 'skip', reason: 'switched off for this tool, but this copy was not written by Switchboard, so it is left alone' });
          continue;
        }
        const edited = current?.hash !== marker.hash;
        targets.push({
          ...t,
          action: 'remove',
          reason: 'switched off for this tool',
          ...(edited ? { keepAs: keepPathFor(f.dir, s.name) } : {}),
        });
        continue;
      }
      if (!present) { targets.push({ ...t, action: 'create', hash: s.hash }); continue; }
      if (marker) {
        if (current?.hash === s.hash) {
          targets.push({ ...t, action: marker.hash === s.hash ? 'same' : 'write', hash: s.hash });
          continue;
        }
        // Edited in place since Switchboard wrote it: keep those edits before replacing.
        const edited = current?.hash !== marker.hash;
        targets.push({
          ...t,
          action: 'write',
          hash: s.hash,
          ...(edited ? { keepAs: keepPathFor(f.dir, s.name), reason: 'this copy was edited by hand; the edited copy is kept' } : {}),
        });
        continue;
      }
      if (current?.hash === s.hash) {
        // A hand copy identical to the source loses nothing by being taken over, and
        // moving it aside would only leave a duplicate behind.
        targets.push({ ...t, action: 'adopt', hash: s.hash, reason: 'an identical copy made by hand is taken over' });
        continue;
      }
      targets.push({
        ...t,
        action: 'write',
        hash: s.hash,
        keepAs: keepPathFor(f.dir, s.name),
        reason: 'a copy Switchboard did not write is kept beside the skills folder before it is replaced',
      });
    }

    // Copies whose skill has left the shared folder. Only on a full run.
    if (skillNames || clientIds) continue;
    let entries = [];
    try { entries = fs.readdirSync(f.dir); } catch { entries = []; }
    for (const name of entries) {
      // Compared without letter case: on Windows `Foo` and `foo` are one folder, and
      // the loop above has just written it.
      if (skills.some((s) => s.name.toLowerCase() === name.toLowerCase()) || isSwitchboardFile(name)) continue;
      const dest = path.join(f.dir, name);
      const marker = readMarker(dest);
      if (!marker) continue;
      let current = null;
      try { current = fs.statSync(dest).isDirectory() ? skillContent(dest) : null; } catch { current = null; }
      targets.push({
        ...base,
        skill: name,
        path: dest,
        action: 'remove',
        reason: 'no longer in the shared skills folder',
        ...(current?.hash !== marker.hash ? { keepAs: keepPathFor(f.dir, name) } : {}),
      });
    }
  }
  return { sharedFolder, skillsDir, skills, overridesCentral, targets };
}

function copySkillFiles(skill, dest) {
  ensureDir(dest);
  for (const rel of skill.files) {
    const to = path.join(dest, ...rel.split('/'));
    ensureDir(path.dirname(to));
    fs.copyFileSync(path.join(skill.dir, ...rel.split('/')), to);
  }
}

/**
 * Bring a copy Switchboard wrote, and nobody has edited since, in line with the source.
 * A changed file is replaced through writeCustomizationFile, which keeps a timestamped
 * backup beside it, and a file the source no longer has is renamed to a backup rather
 * than deleted, so nothing in a tool's folder is overwritten without a copy.
 */
function updateSkillFiles(skill, dest) {
  const current = listSkillFiles(dest);
  for (const rel of skill.files) {
    const from = path.join(skill.dir, ...rel.split('/'));
    const to = path.join(dest, ...rel.split('/'));
    const want = fs.readFileSync(from);
    let have = null;
    try { have = fs.readFileSync(to); } catch { have = null; }
    if (have && have.equals(want)) continue;
    writeCustomizationFile(to, want);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const rel of current) {
    if (skill.files.includes(rel)) continue;
    const p = path.join(dest, ...rel.split('/'));
    fs.renameSync(p, `${p}.bak-${stamp}`);
  }
}

function moveAside(from, to) {
  ensureDir(path.dirname(to));
  fs.renameSync(from, to);
}

/**
 * Bring every tool's skills folder in line with the shared skills. A copy already in
 * step is not touched, so running this often costs a few small reads. A folder that
 * cannot be written is reported and does not stop the others.
 */
export function syncSkills(opts = {}) {
  const { dryRun = false } = opts;
  const plan = planSkillsSync(opts);
  const byName = new Map(plan.skills.map((s) => [s.name, s]));
  const targets = plan.targets.map((t) => {
    if (dryRun || t.action === 'same' || t.action === 'skip') return t;
    try {
      const skill = byName.get(t.skill);
      if (t.action === 'remove') {
        if (t.keepAs) moveAside(t.path, t.keepAs);
        else fs.rmSync(t.path, { recursive: true, force: true });
      } else if (t.action === 'adopt') {
        writeMarker(t.path, skill.name, skill.hash);
      } else if (t.action === 'create') {
        copySkillFiles(skill, t.path);
        writeMarker(t.path, skill.name, skill.hash);
      } else if (t.action === 'write') {
        if (t.keepAs) {
          moveAside(t.path, t.keepAs);
          copySkillFiles(skill, t.path);
        } else {
          updateSkillFiles(skill, t.path);
        }
        writeMarker(t.path, skill.name, skill.hash);
      }
      return t;
    } catch (e) {
      return { ...t, action: 'failed', reason: e.message };
    }
  });
  return {
    dryRun,
    sharedFolder: plan.sharedFolder,
    skillsDir: plan.skillsDir,
    ...(plan.off ? { off: plan.off } : {}),
    skills: plan.skills.map((s) => s.name),
    overridesCentral: plan.overridesCentral,
    targets,
  };
}

/**
 * Switch one skill on or off for one tool. A skill kept in the shared folder is handled
 * here: the choice is remembered, then that skill alone is synced for that tool, so the
 * copy appears or goes with the marker that lets the next sync recognise it. Any other
 * skill goes through setSkillClientState as before. The tray and the CLI both call this.
 */
export function setSkillState(name, clientId, enabled, opts = {}) {
  const home = opts.home ?? os.homedir();
  const sharedFolder = opts.sharedFolder !== undefined ? opts.sharedFolder : currentSharedFolder(home);
  const sharedSkillsDir = sharedSkillsDirOf(sharedFolder);
  const shared = listSharedSkillFolders(sharedSkillsDir).find((s) => s.name === name);
  if (!shared) return setSkillClientState(name, clientId, enabled, { ...opts, sharedSkillsDir });
  const clients = customizationClients({
    home,
    envReader: opts.envReader ?? readUserEnv,
    accountsPath: opts.accountsPath ?? accountsFile(),
    installedToolIds: opts.installedToolIds ?? null,
  });
  if (!clients.some((c) => c.id === clientId)) throw new Error(`unknown client: ${clientId}`);
  recordSkillClientChoice(name, clientId, enabled, opts.cFile ?? customizationsFile());
  const res = syncSkills({ ...opts, home, sharedFolder, skillNames: [name], clientIds: [clientId] });
  const failed = res.targets.filter((t) => t.action === 'failed');
  if (failed.length) throw new Error(`could not update ${failed.map((t) => `${t.path} (${t.reason})`).join(', ')}`);
  return {
    ok: true,
    skill: name,
    client: clientId,
    enabled: Boolean(enabled),
    shared: true,
    paths: res.targets.filter((t) => t.action !== 'same' && t.action !== 'skip').map((t) => t.path),
  };
}

/**
 * Call `onChange` shortly after anything in the shared skills folder changes. The whole
 * tree is watched, since a skill is a folder of files; where recursive watching is not
 * supported only the top level is, and the caller's slow timer covers the rest. A
 * burst of events from one save is folded into a single call. Returns `{ close() }`.
 */
export function createSkillsWatcher({ dir, onChange, debounceMs = 1500, watch = fs.watch } = {}) {
  let timer = null;
  const fire = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; onChange(); }, debounceMs);
  };
  let watcher = null;
  if (dir) {
    try {
      watcher = watch(dir, { recursive: true }, fire);
    } catch {
      try { watcher = watch(dir, fire); } catch { /* cannot be watched; the timer covers it */ }
    }
  }
  return {
    close() {
      if (timer) clearTimeout(timer);
      try { watcher?.close(); } catch { /* already closed */ }
    },
  };
}

export const __testing = { sameOrInside, readMarker, keepPathFor, sharedSkillsDirOf };
