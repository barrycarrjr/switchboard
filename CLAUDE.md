# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

Switchboard is a Windows tray app plus a CLI that manages AI coding tools and the
subscription accounts they use: install/update the vendor CLIs, register several accounts
per tool, switch which one new terminals get, read each account's usage, register MCP
servers with every client at once, and broker command execution across "lanes" with
failover. Plain ESM Node, no runtime dependencies; Electron is a dev dependency only.

`README.md` explains the behaviour in full and is kept accurate. Read the relevant section
there before changing a behaviour, and update it in the same commit when behaviour moves.
Deeper material lives in `docs/` (`design/` for why, `guides/` for how, `references/` for
exact flags and schemas).

## Commands

```
npm install
npm run icons     # generates the gitignored assets/*.png and build/icon.ico; needed once
npm test          # node --test over test/, ~700 tests in a couple of seconds
npm start         # electron .
npm run catalog   # regenerates core/catalog-remote.json from Docker's published MCP catalogue
npm run dist      # dist/Switchboard-Setup-<version>.exe
```

Run a single suite with `node --test test/lanes.test.js`. `npm test` has a `pretest` that
sweeps stale temp dirs; run it through npm rather than bare `node --test` when you want that.

## Architecture

- `core/` is the whole brain: plain Node, **no Electron import anywhere**. Both front ends
  call it.
- `bin/cli.js` is the CLI; `src/main.js` is the Electron main process (window, tray, IPC).
  Neither should decide anything on its own. If the tray and the CLI could disagree about
  an answer, the answer belongs in `core/`. That equivalence is what makes a headless
  machine usable, so treat it as a hard rule.
- `src/preload.cjs` is the only bridge to the renderer. A new feature usually means: a
  function in `core/`, an `ipcMain.handle('sb:x', ...)` in `src/main.js`, an `sb.x` entry in
  `preload.cjs`, then the UI.
- `src/ui/index.html` is the entire interface in one file (markup, styles, script). There is
  no build step and no framework.
- `core/paths.js` owns every app-data location; `dataDir()` derives from `%APPDATA%`, which
  is how tests redirect it.

## Tests

- `node:test` with `assert/strict`. Test names are sentences describing the promise being
  kept ("a stale reading of the default cannot vouch for leaving it"), not method names.
- **Take scratch space from `tempDir()` in `test-support/tempdir.js`, never `mkdtempSync`
  directly**, and add any new prefix to `PREFIXES` in `test-support/sweep-temp.js`.
  `test/tempdir.test.js` reads the test sources and fails if a prefix is missing. Helpers
  live in `test-support/` because `node --test` would execute anything under `test/` as a
  suite.
- **Tests never touch the real app data folder.** `npm test` loads
  `test-support/isolate-appdata.js`, which points `APPDATA` at a throwaway folder in every
  test process, and `test/isolation.test.js` fails if that line leaves the script. Still set
  `APPDATA` (or pass an explicit file) in any suite that writes through `dataDir()`, so a
  bare `node --test` of that one file is safe too.
- UI tests (`test/ui-*.test.js`) lift functions out of `index.html` by text: `lift()` finds a
  line starting `const name = ` or `function name(` and, for a function, reads to the next
  line that is exactly `}`. So keep page-level helpers at column 0 with their closing brace
  at column 0, or the tests stop finding them.
- Tests never reach the network or a real vendor CLI; they inject fakes.

## Hard constraints

- **Nothing personal or machine-specific in the tree.** `test/generic.test.js` scans every
  `.js/.cjs/.mjs/.html/.json/.md` file (this one included) against
  `scripts/forbidden-patterns.js`: credential prefixes, key headers, real user-profile
  paths, literal email addresses, plus anything in an untracked `.forbidden-local.json`.
  Use `%APPDATA%`, `~/.config`, or a placeholder instead of a real path. The publishing
  repository name is also absent by design: CI stamps it into the packaged
  `package.json`, and `src/main.js` reads it from there or from local settings.
- **Secrets.** Quota reads a vendor credentials file transiently and never persists or logs
  it. The one stored secret is a lane setup token in `%APPDATA%\Switchboard\settings.json`;
  it must never appear in `lanes --json`, a config export, the tray, or any Switchboard
  output except the vendor's own mint step.
- **Config files.** Write through `writeJsonAtomic` (temp file then rename). When editing a
  foreign client's config, back it up first and refuse a file that will not parse rather
  than overwriting it.
- **Honesty over guessing.** A state that cannot be read is reported as unknown, with its
  age, rather than shown as a clean value. Failure classification (limit versus refused
  sign-in) is matched on specific vendor phrases, never on a lone word, because a run's
  output also contains whatever the agent itself printed.
- LF line endings everywhere (`.gitattributes`). No em dashes or en dashes in source,
  comments, docs, or commit messages.

## Style

Comments explain *why*, in full sentences, and are expected where a decision looks
arbitrary (see `test-support/tempdir.js` or `core/paths.js` for the register). Do not write
comments that restate the code. User-facing strings and docs use plain language and avoid
jargon.

Commit subjects are plain-English statements of the change in the imperative, no prefixes
or ticket ids: "Move a run off a lane that cannot sign in". Bodies explain the reasoning and
say what was verified.

## Releasing

Bump `version` in `package.json` (and keep `package-lock.json` in step), commit as
"Bump version to X.Y.Z to ship <the thing>", then push tag `v<version>`. The release
workflow refuses a tag that does not match `package.json`, runs `npm run icons` and
`npm test`, builds the NSIS installer, and attaches it to the GitHub release. Never tag or
push without being asked.
