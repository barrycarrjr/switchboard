import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from './handoff.js';

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
 *  - Every step is allowed to fail. A missing transcript, a destination holding a
 *    different conversation under that id, an unreadable folder: each one falls back to
 *    the fresh start that used to be the only behavior. A failover that continues is better than one
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
  // `--resume=<id>` and `--session-id=<id>` are the same flags in their other spelling.
  return args.some((a) => SESSION_FLAGS.has(String(a).split('=')[0]));
}

/**
 * The session a command line names outright, with `--session-id <id>` or `--resume <id>`,
 * or null when it names none.
 *
 * A caller that builds its own command line names its own sessions, so Switchboard does
 * not name one, and the id is read from the command line instead. That is enough both to
 * write a handoff from the session and to carry it to the next account (sessionToCarry).
 * `--continue` and a bare `--resume` name nothing, so they give null.
 */
export function namedSession(args = []) {
  for (let i = 0; i < args.length; i += 1) {
    const joined = /^(--session-id|--resume)=(.*)$/.exec(String(args[i]));
    if (joined && UUID_SHAPE.test(joined[2])) return joined[2];
    if (args[i] !== '--session-id' && args[i] !== '--resume' && args[i] !== '-r') continue;
    const id = String(args[i + 1] ?? '');
    if (UUID_SHAPE.test(id)) return id;
  }
  return null;
}

/**
 * The session a run on this command line can be carried on with, or null.
 *
 * Whoever named it, Switchboard or the caller, the conversation is the same file, and
 * following the work to the next account is what makes the pool feel like one account.
 * Two forms name nothing usable: `--continue` picks whatever was newest in the folder,
 * and `--fork-session` writes a NEW session whose id is not on the command line, so the
 * id that is there belongs to a conversation this run did not add to.
 */
export function sessionToCarry(args = []) {
  if (args.some((a) => a === '--fork-session' || a === '--continue' || a === '-c')) return null;
  return namedSession(args);
}

/**
 * The session a command line asks to resume (`--resume <id>`, `-r <id>`, `--resume=<id>`),
 * or null. A fork counts: it has to read the conversation it forks from.
 */
export function resumedSession(args = []) {
  for (let i = 0; i < args.length; i += 1) {
    const joined = /^--resume=(.*)$/.exec(String(args[i]));
    if (joined && UUID_SHAPE.test(joined[1])) return joined[1];
    if ((args[i] === '--resume' || args[i] === '-r') && UUID_SHAPE.test(String(args[i + 1] ?? ''))) return args[i + 1];
  }
  return null;
}

/**
 * The same command line with any session it names taken out, so `--resume` can be put in
 * front without the session being named twice.
 */
export function withoutNamedSession(args = []) {
  const kept = [];
  for (let i = 0; i < args.length; i += 1) {
    const joined = /^(--session-id|--resume)=(.*)$/.exec(String(args[i]));
    if (joined && UUID_SHAPE.test(joined[2])) continue;
    const flag = args[i] === '--session-id' || args[i] === '--resume' || args[i] === '-r';
    if (flag && UUID_SHAPE.test(String(args[i + 1] ?? ''))) {
      i += 1;
      continue;
    }
    kept.push(args[i]);
  }
  return kept;
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f-]{27}$/i;

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
  return ['--resume', sessionId, ...withoutNamedSession(args)];
}

/**
 * How one copy of a transcript stands against another: 'behind' when `olderFile` holds
 * exactly the first part of `newerFile` and `newerFile` has more, 'same' when the two are
 * identical, and 'different' otherwise (or when either cannot be read).
 *
 * A Claude transcript only ever grows at the end, so an account holding a shorter copy
 * that matches byte for byte is simply behind: the conversation went on in another
 * account. Replacing that copy loses nothing. A copy that differs anywhere is a
 * conversation of its own and is never touched. Compared in chunks, because a transcript
 * can run to hundreds of megabytes.
 */
