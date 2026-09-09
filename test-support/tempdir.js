// Throwaway directories for tests, that actually go away.
//
// Nearly every suite here needs scratch space: a fake CLAUDE_CONFIG_DIR, a
// settings file to read back, a folder to look for a binary in. They were all
// made with a bare mkdtempSync and none of them were ever removed, so this
// machine had 43,513 `sb-*` directories in %TEMP%, about 1,900 a day over 23
// days (found 2026-09-09). Disk space was never the problem, each one is tiny.
// %TEMP% is shared with every other program on the machine, and NTFS gets slow
// at enumerating and creating entries in a directory holding hundreds of
// thousands of them.
//
// A per-test try/finally cannot be the answer: several of these dirs are
// assigned to process.env at module load and have to outlive every test in the
// file. So the lifetime that matters is the PROCESS, and `node --test` gives
// each test file its own. Register on create, remove on exit.
//
// This lives in test-support/ rather than test/ on purpose: `node --test`
// treats every .js file under a directory named `test` as a test file, so a
// helper there gets executed as if it were a suite.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Every directory this process made, still to be removed. */
const created = new Set();

let hooked = false;

/**
 * Make a throwaway directory under the system temp dir and have it removed when
 * this process ends.
 *
 * Use this instead of mkdtempSync anywhere a test needs scratch space, and add
 * the prefix to PREFIXES in sweep-temp.js.
 *
 * @param {string} prefix mkdtemp prefix, e.g. 'sb-qc-'
 * @returns {string} the absolute path of the new directory
 */
export function tempDir(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.add(dir);
  if (!hooked) {
    hooked = true;
    // 'exit' fires for a normal end, an explicit process.exit, and an uncaught
    // throw, which covers every way a test file finishes. It does not fire on a
    // SIGKILL, which is what the sweep in sweep-temp.js is for.
    process.on('exit', removeTempDirs);
  }
  return dir;
}

/**
 * Remove every directory tempDir made in this process.
 *
 * Called on exit, so it must stay synchronous: an async cleanup registered on
 * 'exit' never runs. One directory that refuses to go is not worth failing a
 * green suite over, so each is tried on its own and a failure is swallowed --
 * the next run's sweep will collect it.
 */
export function removeTempDirs() {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Held open by a child process the test spawned, or left read-only.
      // Nothing here is worth a failure.
    }
  }
  created.clear();
}

/** Exposed so tempdir.test.js can assert the bookkeeping rather than infer it. */
export const __testing = { created };
