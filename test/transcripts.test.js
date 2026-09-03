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
