import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CARRYABLE_HARNESSES,
  projectSlug,
  transcriptFile,
  newSessionId,
  callerManagesSession,
  withSessionId,
  resumeArgs,
  carryTranscript,
  carryNote,
  readSessionTurns,
  sessionDigest,
  findCodexSession,
  transcriptSupport,
} from '../core/transcripts.js';

/** A pair of account folders and a working directory, thrown away after each test. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-carry-'));
  return {
    root,
    fromHome: path.join(root, 'account-a'),
    toHome: path.join(root, 'account-b'),
    cwd: path.join(root, 'work'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function seedTranscript(home, cwd, sessionId, body = '{"type":"user"}\n') {
  const file = transcriptFile(home, cwd, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

test('projectSlug matches the folder name Claude Code actually uses', () => {
  // Checked against real project folders on a Windows machine: every character that is
  // not a letter or digit becomes a dash, and the drive letter keeps its case. Note the
  // double dash from the colon and backslash of the drive, which is the part that is
  // easy to get wrong by assuming rather than reading.
  assert.equal(projectSlug('C:\\projects\\my-app'), 'C--projects-my-app');
  assert.equal(projectSlug('C:\\a\\b\\c'), 'C--a-b-c');
});

test('projectSlug keeps drive-letter case, because a different case is a different folder', () => {
  assert.notEqual(projectSlug('C:\\work'), projectSlug('c:\\work'));
});

test('transcriptFile puts a session under projects/<slug>/<id>.jsonl', () => {
  const file = transcriptFile(path.join('C:', 'acct'), path.join('C:', 'work'), 'abc-123');
  assert.equal(path.basename(file), 'abc-123.jsonl');
  assert.equal(path.basename(path.dirname(path.dirname(file))), 'projects');
});

test('newSessionId produces the uuid shape --session-id expects', () => {
  assert.match(newSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.notEqual(newSessionId(), newSessionId());
});

test('callerManagesSession spots every flag that steers a session', () => {
  for (const flag of ['--session-id', '--resume', '-r', '--continue', '-c', '--fork-session']) {
    assert.equal(callerManagesSession(['-p', 'hello', flag]), true, flag);
  }
  assert.equal(callerManagesSession(['-p', 'hello']), false);
  assert.equal(callerManagesSession([]), false);
});

test('withSessionId names an unmanaged session and leaves the rest alone', () => {
  assert.deepEqual(withSessionId(['-p', 'hello'], 'sid-1'), ['--session-id', 'sid-1', '-p', 'hello']);
});

test('withSessionId refuses to add a second session flag to a managed command line', () => {
  const args = ['--resume', 'theirs', '-p', 'hello'];
  assert.deepEqual(withSessionId(args, 'sid-1'), args);
});

test('withSessionId copies rather than mutating the caller arguments', () => {
  const args = ['-p', 'hello'];
  withSessionId(args, 'sid-1');
  assert.deepEqual(args, ['-p', 'hello']);
});

test('resumeArgs re-asks the original prompt against the carried conversation', () => {
  assert.deepEqual(resumeArgs(['-p', 'do the thing'], 'sid-1'), ['--resume', 'sid-1', '-p', 'do the thing']);
});

test('resumeArgs on an interactive run just reopens the session', () => {
  assert.deepEqual(resumeArgs([], 'sid-1'), ['--resume', 'sid-1']);
});

test('carryTranscript copies the session into the incoming account', () => {
  const f = fixture();
  try {
    seedTranscript(f.fromHome, f.cwd, 'sid-1', '{"secret":"kept"}\n');
    const result = carryTranscript({ fromHome: f.fromHome, toHome: f.toHome, cwd: f.cwd, sessionId: 'sid-1' });

    assert.equal(result.carried, true);
    assert.equal(fs.readFileSync(transcriptFile(f.toHome, f.cwd, 'sid-1'), 'utf8'), '{"secret":"kept"}\n');
  } finally {
    f.cleanup();
  }
});

test('carryTranscript leaves the spent account its own copy', () => {
  const f = fixture();
  try {
    const source = seedTranscript(f.fromHome, f.cwd, 'sid-1');
    carryTranscript({ fromHome: f.fromHome, toHome: f.toHome, cwd: f.cwd, sessionId: 'sid-1' });

    assert.equal(fs.existsSync(source), true);
  } finally {
    f.cleanup();
  }
});

test('carryTranscript never overwrites a session the incoming account already has', () => {
  const f = fixture();
  try {
    seedTranscript(f.fromHome, f.cwd, 'sid-1', '{"from":"the spent account"}\n');
    const target = seedTranscript(f.toHome, f.cwd, 'sid-1', '{"from":"its own history"}\n');

    const result = carryTranscript({ fromHome: f.fromHome, toHome: f.toHome, cwd: f.cwd, sessionId: 'sid-1' });

    assert.equal(result.carried, false);
    assert.equal(result.reason, 'already-there');
    assert.equal(fs.readFileSync(target, 'utf8'), '{"from":"its own history"}\n');
  } finally {
    f.cleanup();
  }
});

test('carryTranscript reports a run that left no transcript instead of throwing', () => {
  const f = fixture();
  try {
    const result = carryTranscript({ fromHome: f.fromHome, toHome: f.toHome, cwd: f.cwd, sessionId: 'sid-1' });

    assert.equal(result.carried, false);
    assert.equal(result.reason, 'no-transcript');
  } finally {
    f.cleanup();
  }
});

test('carryTranscript has nothing to do when both lanes share an account folder', () => {
  const f = fixture();
  try {
    seedTranscript(f.fromHome, f.cwd, 'sid-1');
    const result = carryTranscript({ fromHome: f.fromHome, toHome: f.fromHome, cwd: f.cwd, sessionId: 'sid-1' });

    assert.equal(result.carried, false);
    assert.equal(result.reason, 'same-account');
  } finally {
    f.cleanup();
  }
});

test('carryTranscript reports incomplete input rather than guessing at a path', () => {
  assert.equal(carryTranscript({ fromHome: 'a', toHome: 'b', cwd: 'c' }).reason, 'incomplete');
  assert.equal(carryTranscript({}).reason, 'incomplete');
});

test('carryTranscript turns a filesystem failure into a fresh start, not a crash', () => {
  const f = fixture();
  try {
    seedTranscript(f.fromHome, f.cwd, 'sid-1');
    const fsImpl = {
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      copyFileSync: () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e; },
    };

    const result = carryTranscript({ fromHome: f.fromHome, toHome: f.toHome, cwd: f.cwd, sessionId: 'sid-1', fsImpl });

    assert.equal(result.carried, false);
    assert.equal(result.reason, 'copy-failed');
  } finally {
    f.cleanup();
  }
});

test('carryTranscript treats a lost race for the target as already-there', () => {
  const f = fixture();
  try {
    seedTranscript(f.fromHome, f.cwd, 'sid-1');
    const fsImpl = {
      existsSync: (p) => p === transcriptFile(f.fromHome, f.cwd, 'sid-1'),
      mkdirSync: fs.mkdirSync,
      copyFileSync: () => { const e = new Error('exists'); e.code = 'EEXIST'; throw e; },
    };

    const result = carryTranscript({ fromHome: f.fromHome, toHome: f.toHome, cwd: f.cwd, sessionId: 'sid-1', fsImpl });

    assert.equal(result.carried, false);
    assert.equal(result.reason, 'already-there');
  } finally {
    f.cleanup();
  }
});

test('every carry outcome has a note a person can act on', () => {
  for (const reason of ['no-transcript', 'already-there', 'copy-failed', 'caller-managed', 'unsupported-harness', 'same-account']) {
    assert.match(carryNote(reason), /\w/, reason);
  }
  assert.match(carryNote('something new'), /starts fresh/);
});

test('only Claude sessions are claimed as carryable', () => {
  assert.deepEqual(CARRYABLE_HARNESSES, ['claude']);
});

// ---- Reading a spent session so another vendor can be told what happened ----

/** One transcript line in the shape Claude Code writes. */
function turn(uuid, role, text, extra = {}) {
  return JSON.stringify({
    type: role, uuid, ...extra,
    message: { role, content: [{ type: 'text', text }] },
  });
}

