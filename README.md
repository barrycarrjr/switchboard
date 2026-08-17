# Switchboard

A small Windows tray app that manages the AI tooling on a developer's machine: install and
update the AI CLIs, register multiple subscription accounts per tool, switch the active
account in two clicks, see each account's remaining quota, and run health checks for broken
setups and billing traps.

It manages tools and accounts only. It never runs tasks, never holds sessions, and never
touches a running application or any GUI application's login.

## How it works

- An account is a vendor config folder. Claude Code accounts are folders selected via
  `CLAUDE_CONFIG_DIR`; Codex accounts are folders selected via `CODEX_HOME`. Switchboard
  registers labels and folder paths, nothing else.
- Switching sets the user-scope default for those variables, so new terminals and newly
  launched tools inherit it. Running processes are untouched.
- No secrets are stored. Quota display reads each account's own credentials file
  transiently and calls the vendor usage endpoint; tokens are never persisted or logged.
- Installs and updates delegate to vendor mechanisms (winget, npm). Nothing is bundled.

## Install

Run `Switchboard-Setup-<version>.exe`. It installs per-user (no admin prompt) to
`%LOCALAPPDATA%\Programs\Switchboard`, registers an uninstaller in Apps & Features, and
running a newer setup upgrades in place. App data lives in `%APPDATA%\Switchboard` and is
kept on uninstall.

## Development

```
npm install
npm run icons
npm test
npm start
npm run dist   # builds dist/Switchboard-Setup-<version>.exe
```

The core (`core/`, `bin/cli.js`) is plain Node with no Electron dependency; the tray shell
is a thin skin over it. `switchboard` is also a CLI: `status`, `accounts`, `use`, `doctor`,
`providers`, `quota`.
