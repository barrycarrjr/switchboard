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

1. Go to the [latest release](../../releases/latest) and download
   `Switchboard-Setup-<version>.exe` (under Assets).
2. Run it. Windows shows a SmartScreen warning because the app is not code-signed yet:
   choose **More info**, then **Run anyway**.
3. That's it. No admin rights needed. Switchboard appears in your system tray, detects
   your installed AI tools, and registers your existing accounts if you have them.

It installs per-user to `%LOCALAPPDATA%\Programs\Switchboard`, registers an uninstaller in
Apps & Features, and running a newer setup upgrades in place. App data lives in
`%APPDATA%\Switchboard` and is kept on uninstall.

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
npm run dist   # builds dist/Switchboard-Setup-<version>.exe
```

The core (`core/`, `bin/cli.js`) is plain Node with no Electron dependency; the tray shell
is a thin skin over it. `switchboard` is also a CLI: `status`, `accounts`, `use`, `doctor`,
`providers`, `quota`.
