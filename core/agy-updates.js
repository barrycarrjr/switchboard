// Antigravity's CLI updates itself, and that is what puts a command window on screen.
//
// Every time `agy` starts it decides whether to look for a newer version of itself. When
// it decides yes it starts a second copy of itself with `--bg-updater`, and it gives that
// copy a console of its own, so Windows draws a command window for about a second. The
// parent cannot prevent it. Measured on 2026-09-22: five spawns out of five produced a
// visible window when `agy` was started the way Switchboard starts it, and five out of
// five still did when it was started inside an already hidden console.
//
// What the CLI does respect is its own note of when it last looked. While that note is
// recent it starts no updater at all, and no window appears: zero out of five runs. So
// Switchboard keeps the note current and takes the job over itself. `agy update` does the
// same work, reports what it found, and opens no window, so nothing is lost by making the
// CLI stop doing it in the background.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** How often Switchboard runs the update the CLI is no longer running for itself. */
export const AGY_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The CLI's own note of when it last looked for a new version. */
export function agyStampPath(home = os.homedir()) {
  return path.join(home, '.gemini', 'antigravity-cli', 'last_check.timestamp');
}

/**
 * Tell the CLI that a check has just happened, so it does not start one of its own.
 *
 * The file is empty and only its modified time is read, which is why this writes nothing
 * into it. Nothing is created unless the CLI's own folder is already there: a machine
 * where Antigravity has never run gets no invented state, it just checks once and makes
 * the folder itself.
 *
 * Never throws. A failure here means one command window, not a broken quota reading, and
 * every caller is on a path whose real job is something else.
 *
 * @returns {boolean} true when the note now says "just checked"
 */
export function markAgyCheckDone(stamp = agyStampPath(), now = Date.now()) {
  try {
    if (!fs.existsSync(path.dirname(stamp))) return false;
    if (!fs.existsSync(stamp)) fs.writeFileSync(stamp, '');
    const at = new Date(now);
    fs.utimesSync(stamp, at, at);
    return true;
  } catch {
    return false;
  }
}

/**
 * What `agy update` said, read strictly.
 *
 * Only the vendor's own "already on the latest version" sentence is accepted as proof
 * that there is nothing to install. Anything else leaves `alreadyLatest` null, because an
 * unrecognised message is not evidence of being up to date, and the Providers tab would
 * rather say it does not know.
 */
export function parseAgyUpdate(stdout) {
  const text = String(stdout ?? '');
  const version = text.match(/current version\s+(\d+[\w.]*)/i)?.[1] ?? null;
  if (/already on the latest version/i.test(text)) {
    return { alreadyLatest: true, version, message: 'already on the latest version' };
  }
  const updated = text.match(/updated to\s+v?(\d+[\w.]*)/i);
  if (updated) {
    return { alreadyLatest: true, version: updated[1], message: `updated to ${updated[1]}` };
  }
  return { alreadyLatest: null, version, message: text.trim().slice(0, 200) || null };
}

/** Run the vendor's own update command. Quiet: it opens no window of its own. */
export async function runAgyUpdate({ bin, runImpl = run, timeout = 120000, stamp = agyStampPath() } = {}) {
  if (!bin) return { ok: false, alreadyLatest: null, version: null, message: 'agy not found' };
  markAgyCheckDone(stamp);
  try {
    const { stdout } = await runImpl(bin, ['update'], { windowsHide: true, timeout });
    return { ok: true, ...parseAgyUpdate(stdout) };
  } catch (e) {
    return { ok: false, alreadyLatest: null, version: null, message: String(e?.message ?? e).slice(0, 200) };
  }
}

/** Whether enough time has passed since Switchboard last ran the update itself. */
export function agyUpdateIsDue(state, now = Date.now(), interval = AGY_UPDATE_INTERVAL_MS) {
  const at = Number(state?.at ?? 0);
  if (!Number.isFinite(at) || at <= 0) return true;
  if (at > now) return true; // a clock that moved backwards should not freeze updates forever
  return now - at >= interval;
}

/**
 * Do the update the CLI is no longer doing for itself, at most once per interval.
 *
 * Returns the state to store, or null when nothing was due, so the caller decides when to
 * write settings rather than this reaching for them.
 */
export async function maybeUpdateAgy({
  bin,
  state = null,
  now = Date.now(),
  interval = AGY_UPDATE_INTERVAL_MS,
  runImpl = run,
  stamp = agyStampPath(),
} = {}) {
  if (!bin) return null;
  if (!agyUpdateIsDue(state, now, interval)) return null;
  const result = await runAgyUpdate({ bin, runImpl, stamp });
  return { at: now, alreadyLatest: result.alreadyLatest, version: result.version, message: result.message };
}

/**
 * What the Providers tab may claim about Antigravity.
 *
 * The vendor has no command that reports an available update without installing it, so
 * the only honest answer is the outcome of the last update Switchboard ran, and only
 * while it is recent enough to still mean something.
 */
export function agyUpdateClaim(state, now = Date.now(), maxAge = 2 * AGY_UPDATE_INTERVAL_MS) {
  if (!state || state.alreadyLatest !== true) return { updateAvailable: null, latest: null };
  const at = Number(state.at ?? 0);
  if (!Number.isFinite(at) || at <= 0 || now - at > maxAge) return { updateAvailable: null, latest: null };
  return { updateAvailable: false, latest: null };
}