function seedSession(home, cwd, sessionId, lines) {
  const file = transcriptFile(home, cwd, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('readSessionTurns keeps the text turns and drops the tool traffic', () => {
  const f = fixture();
  try {
    const file = seedSession(f.fromHome, f.cwd, 'sid-1', [
      turn('u1', 'user', 'make the tests pass'),
      JSON.stringify({ type: 'assistant', uuid: 'a0', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] } }),
      turn('a1', 'assistant', 'nine of sixteen pass now'),
      JSON.stringify({ type: 'system', uuid: 's1', message: { role: 'system', content: 'ignored' } }),
      'not json at all',
    ]);

    assert.deepEqual(readSessionTurns(file), [
      { role: 'user', text: 'make the tests pass' },
      { role: 'assistant', text: 'nine of sixteen pass now' },
    ]);
  } finally {
    f.cleanup();
  }
});

test('readSessionTurns does not report the same turn twice when the windows overlap', () => {
  const f = fixture();
  try {
    // A short file is inside both the head and the tail window.
    const file = seedSession(f.fromHome, f.cwd, 'sid-1', [turn('u1', 'user', 'one'), turn('a1', 'assistant', 'two')]);
    assert.equal(readSessionTurns(file).length, 2);
  } finally {
    f.cleanup();
  }
});

