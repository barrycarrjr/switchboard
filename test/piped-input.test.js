import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { recordPipedInput } from '../core/piped-input.js';

/** Collect everything written to a sink, and whether it was ended. */
function sink() {
  const stream = new PassThrough();
  const state = { text: '', ended: false };
  stream.on('data', (d) => { state.text += d.toString(); });
  stream.on('end', () => { state.ended = true; });
  return { stream, state };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('the second lane is given the prompt the first lane already read', async () => {
  const source = new PassThrough();
  const input = recordPipedInput(source);

  const first = sink();
  input.attach(first.stream);
  source.end('the whole prompt');
  await settle();
  assert.equal(first.state.text, 'the whole prompt');
  assert.equal(first.state.ended, true, 'the first tool is told the prompt is complete');

  // The pipe is now empty, which is where an inherited stdin left the next tool.
  const second = sink();
  input.attach(second.stream);
  await settle();
  assert.equal(second.state.text, 'the whole prompt');
  assert.equal(second.state.ended, true);
});

test('a prompt still arriving is passed on as it comes, never waited for', async () => {
  const source = new PassThrough();
  const input = recordPipedInput(source);

  const child = sink();
  input.attach(child.stream);
  source.write('part one, ');
  await settle();
  assert.equal(child.state.text, 'part one, ', 'what has arrived is there at once');
  assert.equal(child.state.ended, false, 'and the child is not told it is over');

  source.end('part two');
  await settle();
  assert.equal(child.state.text, 'part one, part two');
  assert.equal(child.state.ended, true);
});

test('nothing is read, so nothing can be lost, before there is a tool to hand it to', async () => {
  // Reading used to start the moment recording did, a little before the first tool was
  // launched. Input bigger than the recording limit that arrived in that gap was thrown
  // away, and the tool started with an empty prompt and a clean exit.
  const source = new PassThrough();
  const input = recordPipedInput(source, { maxBytes: 8 });
  source.end('far more than eight bytes of prompt');
  await settle();

  const first = sink();
  input.attach(first.stream);
  await settle();
  assert.equal(first.state.text, 'far more than eight bytes of prompt', 'the lane running gets all of it');
  assert.equal(first.state.ended, true);
  assert.equal(input.replayable(), false, 'and it is simply too big to give to a second lane');
});

test('input too large to keep is never half replayed to a second lane', async () => {
  const source = new PassThrough();
  const input = recordPipedInput(source, { maxBytes: 8 });
  const first = sink();
  input.attach(first.stream);
  source.write('12345');
  source.end('67890');
  await settle();
  assert.equal(first.state.text, '1234567890');

  const second = sink();
  input.attach(second.stream, 'Read handoff.md and continue.');
  await settle();
  assert.equal(second.state.text, '', 'the first five bytes of a prompt are worse than none');
  assert.equal(second.state.ended, true);
});

test('the pointer to a handoff follows a complete prompt', async () => {
  const source = new PassThrough();
  const input = recordPipedInput(source);
  input.attach(sink().stream);
  source.end('fix the login bug');
  await settle();

  const child = sink();
  input.attach(child.stream, 'Read handoff.md and continue.');
  await settle();
  assert.equal(child.state.text, 'fix the login bug\n\nRead handoff.md and continue.\n');
});

test('a bare sentence is never added to input that is a stream of JSON messages', async () => {
  // A caller driving a tool's structured input format sends one JSON message per line.
  const source = new PassThrough();
  const input = recordPipedInput(source);
  input.attach(sink().stream);
  source.end('{"type":"user","message":{"role":"user","content":"hello"}}\n');
  await settle();

  assert.equal(input.replayable(), true);
  assert.equal(input.acceptsNote(), false);
  const child = sink();
  input.attach(child.stream, 'Read handoff.md and continue.');
  await settle();
  assert.equal(child.state.text, '{"type":"user","message":{"role":"user","content":"hello"}}\n', 'replayed exactly as sent');
});

test('a caller feeding turns down a pipe it keeps open does not have the earlier turns run twice', async () => {
  const source = new PassThrough();
  const input = recordPipedInput(source);
  const first = sink();
  input.attach(first.stream);
  source.write('turn one\n');
  await settle();
  first.stream.destroy(); // that lane ran out
  await settle();

  assert.equal(input.replayable(), false, 'the input has not ended, so it is not a one-shot prompt');
  const second = sink();
  input.attach(second.stream, 'Read handoff.md and continue.');
  source.write('turn two\n');
  await settle();
  assert.equal(second.state.text, 'turn two\n', 'only what arrives from now on, which is what it used to inherit');
});

test('a caller that piped nothing has nothing to replay, so the pointer goes elsewhere', async () => {
  const source = new PassThrough();
  const input = recordPipedInput(source);
  const first = sink();
  input.attach(first.stream);
  source.end();
  await settle();
  assert.equal(first.state.ended, true, 'the child still sees an ended input, as it would have');

  assert.equal(input.replayable(), false, 'the run falls back to the command line for the pointer');
  assert.equal(input.acceptsNote(), false);
  const child = sink();
  input.attach(child.stream, 'Read handoff.md and continue.');
  await settle();
  assert.equal(child.state.text, '');
  assert.equal(child.state.ended, true);
});

test('a tool that ignores its input does not leave the recording half made', async () => {
  // One that takes its prompt on the command line never reads standard input at all. The
  // recording still has to finish, or the lane the run falls back to gets the tail of a
  // prompt whose beginning is stuck in the first tool's pipe.
  const source = new PassThrough();
  const input = recordPipedInput(source);
  const deaf = new Writable({ highWaterMark: 4, write() { /* never calls back: never reads */ } });
  input.attach(deaf);
  source.end('a prompt much longer than four bytes');
  await settle();
  await settle();

  assert.equal(input.replayable(), true);
  const second = sink();
  input.attach(second.stream);
  await settle();
  assert.equal(second.state.text, 'a prompt much longer than four bytes');
});

test('a tool that stops reading slows the caller down once the input is past recording', async () => {
  // Nothing is kept past the limit, so from there the rest must not pile up in this
  // process either: the caller is held back exactly as an inherited pipe held it.
  const source = new PassThrough();
  const input = recordPipedInput(source, { maxBytes: 4 });
  let release = null;
  const slow = new Writable({ highWaterMark: 4, write(chunk, enc, done) { release = done; } });
  input.attach(slow);
  source.write('0123456789');
  await settle();
  assert.equal(source.isPaused(), true, 'the caller is made to wait for the tool');

  release();
  await settle();
  assert.equal(source.isPaused(), false, 'and let go again once the tool has caught up');
});

test('a tool that exits without reading its input does not bring the run down', async () => {
  // Its standard input errors on the next write. Left unhandled, an error event on a
  // stream is an uncaught exception, which would end the run this exists to rescue.
  const source = new PassThrough();
  const input = recordPipedInput(source);
  const gone = new Writable({ write(chunk, enc, done) { done(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })); } });
  assert.equal(gone.listenerCount('error'), 0);
  input.attach(gone);
  assert.ok(gone.listenerCount('error') > 0, 'the error is taken, not left to become an uncaught exception');

  source.write('prompt for nobody');
  await settle();
  await settle();

  // The run carries on: the input still finishes recording and a second lane still gets it.
  source.end(' and the rest');
  await settle();
  const second = sink();
  input.attach(second.stream);
  await settle();
  assert.equal(second.state.text, 'prompt for nobody and the rest');
});

test('a lane with no standard input is simply skipped', () => {
  const input = recordPipedInput(new PassThrough());
  assert.doesNotThrow(() => input.attach(null));
  assert.doesNotThrow(() => input.attach(undefined, 'note'));
});

test('recording never holds the process open on its own', () => {
  // Listening to a pipe keeps a process alive for as long as the other end is open. A
  // caller that never closes its pipe must not keep a finished run from ending.
  let unrefs = 0;
  const source = new PassThrough();
  source.unref = () => { unrefs += 1; };
  recordPipedInput(source);
  assert.equal(unrefs, 1);
});