export function compareCopies(olderFile, newerFile, fsImpl = fs) {
  let a;
  let b;
  try {
    const olderSize = fsImpl.statSync(olderFile).size;
    const newerSize = fsImpl.statSync(newerFile).size;
    if (olderSize > newerSize) return 'different';
    a = fsImpl.openSync(olderFile, 'r');
    b = fsImpl.openSync(newerFile, 'r');
    const size = 1024 * 1024;
    const bufA = Buffer.alloc(size);
    const bufB = Buffer.alloc(size);
    for (let at = 0; at < olderSize; at += size) {
      const want = Math.min(size, olderSize - at);
      const gotA = fsImpl.readSync(a, bufA, 0, want, at);
      const gotB = fsImpl.readSync(b, bufB, 0, want, at);
      if (gotA !== want || gotB !== want || !bufA.subarray(0, want).equals(bufB.subarray(0, want))) return 'different';
    }
    return olderSize === newerSize ? 'same' : 'behind';
  } catch {
    return 'different';
  } finally {
    for (const fd of [a, b]) if (fd !== undefined) try { fsImpl.closeSync(fd); } catch { /* already gone */ }
  }
}

/** Whether `olderFile` is an older copy of the same conversation as `newerFile`. */
export function isOlderCopy(olderFile, newerFile, fsImpl = fs) {
  return compareCopies(olderFile, newerFile, fsImpl) === 'behind';
}

/** Replace an older copy with the newer one, through a temporary file so a reader never
 * sees half a transcript. */
function refreshCopy(source, target, fsImpl) {
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fsImpl.copyFileSync(source, temp);
    fsImpl.renameSync(temp, target);
  } catch (e) {
    // Never leave a half-made copy in the account's projects folder.
    try { fsImpl.rmSync?.(temp, { force: true }); } catch { /* already gone */ }
    throw e;
  }
}

/**
 * Copy one session's transcript from the spent account into the incoming one.
 *
 * Never destroys anything. A destination that already holds this session keeps it, unless
 * its copy is an older one of the very same conversation (see isOlderCopy), which is the
 * normal case once work has moved between two accounts and back: that copy is brought up
 * to date, because resuming it would silently drop everything done since. Never moves
 * either, so the spent account keeps its record of what it did.
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
    if (fsImpl.existsSync(target)) {
      const standing = compareCopies(target, source, fsImpl);
      // An identical copy is already the conversation: nothing to copy, and it resumes.
      if (standing === 'same') return { carried: true, alreadyCurrent: true, source, target };
      if (standing !== 'behind') return { carried: false, reason: 'already-there', target };
      refreshCopy(source, target, fsImpl);
      return { carried: true, refreshed: true, source, target };
    }
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

/**
 * Before an account resumes a session, make sure it holds the newest copy there is.
 *
 * A caller that keeps a conversation going over many requests (a chat bot answering a
 * thread, say) asks for `--resume <id>` each time, and each request can land on a
 * different account: the pool picks whichever has room. The conversation lives in the
 * account folder it last ran in, so the account picked next either has no copy at all
 * ("No conversation found") or an older one, and quietly continues from an earlier
 * point. This looks across every other registered Claude folder for the same session in
 * the same working directory and brings the newest copy over when the account about to
 * run has none, or has an older copy of the same conversation (isOlderCopy). A copy that
 * differs is a conversation of its own and is never replaced.
 *
 * Answers what happened and never throws: a run that cannot be synced is no worse off
 * than it was before this existed.
 */
