import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './paths.js';

const MAX_HANDOFF_SIZE = 4096; // 4 KB target

// Built from pieces so the source-tree scan (test/generic.test.js) does not read these
// patterns as credentials. The prefix plus a run of key characters is enough: the length
// floors are kept low so a key that was cut short somewhere upstream is still caught.
const REDACT_PATTERNS = [
  new RegExp('sk' + '-ant-[a-z]+[0-9]*-[a-zA-Z0-9_-]{20,}', 'g'), // Anthropic: API keys, setup and OAuth tokens
  new RegExp('ya29' + '\\.[a-zA-Z0-9_-]+', 'g'),                    // Google OAuth Token
  new RegExp('AIza' + '[0-9A-Za-z_-]{30,}', 'g'),                   // Google API key
  new RegExp('gh[pousr]_[a-zA-Z0-9]{20,}', 'g'),                    // GitHub Token
  new RegExp('github' + '_pat_[a-zA-Z0-9_]{20,}', 'g'),             // GitHub fine-grained token
  new RegExp('sk' + '-(?:proj|svcacct|admin)-[a-zA-Z0-9_-]{20,}', 'g'), // OpenAI project and service keys
  new RegExp('sk' + '-[a-zA-Z0-9]{32,}', 'g'),                      // OpenAI API Key
];

/**
 * The text with every recognized key shape replaced. Exported so a transcript can be
 * redacted before anything cuts it: a cut inside a key leaves a piece the patterns may
 * no longer recognize.
 */
export function redactSecrets(text) {
  return redact(text);
}

function redact(text) {
  if (!text) return '';
  let safe = text;
  for (const pattern of REDACT_PATTERNS) {
    safe = safe.replace(pattern, '***REDACTED***');
  }
  return safe;
}

