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

  const objective = turns.find((t) => t.role === 'user')?.text ?? null;
  const said = turns.filter((t) => t.role === 'assistant').map((t) => t.text);
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
    objective: objective ?? 'Not recorded in the transcript.',
    state: kept.join('\n\n'),
    turns: turns.length,
    truncated: kept.length < said.length,
  };
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
