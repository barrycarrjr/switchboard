// Collect throwaway directories a previous run could not remove itself.
//
// tempdir.js removes what it made when its process exits, which covers every
// normal ending including an uncaught throw. It cannot cover a SIGKILL, a
// machine crash, or a test file that predates it. This sweep is the backstop, so
// one hard kill cannot start the pile growing again.
//
// Wired as npm `pretest`, so it runs exactly ONCE per suite run rather than once
// per test file. Enumerating a large %TEMP% is the slow part, and doing it once
// per file would cost far more than the leak ever did.
//
// Safety: only top-level entries whose name starts with one of PREFIXES are ever
// considered, and only if they are older than the age cut. Nothing else in %TEMP%
// is touched, and a directory belonging to a run happening right now is spared.
import { opendirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The mkdtemp prefixes this package's tests create. Add to this list when a new
 * fixture introduces one, or the sweep will not know it is ours to remove.
 * tempdir.test.js reads the test sources and fails if one is missing here.
 *
 * Runtime prefixes are deliberately absent: core/lane-tokens.js removes its own
 * scratch dir in a finally, so there is nothing of its to collect.
 */
export const PREFIXES = [
  'sb-appdata-',
  'sb-appdata2-',
  'sb-appdata3-',
  'sb-c-',
  'sb-codex-',
  'sb-cx-',
  'sb-d-',
  'sb-defaults-',
  'sb-dt-',
  'sb-dt-home-',
  'sb-dt-no-id-',
  'sb-empty-',
  'sb-f-',
  'sb-failover-',
  'sb-i-',
  'sb-mcp-test-',
  'sb-org-',
  'sb-p-',
  'sb-pkg-',
  'sb-profiles-',
  'sb-provider-status-',
  'sb-q-',
  'sb-q2-',
  'sb-q3-',
  'sb-qc-',
  'sb-qk-',
  'sb-qp-',
  'sb-qp2-',
  'sb-qp3-',
  'sb-running-',
  'sb-s-',
  'sb-s2-',
  'sb-s3-',
  'sb-so-',
  'sb-status-',
  'sb-test-',
  'sb-u-',
  'sb-u2-',
  'switchboard-carry-',
  'switchboard-spec-',
];

const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// A pretest step must never become the slow part of running the tests. If the
// sweep cannot finish inside this, it stops and leaves the rest for next time.
const DEFAULT_BUDGET_MS = 20_000;

const isOurs = (name) => PREFIXES.some((prefix) => name.startsWith(prefix));

/**
 * Remove stale leftovers from earlier runs.
 *
 * @param {object} [options]
 * @param {string} [options.dir] directory to sweep, default the system temp dir
 * @param {number} [options.maxAgeMs] only remove entries older than this
 * @param {number} [options.budgetMs] stop after roughly this long
 * @returns {{scanned: number, removed: number, failed: number, timedOut: boolean}}
 */
export function sweepTempDirs({
  dir = tmpdir(),
  maxAgeMs = DEFAULT_MAX_AGE_MS,
  budgetMs = DEFAULT_BUDGET_MS,
} = {}) {
  const cutoff = Date.now() - maxAgeMs;
  const deadline = Date.now() + budgetMs;
  const result = { scanned: 0, removed: 0, failed: 0, timedOut: false };

  let handle;
  try {
    handle = opendirSync(dir);
  } catch {
    // No temp dir to sweep is not a failure worth reporting.
    return result;
  }

  try {
    for (;;) {
      // Streamed rather than readdirSync, because the whole reason this exists is
      // a temp dir with a very large number of entries in it, and reading that
      // into one array is its own problem.
      const entry = handle.readSync();
      if (!entry) break;
      // >= rather than >, so a zero budget is over before the first entry rather
      // than depending on the clock happening to tick.
      if (Date.now() >= deadline) {
        result.timedOut = true;
        break;
      }
      if (!entry.isDirectory() || !isOurs(entry.name)) continue;

      result.scanned += 1;
      const path = join(dir, entry.name);
      try {
        // stat only the candidates, never every entry: a stat per entry over a
        // bloated temp dir is the expensive thing to avoid.
        if (statSync(path).mtimeMs > cutoff) continue;
        rmSync(path, { recursive: true, force: true, maxRetries: 3 });
        result.removed += 1;
      } catch {
        // In use by a run happening right now, or read-only. Leave it.
        result.failed += 1;
      }
    }
  } finally {
    try {
      handle.closeSync();
    } catch {
      // Already closed.
    }
  }

  return result;
}

// Run directly (npm pretest) rather than imported: report briefly and never fail
// the test run, whatever happened here.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const { scanned, removed, failed, timedOut } = sweepTempDirs();
    if (removed || failed || timedOut) {
      const note = timedOut ? ' (stopped early, more left for next run)' : '';
      console.log(`temp sweep: removed ${removed} of ${scanned} stale dirs, ${failed} left${note}`);
    }
  } catch (err) {
    console.log(`temp sweep skipped: ${err.message}`);
  }
}