test('readSessionTurns keeps both ends of a transcript too long to read whole', () => {
  const f = fixture();
  try {
    const filler = Array.from({ length: 400 }, (_, i) => turn(`m${i}`, 'assistant', 'x'.repeat(400)));
    const file = seedSession(f.fromHome, f.cwd, 'sid-1', [
      turn('first', 'user', 'the original objective'),
      ...filler,
      turn('last', 'assistant', 'where the work actually stands'),
    ]);

    // Windows far smaller than the file, so the middle is what has to go.
    const turns = readSessionTurns(file, { headBytes: 2000, tailBytes: 2000 });
    assert.equal(turns[0].text, 'the original objective');
    assert.equal(turns.at(-1).text, 'where the work actually stands');
    assert.ok(turns.length < 402, 'the middle should have been dropped');
  } finally {
    f.cleanup();
  }
});

test('readSessionTurns survives a line the window cut in half', () => {
  const f = fixture();
  try {
    const file = seedSession(f.fromHome, f.cwd, 'sid-1', [
      turn('u1', 'user', 'objective'),
      turn('a1', 'assistant', 'y'.repeat(3000)),
      turn('a2', 'assistant', 'the last thing done'),
    ]);
    const turns = readSessionTurns(file, { headBytes: 500, tailBytes: 500 });
    assert.ok(turns.every((t) => typeof t.text === 'string' && t.text.length > 0));
    assert.equal(turns.at(-1).text, 'the last thing done');
  } finally {
    f.cleanup();
  }
});

test('sessionDigest carries the objective and what the session said it did', () => {
  const f = fixture();
  try {
    seedSession(f.fromHome, f.cwd, 'sid-1', [
      turn('u1', 'user', 'make every test pass'),
      turn('a1', 'assistant', 'I replaced the if-chain with a lookup table.'),
      turn('a2', 'assistant', 'Temperature will not fit it; it needs an offset.'),
    ]);

    const digest = sessionDigest({ home: f.fromHome, cwd: f.cwd, sessionId: 'sid-1' });

    assert.equal(digest.objective, 'make every test pass');
    assert.match(digest.state, /lookup table/);
    assert.match(digest.state, /needs an offset/);
    assert.equal(digest.truncated, false);
  } finally {
    f.cleanup();
  }
});

test('sessionDigest keeps the newest work when the budget will not hold it all', () => {
  const f = fixture();
  try {
    seedSession(f.fromHome, f.cwd, 'sid-1', [
      turn('u1', 'user', 'the objective'),
      turn('a1', 'assistant', 'the oldest step'),
      turn('a2', 'assistant', 'the newest step'),
    ]);

    const digest = sessionDigest({ home: f.fromHome, cwd: f.cwd, sessionId: 'sid-1', budget: 20 });

    assert.match(digest.state, /the newest step/);
    assert.doesNotMatch(digest.state, /the oldest step/);
    assert.equal(digest.truncated, true);
  } finally {
    f.cleanup();
  }
});