export function getHandoffPath(workspaceDir) {
  const normalized = path.resolve(workspaceDir).toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const dir = path.join(dataDir(), 'handoffs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${hash}.md`);
}

/**
 * The same handoff, trimmed until the document fits the size limit.
 *
 * A derived handoff's objective is the first thing the session was ever asked, and for an
 * automated caller that is often a long prompt on its own. Refusing the whole document over
 * that left the next lane with no handoff at all, which is the one outcome worse than a
 * shortened one. So the objective keeps its opening, where a request says what it wants,
 * and the state keeps its end, where the most recent work is, and each gives up text in
 * turn until the document fits. Anything that still does not fit is left to the writer to
 * refuse.
 */
export function fitHandoff(data = {}) {
  const marker = ' [...]';
  const fits = (d) => Buffer.byteLength(formatHandoff(d), 'utf8') <= MAX_HANDOFF_SIZE;
  // Redacted BEFORE anything is cut. A cut that lands inside a key leaves a shorter key
  // the patterns no longer recognize, and most of a key is as good as all of it.
  let fitted = { ...data };
  for (const field of ['objective', 'state']) {
    if (fitted[field] != null) fitted[field] = redact(String(fitted[field]));
  }
  if (fits(fitted)) return { data: fitted, trimmed: false };
  const floor = 200;
  for (let round = 0; round < 60 && !fits(fitted); round += 1) {
    const objective = String(fitted.objective ?? '');
    const state = String(fitted.state ?? '');
    const over = Buffer.byteLength(formatHandoff(fitted), 'utf8') - MAX_HANDOFF_SIZE;
    // Take from whichever section is longer, at least the overflow and never past the floor.
    if (objective.length >= state.length && objective.length > floor) {
      const keep = Math.max(floor, objective.length - Math.max(over + marker.length, Math.ceil(objective.length / 8)));
      fitted = { ...fitted, objective: objective.replace(/ \[\.\.\.\]$/, '').slice(0, keep) + marker };
    } else if (state.length > floor) {
      const keep = Math.max(floor, state.length - Math.max(over + marker.length, Math.ceil(state.length / 8)));
      fitted = { ...fitted, state: marker.trim() + ' ' + state.replace(/^\[\.\.\.\] /, '').slice(-keep) };
    } else {
      break;
    }
  }
  return { data: fitted, trimmed: true };
}

export function writeHandoff(workspaceDir, data) {
  const filePath = getHandoffPath(workspaceDir);
  const content = formatHandoff(data);
  
  if (Buffer.byteLength(content, 'utf8') > MAX_HANDOFF_SIZE) {
    throw new Error('Handoff document exceeds 4 KB size limit');
  }

  // Atomic write via temp file
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
  
  return filePath;
}

export function readHandoff(workspaceDir) {
  const filePath = getHandoffPath(workspaceDir);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

/** Remove the workspace's handoff. Missing is fine: the point is that it is gone. */
export function removeHandoff(workspaceDir) {
  try {
    fs.rmSync(getHandoffPath(workspaceDir), { force: true });
  } catch {
    // Left behind at worst, and the next run recognises one it did not write.
  }
}

// The line that marks a handoff Switchboard derived by itself, as opposed to one a person
// or their agent wrote on purpose. See handoffOrigin.
const DERIVED_BY = 'Written by: Switchboard, from the session that ran out';

/**
 * Who wrote a handoff, read from its text.
 *
 * There is one handoff per workspace, and two very different things get filed there. One
 * a person wrote on purpose describes work they mean to be continued, so it is left alone
 * and always wins. One Switchboard derived from a session that ran out describes THAT run
 * and nothing else. Nothing told the two apart, and nothing ever removed either, so the
 * first handoff ever derived in a folder stayed for good: every later run that changed
 * tool there was pointed at it, however unrelated, and no newer one was ever written,
 * because "one already exists". A bot that runs every request in one repository folder
 * would have been told to continue Monday's task on every request from Tuesday on.
 *
 * `runId` names the run a derived handoff belongs to, so a run can tell its own from one
 * left behind by a run that was killed before it could tidy up.
 *
 * @param {string|null|undefined} content
 * @returns {{ derived: boolean, runId: string|null }}
 */
export function handoffOrigin(content) {
  const text = String(content ?? '');
  const match = /^Written by: Switchboard, from the session that ran out(?: \(run ([\w-]+)\))?\s*$/m.exec(text);
  if (match) return { derived: true, runId: match[1] ?? null };
  // One derived before the line above existed carries no mark, and there are such files on
  // disk. It does end with the one sentence only the derived kind was ever given, so that
  // is what gives it away. A person's own words are not going to repeat it exactly.
  return { derived: text.includes(DERIVED_NEXT_ACTIONS), runId: null };
}

/** What every derived handoff tells the next tool to do. Also how an unmarked one is known. */
export const DERIVED_NEXT_ACTIONS = 'Pick up from the state above and finish the objective. Do not redo work that is already done.';

export function formatHandoff(data = {}) {
  const section = (title, content) => {
    const safeContent = redact(String(content || 'None provided').trim());
    return `${title}:\n${safeContent}\n`;
  };

  return [
    '# Task handoff\n',
    // Only on a handoff Switchboard derived. One written by hand has no such line, which
    // is exactly what marks it as somebody's own.
    ...(data.derivedByRun ? [`${DERIVED_BY} (run ${String(data.derivedByRun).replace(/[^\w-]/g, '')})\n`] : []),
    section('Objective', data.objective),
    section('Constraints', data.constraints),
    section('Decisions made', data.decisions),
    section('Current repository state', data.state),
    section('Next actions', data.nextActions),
    section('Verification already run', data.verification),
    section('Blockers or risks', data.blockers)
  ].join('\n').trim() + '\n';
}

/**
 * The handoff a run derives from a spent session, built on this run's own earlier one.
 *
 * `earlier` is what this run last derived ({ objective, state, before, sessionId }), kept in
 * memory by the run itself rather than read back out of the file, where a request or a
 * note that happens to contain a section heading would cut it short. `before` is the part
 * of that state recorded ahead of its own session's work.
 *
 * A lane that started from that earlier handoff had the pointer to it as its first
 * message, not the task, so its own digest has no objective worth keeping, and replacing
 * the handoff with it would point the next tool at a file that says "read this file". The
 * earlier handoff holds the real objective, and the work it records came first. So the
 * objective is kept and this lane's work is added after the earlier state; fitHandoff then
 * trims the oldest state first if the whole no longer fits.
 *
 * One case is not a new lane's work at all: the spent session is the very conversation the
 * earlier handoff was written from, carried on in another account. Its digest already
 * holds everything that session did and more, so it replaces that session's part, and only
 * that part: whatever was recorded before it (other lanes, other tools) is kept.
 *
 * Answers the handoff's fields plus `before`, for the run to keep as the next `earlier`.
 */
export function derivedHandoffData({ earlier = null, runId, objective, state, sessionId = null, harness }) {
  const sameConversation = Boolean(earlier && sessionId && earlier.sessionId === sessionId);
  const before = sameConversation ? (earlier.before ?? '') : (earlier?.state ?? '');
  return {
    derivedByRun: runId,
    objective: earlier?.objective ?? objective,
    state: before ? `${before}\n\nThen, in the next lane (${harness}):\n${state}` : state,
    nextActions: DERIVED_NEXT_ACTIONS,
    before,
  };
}

export function generateHandoffPrompt(workspaceDir) {
  const filePath = getHandoffPath(workspaceDir);
  return `Read ${filePath} and continue from its Next actions section.`;
}

/**
 * The same pointer for a tool that has ALSO been given the caller's original request,
 * which is the case whenever that request was piped in and replayed.
 *
 * It cannot be the sentence above. There the handoff is all the new tool has, so it is told
 * to carry on from it. Here the request is already in front of it, in full, and the handoff
 * is only the first tool's account of how far it got. Its "objective" is the first thing
 * that session was ever asked, which for a conversation several requests long is not what
 * is being asked now. Told to continue from that, a tool would set about the wrong task. So
 * the request stays in charge and the handoff is offered as what it is: notes.
 */
export function generateHandoffNote(workspaceDir) {
  const filePath = getHandoffPath(workspaceDir);
  return `Another tool was working on the request above and ran out part-way. Its notes on how far it got are in ${filePath}. Read them so that nothing already done is done twice, then complete the request above. Where the notes and the request disagree, the request is what counts.`;
}