export function syncSessionInto({ toHome, otherHomes = [], cwd, sessionId, fsImpl = fs } = {}) {
  if (!toHome || !cwd || !sessionId) return { synced: false, reason: 'incomplete' };
  const target = transcriptFile(toHome, cwd, sessionId);
  try {
    const hasTarget = fsImpl.existsSync(target);
    const candidates = [];
    for (const home of otherHomes) {
      if (!home || path.resolve(home).toLowerCase() === path.resolve(toHome).toLowerCase()) continue;
      const file = transcriptFile(home, cwd, sessionId);
      if (!fsImpl.existsSync(file)) continue;
      if (hasTarget && !isOlderCopy(target, file, fsImpl)) continue;
      const stat = fsImpl.statSync(file);
      candidates.push({ file, home, size: stat.size, mtimeMs: stat.mtimeMs });
    }
    if (!candidates.length) return { synced: false, reason: hasTarget ? 'up-to-date' : 'nowhere' };
    // The longest is the furthest along; where two are the same length, the newest.
    candidates.sort((x, y) => (y.size - x.size) || (y.mtimeMs - x.mtimeMs));
    const best = candidates[0];
    if (hasTarget) {
      refreshCopy(best.file, target, fsImpl);
    } else {
      fsImpl.mkdirSync(path.dirname(target), { recursive: true });
      fsImpl.copyFileSync(best.file, target, fs.constants.COPYFILE_EXCL);
    }
    return { synced: true, from: best.home, refreshed: hasTarget };
  } catch (e) {
    return { synced: false, reason: 'copy-failed', error: String(e.message || e) };
  }
}

/**
 * Reading a spent session so a DIFFERENT tool can be told what happened.
 *
 * Carrying the session file only works between two Claude accounts; a Claude transcript
 * means nothing to Codex. What crosses a vendor boundary is a written handoff, and the
 * material for one is already in the transcript, because an agent narrates its own work
 * as it goes. Pulling out just the text turns gives the objective it was set and the
 * account it kept of what it did, decisions included. In the run this was proven on, a
 * 400 KB transcript reduced to under 900 bytes that still carried both the structure the
 * first agent had chosen and its warning about the part that would not fit that
 * structure, and the receiving agent acted on both.
 *
 * So no summarising model is involved. This is extraction, which cannot invent a decision
 * that was never made, and costs nothing.
 */

/** Head and tail windows. A transcript can run to hundreds of megabytes, so neither the
 * whole file nor an unbounded slice of it is ever held in memory. The head is where the
 * objective is; the tail is where the current state is. */
export const DIGEST_HEAD_BYTES = 64 * 1024;
export const DIGEST_TAIL_BYTES = 256 * 1024;

/** Read a byte window from a file, dropping whichever edge line the window cut in half. */
function windowLines(file, bytes, from, fsImpl = fs) {
  let fd;
  try {
    const size = fsImpl.statSync(file).size;
    const length = Math.min(size, bytes);
    const start = from === 'tail' ? size - length : 0;
    const buffer = Buffer.alloc(length);
    fd = fsImpl.openSync(file, 'r');
    fsImpl.readSync(fd, buffer, 0, length, start);
    const lines = buffer.toString('utf8').split(/\r?\n/);
    if (length < size) {
      // Only the cut edge is unreliable: the tail's first line and the head's last one.
      if (from === 'tail') lines.shift(); else lines.pop();
    }
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { fsImpl.closeSync(fd); } catch { /* already gone */ }
  }
}

/** The text of one message, ignoring tool payloads and thinking blocks. Vendors disagree
 * on the block type name, so the caller says which ones carry prose. */
function messageText(content, textTypes) {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content.filter((b) => textTypes.includes(b?.type)).map((b) => b.text ?? '').join('\n').trim();
}

/**
 * How each vendor records a session, so a handoff can be written from any of them.
 *
 * `locate` answers which file holds the run that just ended, and the two vendors need
 * different answers. Claude Code takes `--session-id`, so Switchboard names the session
 * and the path is exact. Codex has no such flag, so its session has to be recognised
 * afterwards: newest first, matching the working directory it recorded, and modified
 * during the run. That is a narrower test than "newest file" but still a recognition
 * rather than a certainty, which is why a miss falls back to starting fresh.
 *
 * `turn` answers what one line of the file means, or null if it is not conversation.
 *
 * `carryable` is whether the session FILE can simply be moved to another account and
 * resumed, which skips the handoff entirely. Proven for Claude across two real accounts.
 * Not proven for Codex, and an unproven yes here would silently lose someone's work.
 */