test('sessionDigest keeps the tail of a single turn bigger than the whole budget', () => {
  const f = fixture();
  try {
    seedSession(f.fromHome, f.cwd, 'sid-1', [
      turn('u1', 'user', 'the objective'),
      turn('a1', 'assistant', 'z'.repeat(500) + 'THE-ENDING'),
    ]);

    const digest = sessionDigest({ home: f.fromHome, cwd: f.cwd, sessionId: 'sid-1', budget: 40 });

    assert.match(digest.state, /THE-ENDING/, 'an over-long turn must not leave the state empty');
    assert.ok(digest.state.length <= 40);
  } finally {
    f.cleanup();
  }
});

test('sessionDigest says so rather than inventing an objective the transcript lacks', () => {
  const f = fixture();
  try {
    seedSession(f.fromHome, f.cwd, 'sid-1', [turn('a1', 'assistant', 'did a thing')]);
    const digest = sessionDigest({ home: f.fromHome, cwd: f.cwd, sessionId: 'sid-1' });
    assert.equal(digest.objective, 'Not recorded in the transcript.');
    assert.match(digest.state, /did a thing/);
  } finally {
    f.cleanup();
  }
});

test('sessionDigest is null when there is no session to read', () => {
  const f = fixture();
  try {
    assert.equal(sessionDigest({ home: f.fromHome, cwd: f.cwd, sessionId: 'nope' }), null);
    assert.equal(sessionDigest({ home: f.fromHome, cwd: f.cwd }), null);
    assert.equal(sessionDigest({}), null);
  } finally {
    f.cleanup();
  }
});

test('a digest of a real-sized conversation fits the handoff writer 4 KB cap', () => {
  const f = fixture();
  try {
    const many = Array.from({ length: 120 }, (_, i) => turn(`a${i}`, 'assistant', `step ${i}: ` + 'detail '.repeat(30)));
    seedSession(f.fromHome, f.cwd, 'sid-1', [turn('u1', 'user', 'a long job'), ...many]);

    const digest = sessionDigest({ home: f.fromHome, cwd: f.cwd, sessionId: 'sid-1' });

    // The writer caps the whole document, headings included, at 4096 bytes.
    assert.ok(Buffer.byteLength(digest.objective + digest.state) < 3000, 'digest must leave room for the other sections');
    assert.equal(digest.truncated, true);
  } finally {
    f.cleanup();
  }
});

// ---- Reading a spent Codex session, so a handoff works in that direction too ----

