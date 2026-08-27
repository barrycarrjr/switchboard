# Switchboard

A small Windows tray app that manages the AI tooling on a developer's machine: install and
update the AI CLIs, register multiple subscription accounts per tool, switch the active
account in two clicks, see each account's usage against its available limits, register MCP servers across every
AI client at once, and run health checks for broken setups and billing traps.

It also acts as an execution broker (`switchboard run`), routing tasks to the healthiest available AI account via ordered "execution lanes," tracking quota limits, and securely handing off context when an account hits its limit mid-task.

For deep-dives into architecture, guides, and full command references, see the **[`docs/`](./docs/)** directory.

## How it works

- An account is a vendor config folder. Switchboard registers labels and folder paths,
  nothing else. Four tools qualify, because each has a variable that moves its whole
  sign-in to another folder: Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`),
  Gemini CLI (`GEMINI_CLI_HOME`) and Qwen Code (`QWEN_HOME`).
- Two of those variables name the folder itself and two name the folder above it, so
  `GEMINI_CLI_HOME=C:\profiles\work` means the account lives in
  `C:\profiles\work\.gemini`. Switchboard appends the vendor's folder name for you and
  refuses to register a folder the vendor could never read.
- A tool is deliberately absent when its sign-in lives outside the config folder. GitHub
  Copilot CLI is the case in point: `COPILOT_HOME` moves its settings, but the token sits
  in Windows Credential Manager keyed by GitHub login, so a second folder would look like
  a second account and quietly share the first one's identity. Tools like that appear on
  the Accounts page as a single machine-wide login instead.
- Switching sets the user-scope default for those variables, so new terminals and newly
  launched tools inherit it. Running processes are untouched, unless launched via `switchboard run`.
- A desktop app follows the same switch where the app can. Claude Desktop keeps each
  account in its own data folder, so the Apps tab names the account its Launch button
  will open (the one that is the machine default right now) and puts the others behind
  the arrow, exactly as the terminal buttons do. Switchboard finds the standard folder
  and any `~/.claude-desktop*` folder the app has run in, names each one after the
  registered account it is signed in as, and lets you add a folder kept anywhere else.
  Signing in stays the app's own job, and an app that keeps one login per machine
  (Antigravity), switches accounts inside itself (T3 Code), or has no account at all
  (LM Studio) keeps its plain button.
- No secrets are stored. Quota display reads each account's own credentials file
  transiently and calls the vendor usage endpoint; tokens are never persisted or logged.
- Usage is shown wherever the vendor gives an honest source. Claude and Codex both read
  the account's own sign-in and ask the vendor what that account has spent. When a Codex
  check is refused, usually a token its CLI has not refreshed in a while, Switchboard
  falls back to the rate-limit reply the CLI already recorded in that account's session
  log, says why it is standing in, and always shows when the snapshot was taken rather
  than passing it off as live. Gemini and Qwen publish nothing, and the card says so
  instead of showing an empty bar.
- The Apps tab shows what is actually running. An app card gets a green corner dot while
  a process of that app is alive, matched by its program file (or, for a Store app, the
  package folder its processes run from) so a same-named file elsewhere never counts. A
  background worker with no window, such as a Slack bridge, can be watched too: give it a
  name and a piece of its command line, and its card says Running or Not running. The
  check is a local process listing taken only while the window is open; nothing is ever
  started or stopped.
- Installs and updates delegate to vendor mechanisms (winget, npm). Nothing is bundled.
- Execution Lanes enable intelligent failover. By running tasks through `switchboard run`, the CLI automatically routes your task to an account with available quota. If a provider limit is hit mid-session, Switchboard securely transfers the context to the next available lane without leaking secrets.

## MCP servers

An MCP server connects an AI client to an outside service such as an issue tracker or an
error reporter. Every client keeps its own private list, so connecting one service to four
clients means doing the same job four times, and a new machine repeats all of it.

The MCP tab keeps the list in one place and registers it with each client you have. Claude
Code, Codex, Junie and VS Code are supported today. "Active servers" shows what is switched
on right now, with a chip per client, including anything a client was given outside
Switchboard; "Browse" is a catalogue of public servers with search and categories, and a
short suggested list at the top of it.

- Switchboard stores a name and an https address, nothing more. **No token ever passes
  through it, and it opens no port and proxies nothing.** Each client still signs in for
  itself and keeps its own credentials, exactly as it does today.
- Registration delegates to the client's own CLI where one exists, because the config
  formats genuinely conflict and at least one client destroys its whole server list when
  handed a shape it does not expect. Where a file must be edited, a timestamped backup is
  written first and a config that cannot be parsed is refused rather than overwritten.
- A chip shows three states: not registered, registered, and registered but not signed in.
  A tick that meant "signed out and broken" would be worse than no tick, so a client that
  cannot report its sign-in state says so rather than guessing.
- Servers needing an API key are deliberately absent from the catalogue. They cannot work
  without stored secrets, and listing them would offer a server that looks configured and
  fails on first use.

## Install

1. Go to the [latest release](../../releases/latest) and download
   `Switchboard-Setup-<version>.exe` (under Assets).
2. Run it. Windows shows a SmartScreen warning because the app is not code-signed yet:
   choose **More info**, then **Run anyway**.
3. That's it. No admin rights needed. Switchboard appears in your system tray, detects
   your installed AI tools, and registers your existing accounts if you have them.

It installs per-user to `%LOCALAPPDATA%\Programs\Switchboard`, registers an uninstaller in
Apps & Features, and running a newer setup upgrades in place. App data lives in
`%APPDATA%\Switchboard` and is kept on uninstall.

The About panel can export all Switchboard-owned configuration to a versioned JSON file and
import it later. This includes account registrations and active choices, preferences, custom
app launchers, and custom MCP server definitions. It does not contain tokens, vendor
credential files, or MCP client sign-ins. Import validates the complete file and writes a
pre-import recovery backup under `%APPDATA%\Switchboard\backups` before replacing anything.
An in-app upgrade writes the same kind of importable backup immediately before its setup
program is launched; if that backup cannot be written, the upgrade does not start.

After installing, updates come from inside the app: it checks the [Releases](../../releases)
automatically, and the version number in the header becomes an Update button when a newer
version exists.

Releases are built by CI from a version tag (`v<version>`); the tag must match the version
in `package.json`.

## Development

```
npm install
npm run icons
npm test
npm start
npm run catalog   # refreshes the MCP server catalogue in core/
npm run dist      # builds dist/Switchboard-Setup-<version>.exe
```

`npm run catalog` regenerates `core/catalog-remote.json` from Docker's published MCP
catalogue over plain HTTPS. Docker itself is not needed, to regenerate it or to use it: the
result is data we ship, not a dependency. It keeps only servers reachable at an https
address and drops any that need an API key.

The core (`core/`, `bin/cli.js`) is plain Node with no Electron dependency; the tray shell
is a thin skin over it. `switchboard` is also a CLI: `status`, `accounts`, `use`, `doctor`,
`providers`, `quota`, `lanes`, `lane-token`, `watch`.

Everything the tray decides, the CLI decides the same way, because both call the same code
in `core/`. That is what makes a machine with no desktop usable: `switchboard lanes` edits
the same pool the Lanes tab edits, and `switchboard watch` runs the same quota watch the
tray runs on its five-minute timer.

`switchboard status` is the whole picture in one screen, and the only way to read the
machine from somewhere else: per tool, the variable and its value, every registered
account, which one new terminals will use, whether it is signed in, and how much of its
allowance is left with the reset times. `switchboard status --json` prints the same thing
for scripts.

`switchboard lanes` is the failover pool: `lanes` lists it in priority order, `lanes add
<accountId>` appends one, `lanes order <id>...` reorders it, `lanes remove <id>` takes one
out, and `lanes budget <id> <amount>` sets what a metered lane may spend. A metered lane
with no budget is deliberately unselectable rather than unlimited, and the listing says so
rather than leaving it to be discovered by a run that skips it.

`switchboard lane-token <laneId>` mints a token a Claude lane can hand to automation, so
fleets authenticate with the token instead of opening the account folder's credential
file. Minting runs `claude setup-token` inside the lane's own account folder, with any
inherited token stripped, so it can never bind the wrong account; the freshly minted
token is validated against the vendor usage endpoint before it is stored, and a refused
one is not stored at all. The minting login's identity is stamped into the stored entry,
so a lane folder later signed in to a different account stops receiving the token (and
Health says why) instead of quietly billing the account the token was minted for; a
folder with no readable sign-in identity refuses to mint until it is signed in.
`lane-token <laneId> --check` asks the vendor whether the
stored token is still honoured, and `lane-token <laneId> --remove` deletes it. The token
never appears in `lanes --json`, the tray, a config export, or any printed output.
`switchboard dry-run --json --with-token` adds the token to the JSON for the calling
process only, and only when the caller passes the flag; a token the vendor has revoked
is marked dead, stops being emitted, and shows up as a Health warning saying to mint a
new one, while the lane itself keeps running on its folder sign-in. Uninstalling
Switchboard leaves `settings.json` behind in `%APPDATA%\Switchboard`, so remove lane
tokens first if the machine is being retired.

`switchboard watch` is the quota watch without the tray. `--once` takes a single pass, for
Task Scheduler or cron; without it, it stays running and takes a pass every five minutes.
`--mode notify` reports what it would do and `--mode auto` switches the machine default,
overriding the stored setting for that one command without writing it back. Readings come
through the same shared cache the tray fills, so running both costs no extra requests for
quota readings. Stored lane tokens are validated on the same schedule, throttled to about
one vendor call per token per hour, and the tray checks them on every pass even with the
quota watch off, so a revoked token is noticed within the hour rather than at the next
failed run. `switchboard lane-token <laneId> --check` always asks the vendor immediately.

The watch moves the default before an account is completely out, not after. Two windows
decide it: the five hour session window and the weekly one. The five hour window is the one
that stops work first in practice, because it is the smallest and fills fastest, and it can
sit at ninety odd percent while the weekly figure still looks comfortable. So an account is
handed the machine default only while both windows have room to spare (under 90 percent of
the five hour window and under 95 percent of the weekly one), and the default is moved off
an account as soon as either window passes those marks and somewhere better exists. Lane
order still decides which account is preferred; usage only decides which accounts are in
the running. One run is judged differently: a lane at 95 percent still works, so
`switchboard run` will happily use it and fall over to the next lane if it does hit the
wall. Pointing every terminal on the machine at an account with minutes left is the thing
these limits prevent.

`switchboard run` is the intelligent execution broker: it evaluates the current status of all
configured execution lanes, securely sets up the environment variables for the healthiest 
account, and launches the native CLI. If the task is interrupted by an exhaustion limit, 
Switchboard intercepts the error and securely hands off the session context to the next available lane.