export const TRANSCRIPTS = {
  claude: {
    carryable: true,
    locate: ({ home, cwd, sessionId }) => (home && cwd && sessionId ? transcriptFile(home, cwd, sessionId) : null),
    turn: (record) => {
      if (record?.type !== 'user' && record?.type !== 'assistant') return null;
      if (record?.isApiErrorMessage || record?.error === 'server_error' || record?.error === 'overloaded_error') return null;
      const text = messageText(record.message?.content, ['text']);
      return text ? { role: record.message.role, text, key: record.uuid } : null;
    },
  },
  codex: {
    carryable: false,
    locate: ({ home, cwd, since, fsImpl = fs }) => findCodexSession({ home, cwd, since, fsImpl }),
    turn: (record) => {
      if (record?.type !== 'response_item' || record?.payload?.type !== 'message') return null;
      const role = record.payload.role;
      // 'developer' is instruction Codex injects for itself, not the conversation.
      if (role !== 'user' && role !== 'assistant') return null;
      const text = messageText(record.payload.content, ['input_text', 'output_text', 'text']);
      // Codex files the context it injects for itself (the working folder, the project's
      // instructions file) as user messages too. Read as the first request, that block
      // became a handoff's objective instead of the task. Seen in real Codex sessions.
      // The instructions block comes as "# AGENTS.md instructions for <folder>" for a
      // project's file and as plain "# AGENTS.md instructions" for the global one.
      if (role === 'user' && /^(?:<(?:environment_context|user_instructions)>|# AGENTS\.md instructions\b)/.test(text)) return null;
      return text ? { role, text, key: record.payload.id ?? `${record.timestamp}:${record.ordinal}` } : null;
    },
  },
};

export function transcriptSupport(harness) {
  return TRANSCRIPTS[harness] ?? null;
}

/** How many recent Codex session files to consider before giving up on recognising one. */
export const CODEX_SESSIONS_SCANNED = 12;

/**
 * The Codex session for a run in this directory. Codex files sessions under
 * sessions/YYYY/MM/DD, so walking that structure newest-first keeps the scan to a handful
 * of files however long the account has been in use. Each candidate's first record is a
 * session_meta carrying the working directory and the session id, so recognition reads one
 * line per file rather than opening whole transcripts.
 */
export function findCodexSession({ home, cwd, since = 0, fsImpl = fs, limit = CODEX_SESSIONS_SCANNED } = {}) {
  if (!home || !cwd) return null;
  const want = path.resolve(cwd).toLowerCase();
  const root = path.join(home, 'sessions');
  const found = [];

  const descend = (dir, depth) => {
    if (found.length >= limit) return;
    let entries;
    try {
      entries = fsImpl.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (depth === 3) {
      const files = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name).sort().reverse();
      for (const name of files) {
        if (found.length >= limit) return;
        found.push(path.join(dir, name));
      }
      return;
    }
    for (const name of entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()) {
      descend(path.join(dir, name), depth + 1);
    }
  };
  descend(root, 0);

  for (const file of found) {
    try {
      // The run must have touched it, or it belongs to some earlier piece of work in the
      // same directory. Without this, a failover would hand over a stale conversation,
      // which is worse than handing over nothing.
      if (since && fsImpl.statSync(file).mtimeMs < since) continue;
      const first = windowLines(file, 64 * 1024, 'head', fsImpl).find((l) => l.includes('"session_meta"'));
      if (!first) continue;
      const meta = JSON.parse(first);
      if (meta?.payload?.cwd && path.resolve(meta.payload.cwd).toLowerCase() === want) return file;
    } catch { /* unreadable or torn: try the next one */ }
  }
  return null;
}

/**
 * The readable turns of one session, oldest first. Head and tail windows are read
 * separately and joined, so a long conversation keeps both the task it started from and
 * what it had most recently done, and the middle is what gets dropped rather than either
 * end. Turns are deduplicated by uuid, since a short file's two windows overlap.
 */
export function readSessionTurns(file, { harness = 'claude', headBytes = DIGEST_HEAD_BYTES, tailBytes = DIGEST_TAIL_BYTES, fsImpl = fs } = {}) {
  const support = transcriptSupport(harness);
  if (!support) return [];
  const seen = new Set();
  const turns = [];
  for (const line of [...windowLines(file, headBytes, 'head', fsImpl), ...windowLines(file, tailBytes, 'tail', fsImpl)]) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue; // a torn or oversized line is skipped, never guessed at
    }
    const turn = support.turn(record);
    if (!turn) continue;
    const key = turn.key ?? line;
    if (seen.has(key)) continue;
    seen.add(key);
    turns.push({ role: turn.role, text: turn.text });
  }
  return turns;
}

