import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Carrying a Claude session from one account to the next.
 *
 * When a run stops on a provider limit, the lane it was using is dropped and the command
 * starts again in the next one. Starting again used to mean starting from nothing: the
 * conversation lived in the spent account's config folder and the incoming account could
 * not see it, so a long piece of work lost everything it had established.
 *
 * It does not have to. Claude Code keeps each session as a JSONL transcript under
 * `<config folder>/projects/<slug of the working directory>/<session id>.jsonl`, and that
 * file is portable: dropped into another config folder it resumes there, appends the new
 * turns to its copy, and leaves the original alone. Verified across two real accounts
 * before this was written, including that the transcript carries no account,
 * organization or subscription identifier for a second account to reject.
 *
 * So the carry is a file copy and a `--resume`, with no summary, no model call and
 * nothing lost. Two things make it reliable rather than lucky:
 *
 *  - Switchboard names the session itself with `--session-id`, so it knows exactly which
 *    file to carry. Picking the most recently modified file instead would take the wrong
 *    conversation whenever two sessions share a working directory, which is normal on a
 *    machine running several agents.
 *  - Every step is allowed to fail. A missing transcript, a destination that already
 *    holds that session, an unreadable folder: each one falls back to the fresh start
 *    that used to be the only behaviour. A failover that continues is better than one
 *    that restarts, and a failover that restarts is far better than one that dies.
 *
 * Only Claude Code is handled here. Codex keeps its own sessions in a different layout
 * and has not been proven the same way, so it keeps the fresh start.
 */

/** Harnesses whose sessions this module knows how to carry. */
export const CARRYABLE_HARNESSES = ['claude'];

/**
 * The folder name Claude Code files a working directory's sessions under. Every
 * character that is not a letter or digit becomes a dash, and the drive letter's case is
 * preserved, so `C:\a\b` becomes `C--a-b`. Confirmed against real project folders rather
 * than assumed; a lowercase drive letter really does produce a different folder.
 */
export function projectSlug(cwd) {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

/** Where one account keeps one session's transcript. */
export function transcriptFile(accountHome, cwd, sessionId) {
  return path.join(accountHome, 'projects', projectSlug(cwd), `${sessionId}.jsonl`);
}

/** A fresh session id, in the uuid shape `--session-id` expects. */
export function newSessionId() {
  return crypto.randomUUID();
}

/**
 * Flags that mean the caller is steering the session themselves. Switchboard names the
 * session only when nobody else has: adding a second `--session-id` to a command line
 * that already has one would be an argument error, and overriding a `--resume` the
 * caller asked for would silently run a different conversation than the one they named.
 */
const SESSION_FLAGS = new Set(['--session-id', '--resume', '-r', '--continue', '-c', '--fork-session']);

export function callerManagesSession(args = []) {
  return args.some((a) => SESSION_FLAGS.has(a));
}

/**
 * The command line to launch with, with the session named so it can be found again.
 * Returns the arguments unchanged when the caller is steering the session themselves,
 * which is also the signal to skip the carry later: a session Switchboard did not name
 * is not one it can reliably find.
 */
export function withSessionId(args = [], sessionId) {
  if (callerManagesSession(args)) return [...args];
  return ['--session-id', sessionId, ...args];
}

/**
 * The command line for the lane taking over. The original arguments are kept and
 * `--resume` put in front of them, so a prompt is re-asked against the conversation that
 * is now present rather than against an empty one: the incoming agent sees how far the
 * outgoing one got and carries on. An interactive run has no arguments to keep and
 * simply reopens the session.
 */
export function resumeArgs(args = [], sessionId) {
  return ['--resume', sessionId, ...args];
}

/**
 * Copy one session's transcript from the spent account into the incoming one.
 *
 * Never overwrites: a destination that already holds this session is left exactly as it
 * is, because that file is the incoming account's own history and the copy would destroy
 * it. Never moves either, so the spent account keeps its record of what it did.
 *
 * Answers a plain outcome rather than throwing, since every failure here has the same
 * remedy (start fresh) and none of them should end the run.
 */
export function carryTranscript({ fromHome, toHome, cwd, sessionId, fsImpl = fs } = {}) {
  if (!fromHome || !toHome || !cwd || !sessionId) return { carried: false, reason: 'incomplete' };
  if (fromHome === toHome) return { carried: false, reason: 'same-account' };

  const source = transcriptFile(fromHome, cwd, sessionId);
  const target = transcriptFile(toHome, cwd, sessionId);

  try {
    if (!fsImpl.existsSync(source)) return { carried: false, reason: 'no-transcript' };
    if (fsImpl.existsSync(target)) return { carried: false, reason: 'already-there', target };
    fsImpl.mkdirSync(path.dirname(target), { recursive: true });
    // COPYFILE_EXCL makes the no-overwrite promise the filesystem's job rather than a
    // race between the check above and the write: another session in the same directory
    // could create the file in between.
    fsImpl.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
    return { carried: true, source, target };
  } catch (e) {
    // Includes the EEXIST that COPYFILE_EXCL raises when something won that race.
    return { carried: false, reason: e.code === 'EEXIST' ? 'already-there' : 'copy-failed', error: String(e.message || e) };
  }
}

/** Why a carry did not happen, in words a person reading the run output can act on. */
export function carryNote(reason) {
  switch (reason) {
    case 'no-transcript': return 'the spent lane left no transcript to carry, so this lane starts fresh';
    case 'already-there': return 'this lane already has that session, so it was left alone and this lane starts fresh';
    case 'copy-failed': return 'the transcript could not be copied, so this lane starts fresh';
    case 'caller-managed': return 'the session was named on your own command line, so it is yours to resume';
    case 'unsupported-harness': return 'only Claude sessions can be carried, so this lane starts fresh';
    case 'same-account': return 'both lanes use the same account folder, so there was nothing to carry';
    default: return 'this lane starts fresh';
  }
}
