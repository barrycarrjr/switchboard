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
- No secrets are stored. Quota display reads each account's own credentials file
  transiently and calls the vendor usage endpoint; tokens are never persisted or logged.
- Usage is shown wherever the vendor gives an honest source. Claude reads the account's
  own usage endpoint. Codex has no such endpoint, so Switchboard reads the rate-limit
  reply the CLI already recorded in that account's session log, and always shows when
  the snapshot was taken rather than passing it off as live. Gemini and Qwen publish
  nothing, and the card says so instead of showing an empty bar.
- Installs and updates delegate to vendor mechanisms (winget, npm). Nothing is bundled.
- Execution Lanes enable intelligent failover. By running tasks through `switchboard run`, the CLI automatically routes your task to an account with available quota. If a provider limit is hit mid-session, Switchboard securely transfers the context to the next available lane without leaking secrets.

## MCP servers

An MCP server connects an AI client to an outside service such as an issue tracker or an
error reporter. Every client keeps its own private list, so connecting one service to four
clients means doing the same job four times, and a new machine repeats all of it.

The MCP tab keeps the list in one place and registers it with each client you have. Claude
Code, Codex, Junie and VS Code are supported today. "Your servers" shows the handful you
use, with a chip per client; "Browse" is a catalogue of public servers with search and
categories.

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
`providers`, `quota`.

`switchboard status` is the whole picture in one screen, and the only way to read the
machine from somewhere else: per tool, the variable and its value, every registered
account, which one new terminals will use, whether it is signed in, and how much of its
allowance is left with the reset times. `switchboard status --json` prints the same thing
for scripts.

`switchboard run` is the intelligent execution broker: it evaluates the current status of all
configured execution lanes, securely sets up the environment variables for the healthiest 
account, and launches the native CLI. If the task is interrupted by an exhaustion limit, 
Switchboard intercepts the error and securely hands off the session context to the next available lane.