/** How much of the handoff document the state section may fill. The writer caps the whole
 * document at 4 KB; this leaves room for the other sections and the headings. */
export const DIGEST_STATE_BUDGET = 2400;

/**
 * The objective a session was set and the account it kept of its work, ready to be handed
 * to `writeHandoff`. Null when there is nothing worth handing over, which the caller
 * treats exactly as it treats a missing handoff today.
 *
 * The state is filled from the most recent turns backwards. A session that ran long has
 * more to say than a 4 KB document can hold, and the newest turns are the ones describing
 * where the work actually stands; dropping from the front keeps the document useful
 * rather than truncating it mid-sentence at an arbitrary point.
 */
export function sessionDigest({ harness = 'claude', home, cwd, sessionId, since = 0, budget = DIGEST_STATE_BUDGET, fsImpl = fs } = {}) {
  const support = transcriptSupport(harness);
  if (!support) return null;
  const file = support.locate({ home, cwd, sessionId, since, fsImpl });
  if (!file) return null;
  const turns = readSessionTurns(file, { harness, fsImpl });
  if (!turns.length) return null;

  // Redacted here, before the state budget cuts anything: a cut inside a key leaves a
  // piece the patterns may no longer recognize, and this text goes to another vendor.
  const objective = turns.find((t) => t.role === 'user')?.text ?? null;
  const said = turns.filter((t) => t.role === 'assistant').map((t) => redactSecrets(t.text));
  if (!objective && !said.length) return null;

  const kept = [];
  let used = 0;
  for (let i = said.length - 1; i >= 0; i--) {
    const cost = said[i].length + 2;
    if (used + cost > budget) break;
    kept.unshift(said[i]);
    used += cost;
  }
  // A single turn longer than the whole budget would otherwise leave the state empty,
  // which loses the very thing the handoff exists to carry. Keep its tail instead.
  if (!kept.length && said.length) kept.push(said[said.length - 1].slice(-budget));

  return {
    objective: objective == null ? 'Not recorded in the transcript.' : redactSecrets(objective),
    state: kept.join('\n\n'),
    turns: turns.length,
    truncated: kept.length < said.length,
  };
}

/** Why a carry did not happen, in words a person reading the run output can act on. */
export function carryNote(reason) {
  switch (reason) {
    case 'no-transcript': return 'the spent lane left no transcript to carry, so this lane starts fresh';
    case 'already-there': return 'this lane already holds a different conversation under that session id, so it was left alone and not resumed from the spent lane';
    case 'copy-failed': return 'the transcript could not be copied, so this lane starts fresh';
    case 'caller-managed': return 'the session was named on your own command line, so it is yours to resume';
    case 'unsupported-harness': return 'only Claude sessions can be carried, so this lane starts fresh';
    case 'same-account': return 'both lanes use the same account folder, so there was nothing to carry';
    default: return 'this lane starts fresh';
  }
}