/** One Codex rollout line, in the shape its CLI writes. */
function codexTurn(id, role, text) {
  return JSON.stringify({
    timestamp: new Date().toISOString(), ordinal: 1, type: 'response_item',
    payload: { type: 'message', id, role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
  });
}

function codexMeta(cwd, sessionId = 'sess-1') {
  return JSON.stringify({ timestamp: new Date().toISOString(), type: 'session_meta', payload: { session_id: sessionId, cwd } });
}

function seedCodexSession(home, cwd, { day = '2026/09/02', name = 'rollout-2026-09-02T12-00-00-abc.jsonl', lines } = {}) {
  const dir = path.join(home, 'sessions', ...day.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, [codexMeta(cwd), ...lines].join('\n') + '\n');
  return file;
}

test('a Codex rollout yields the same turns a Claude transcript does', () => {
  const f = fixture();
  try {
    const file = seedCodexSession(f.fromHome, f.cwd, {
      lines: [
        codexTurn('m1', 'user', 'finish the units module'),
        JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', content: [] } }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
        codexTurn('m2', 'assistant', 'I extended the lookup table.'),
      ],
    });

    assert.deepEqual(readSessionTurns(file, { harness: 'codex' }), [
      { role: 'user', text: 'finish the units module' },
      { role: 'assistant', text: 'I extended the lookup table.' },
    ]);
  } finally {
    f.cleanup();
  }
});

test('Codex developer messages are instruction, not conversation, so they are left out', () => {
  const f = fixture();
  try {
    const file = seedCodexSession(f.fromHome, f.cwd, {
      lines: [codexTurn('m1', 'developer', 'system instructions here'), codexTurn('m2', 'assistant', 'real work')],
    });

    assert.deepEqual(readSessionTurns(file, { harness: 'codex' }), [{ role: 'assistant', text: 'real work' }]);
  } finally {
    f.cleanup();
  }
});

test('findCodexSession recognises the run by the directory it recorded', () => {
  const f = fixture();
  try {
    const mine = seedCodexSession(f.fromHome, f.cwd, { name: 'rollout-2026-09-02T10-00-00-mine.jsonl', lines: [codexTurn('m1', 'assistant', 'mine')] });
    seedCodexSession(f.fromHome, path.join(f.root, 'somewhere-else'), { name: 'rollout-2026-09-02T11-00-00-other.jsonl', lines: [codexTurn('m1', 'assistant', 'other')] });

    assert.equal(findCodexSession({ home: f.fromHome, cwd: f.cwd }), mine);
  } finally {
    f.cleanup();
  }
});

test('findCodexSession ignores an earlier session in the same directory', () => {
  const f = fixture();
  try {
    const old = seedCodexSession(f.fromHome, f.cwd, { name: 'rollout-2026-09-02T09-00-00-old.jsonl', lines: [codexTurn('m1', 'assistant', 'yesterday')] });
    fs.utimesSync(old, new Date('2026-09-01'), new Date('2026-09-01'));

    // A run that started today must not be handed yesterday's conversation.
    assert.equal(findCodexSession({ home: f.fromHome, cwd: f.cwd, since: Date.now() - 60_000 }), null);
  } finally {
    f.cleanup();
  }
});

test('findCodexSession prefers the newest when a directory has several from this run', () => {
  const f = fixture();
  try {
    seedCodexSession(f.fromHome, f.cwd, { name: 'rollout-2026-09-02T10-00-00-older.jsonl', lines: [codexTurn('m1', 'assistant', 'older')] });
    const newer = seedCodexSession(f.fromHome, f.cwd, { name: 'rollout-2026-09-02T13-00-00-newer.jsonl', lines: [codexTurn('m1', 'assistant', 'newer')] });

    assert.equal(findCodexSession({ home: f.fromHome, cwd: f.cwd }), newer);
  } finally {
    f.cleanup();
  }
});

test('findCodexSession answers null rather than guessing when nothing matches', () => {
  const f = fixture();
  try {
    assert.equal(findCodexSession({ home: f.fromHome, cwd: f.cwd }), null);
    assert.equal(findCodexSession({ home: f.fromHome }), null);
    assert.equal(findCodexSession({}), null);
  } finally {
    f.cleanup();
  }
});

test('sessionDigest works from a Codex session without being told a session id', () => {
  const f = fixture();
  try {
    seedCodexSession(f.fromHome, f.cwd, {
      lines: [
        codexTurn('m1', 'user', 'make every test pass'),
        codexTurn('m2', 'assistant', 'Nine pass. Temperature needs an offset, not a multiplier.'),
      ],
    });

    const digest = sessionDigest({ harness: 'codex', home: f.fromHome, cwd: f.cwd });

    assert.equal(digest.objective, 'make every test pass');
    assert.match(digest.state, /needs an offset/);
  } finally {
    f.cleanup();
  }
});

test('a harness with no transcript support is refused rather than half-handled', () => {
  assert.equal(transcriptSupport('gemini'), null);
  assert.equal(sessionDigest({ harness: 'gemini', home: 'a', cwd: 'b', sessionId: 'c' }), null);
  assert.deepEqual(readSessionTurns('anything', { harness: 'gemini' }), []);
});

test('only a session proven portable is marked carryable', () => {
  assert.equal(transcriptSupport('claude').carryable, true);
  // Codex sessions have not been proven to resume from another account folder, and an
  // unproven yes here would silently lose a run's work.
  assert.equal(transcriptSupport('codex').carryable, false);
  assert.deepEqual(CARRYABLE_HARNESSES, ['claude']);
});
