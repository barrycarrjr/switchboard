# Switchboard

A small Windows tray app that manages the AI tooling on a developer's machine: install and
update the AI CLIs, register multiple subscription accounts per tool, switch the active
account in two clicks, see each account's remaining quota, register MCP servers across every
AI client at once, and run health checks for broken setups and billing traps.

It manages tools, accounts and connections only. It never runs tasks, never holds sessions,
and never touches a running application or any GUI application's login.

## How it works

- An account is a vendor config folder. Claude Code accounts are folders selected via
  `CLAUDE_CONFIG_DIR`; Codex accounts are folders selected via `CODEX_HOME`. Switchboard
  registers labels and folder paths, nothing else.
- Switching sets the user-scope default for those variables, so new terminals and newly
  launched tools inherit it. Running processes are untouched.
- No secrets are stored. Quota display reads each account's own credentials file
  transiently and calls the vendor usage endpoint; tokens are never persisted or logged.
- Installs and updates delegate to vendor mechanisms (winget, npm). Nothing is bundled.

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
