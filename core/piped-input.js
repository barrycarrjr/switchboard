// What a caller piped into `switchboard run`, kept so every lane the run lands on gets it.
//
// An automated caller hands its prompt over on standard input, because a prompt on a
// command line can be long, can contain anything, and on Windows may pass through a batch
// shim that re-reads it as commands. The child used to simply inherit that input. That
// works for one lane and quietly breaks every fallback: the first tool reads the pipe to
// its end, so the tool on the next lane inherits a pipe with nothing left in it and starts
// with no question at all. Claude then refuses to run ("Input must be provided either
// through stdin or as a prompt argument"), and the rescue the whole pool exists for fails
// on exactly the run that needed it.
//
// So the input is recorded as it arrives and replayed to a lane the run falls back to. It
// is forwarded while it is still arriving, never awaited: a caller that keeps its pipe open
// must not hang a run that would have worked.

/** Past this much input, recording stops and later lanes behave as they did before. */
export const MAX_RECORDED_BYTES = 8 * 1024 * 1024;

/**
 * Start recording a readable stream.
 *
 * @param {NodeJS.ReadableStream} source  the caller's standard input
 * @param {{ maxBytes?: number }} [options]
 */
export function recordPipedInput(source, { maxBytes = MAX_RECORDED_BYTES } = {}) {
  const chunks = [];
  const live = new Set();
  let bytes = 0;
  let ended = false;
  let overflowed = false;
  let listening = false;
  let attached = 0;

  const drop = (sink) => {
    if (!live.delete(sink)) return;
    // A reader that has gone can no longer be what the input is waiting on.
    source.resume?.();
  };

  const closeAll = () => {
    for (const sink of live) {
      try { sink.end(); } catch { /* the child has already gone */ }
    }
    live.clear();
  };

  const onData = (chunk) => {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (!overflowed) {
      if (bytes + data.length > maxBytes) {
        // Too much to keep for a second lane. What has been recorded is dropped as well,
        // because replaying the first part of a prompt would be worse than replaying none.
        // The lane running now is unaffected: it is handed every chunk below regardless.
        overflowed = true;
        chunks.length = 0;
      } else {
        chunks.push(data);
        bytes += data.length;
      }
    }
    for (const sink of live) {
      let room = true;
      try { room = sink.write(data); } catch { room = true; }
      // Input that fits the recording is read to its end whether or not the tool is
      // reading: it is being held here for a second lane anyway, and a tool that ignores
      // its input (one that takes its prompt on the command line) must not leave the
      // recording half made when the run falls back. Past the cap nothing is kept, so from
      // there a tool that is slow to read, or never reads, slows the caller down exactly as
      // an inherited pipe did, instead of the rest piling up in this process.
      if (overflowed && room === false) {
        source.pause?.();
        sink.once?.('drain', () => source.resume?.());
      }
    }
  };

  // Listening to a pipe keeps a process alive for as long as the other end stays open.
  // When the child simply inherited the input that was never this process's concern, so a
  // caller that leaves its pipe open must not start holding a finished run open now. With
  // this, the running child is what keeps the process alive, and once the last one exits
  // the process ends whether or not the caller ever closed its end.
  source.unref?.();

  return {
    /**
     * Whether a later lane can be given the whole input again: all of it arrived, there
     * was some, and it fitted.
     */
    replayable() {
      return ended && !overflowed && bytes > 0;
    },

    /**
     * Whether a sentence may be added after the input. Only after a complete prompt in
     * plain words. Input that is still arriving would get it in the middle, and input that
     * is a stream of JSON messages (a caller driving a tool's structured input format)
     * would be corrupted by a bare sentence, so both are left exactly as they were sent.
     */
    acceptsNote() {
      if (!this.replayable()) return false;
      return !/^\s*[{[]/.test(chunks[0]?.toString('utf8', 0, 64) ?? '');
    },

    /**
     * Connect one child's standard input.
     *
     * The first child is the input's own reader: reading only starts here, so nothing can
     * arrive, let alone be discarded, before there is somebody to hand it to. A later child
     * (a lane the run fell back to) is given the recording, and only when it is complete:
     * a one-shot prompt is worth repeating, while a caller feeding turns down a pipe it
     * keeps open would have every earlier turn run a second time. That child is still
     * handed whatever arrives from now on, which is what it inherited before.
     *
     * `note` is written after a complete prompt (see acceptsNote). It is how a tool taking
     * over part-way is pointed at the handoff without touching its command line: a trailing
     * argument is swallowed by Claude's list-valued flags and rejected outright by Codex
     * and Antigravity, so the command line was never a safe place for it.
     *
     * @param {NodeJS.WritableStream|null|undefined} sink  the child's standard input
     * @param {string|null} [note]
     */
    attach(sink, note = null) {
      if (!sink) return;
      // A child that exits before reading its input makes every later write an EPIPE.
      // That is the child's business, reported through its exit code, not a crash here.
      sink.on?.('error', () => drop(sink));
      sink.on?.('close', () => drop(sink));
      attached += 1;

      if (attached > 1 && ended && !overflowed) {
        for (const chunk of chunks) sink.write(chunk);
        if (note && this.acceptsNote()) sink.write(`\n\n${note}\n`);
      }
      if (ended) {
        sink.end();
        return;
      }
      live.add(sink);
      if (!listening) {
        listening = true;
        source.on('data', onData);
        source.on('end', () => { ended = true; closeAll(); });
        source.on('error', () => { ended = true; closeAll(); });
      }
      source.resume?.();
    },
  };
}
