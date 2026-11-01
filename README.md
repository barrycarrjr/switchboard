# Switchboard

A small Windows tray app that manages the AI tooling on a developer's machine: install and
update the AI CLIs, register multiple subscription accounts per tool, switch the active
account in two clicks, see each account's usage against its available limits, register MCP
servers with every supported AI client at once, and run health checks for broken setups
and billing traps.

It also acts as an execution broker (`switchboard run`): it routes a command to the
healthiest available account through ordered "execution lanes," and starts the command
again in the next lane when the one it is using hits a provider limit.

For deep-dives into architecture, guides, and full command references, see the **[`docs/`](./docs/)** directory.

## How it works

- An account is a vendor config folder. Switchboard registers labels, folder paths and an
  optional display color, nothing else. Four tools qualify, because each has a variable that moves its whole
  sign-in to another folder: Claude Code (`CLAUDE_CONFIG_DIR`), Codex (`CODEX_HOME`),
  Gemini CLI (`GEMINI_CLI_HOME`) and Qwen Code (`QWEN_HOME`).
- Three of those variables name the folder itself. `GEMINI_CLI_HOME` alone names the
  folder above it, so `GEMINI_CLI_HOME=C:\profiles\work` means the account lives in
  `C:\profiles\work\.gemini`. Switchboard appends the vendor's folder name for you and
  refuses to register a folder the vendor could never read.
- A tool is deliberately absent when its sign-in lives outside the config folder. GitHub
  Copilot CLI is the case in point: `COPILOT_HOME` moves its settings, but the token sits
  in Windows Credential Manager keyed by GitHub login, so a second folder would look like
  a second account and quietly share the first one's identity. Tools like that appear on
  the Accounts page as a single machine-wide login instead.
- Switching sets the user-scope default for those variables, so new terminals and newly
  launched tools inherit it. Running processes are untouched. `switchboard run` does not
  read that default at all: it pins each command it launches to the account of the lane
  it picked, so a switch never disturbs a run already under way.
- With the watch set to "Switch automatically", a tool that has lanes has its account
  picked by the watch instead of by hand (for Claude Code and Codex, the ready account
  whose weekly quota resets soonest), because the watch would switch a hand-picked account
  straight back at its next check. So for
  that tool the Accounts page and the tray list its accounts in the order they will be
  used, show which one is in use, and do not offer to switch it. Set the watch to "Tell
  me" or "Do nothing" to choose by hand again. Gemini CLI and Qwen Code report no usage,
  so the watch never moves their default between subscription accounts (only onto a
  ready pay-per-use lane, when the account in use is signed out or has no subscription
  lane of its own); the switch is still not offered for them on this setting, so
  use "Tell me" or "Do nothing" for those too. `switchboard use` still switches from a
  terminal, since it cannot tell whether a watch is running, and says what one would do.
- Adding an account asks only for a name. Switchboard makes a fresh folder for it
  (`~/.claude-work` for a Claude Code account called Work, `~/work/.gemini` for Gemini CLI,
  never reusing a folder that already exists) and opens the vendor's sign-in pointed at
  it, so a subscription that has never been used on this machine can be added. A folder
  that already holds a login can still be picked by hand from the same form.
  `switchboard add <tool> <label>` makes the folder the same way from a terminal when the
  folder is left out, and prints the sign-in command to run in it.
- An account can have a color, so it is easy to tell at a glance which one you are using,
  and so it can match the color T3 Code shows it in. Click the dot after an account's name
  on the Accounts or Lanes tab to pick one, type a hex value, or clear it. The card gets a
  thin bar of that color along its top, and the same color appears as a dot beside the
  account on the terminal buttons, the Apps tab menus and the tray menu. None of it moves a
  name: the bar is drawn inside the card's edge, the dot sits after the name, and in a list
  where only some accounts have a color the others keep an empty space the same size.
  Where T3 Code has a color for an account folder Switchboard also knows, the tool's
  heading offers "Copy colors from T3 Code", and the chooser offers T3's color for that one
  account. The two are matched by config folder only, never by name, and a T3 entry with
  no folder set is left alone because it could be any account. From a terminal,
  `switchboard color <id> <hex|none>` sets or clears one (type `2563eb` without the `#`,
  which a shell would read as the start of a comment) and `switchboard color --from-t3`
  copies T3's.
- Signing in and signing out both stay the vendor's own job. The card's Re-authenticate
  button opens a terminal already pointed at that account's folder, which is also how you
  move a folder to a different subscription or replace a login the vendor has stopped
  accepting. Sign out runs the vendor's own logout command against that folder and then
  reports what the folder actually looks like, rather than trusting the command's exit
  code. Switchboard never deletes a credential file itself, so the button only appears for
  a tool that publishes a logout command (Claude Code and Codex do; Gemini CLI and Qwen
  Code sign out from inside their own sessions) and only while there is a login there to
  remove. Removing an account is a different thing again: it unregisters the folder and
  leaves the login in place.
- A Claude login the vendor refused to renew is named as such on the card, with the time it
  happened, rather than reported as a plain "Not signed in". Claude Code blanks both tokens
  in place when a refresh is rejected and leaves a login expiry still in the future. The
  usual cause is another program on the machine renewing the same login and keeping what it
  got back: a refresh token works exactly once, so the one left in the folder is already
  dead. Switchboard's own readers never renew anything, and its sign-in check
  (`claude auth status`) makes no network call at all. Those same marks are also left by a
  login that moved to the system credential store, and that account is signed in and at
  fault for nothing, so the sentence is only ever said where Claude itself has just
  confirmed the account is signed out. A terminal `switchboard status` or `doctor`, which
  does not run that check, keeps the plain line rather than naming a cause it cannot stand
  behind.
- A desktop app follows the same switch where the app can. Claude Desktop keeps each
  account in its own data folder, so the Apps tab names the account its Launch button
  will open (the one that is the machine default right now) and puts the others behind
  the arrow, exactly as the terminal buttons do. Switchboard finds the standard folder
  and any `~/.claude-desktop*` folder the app has run in, names each one after the
  registered account it is signed in as, and lets you add a folder kept anywhere else.
  Signing in stays the app's own job, and an app that keeps one login per machine
  (Antigravity), switches accounts inside itself (T3 Code), or has no account at all
  (LM Studio) keeps its plain button. So does the Codex app, until opening it on a
  chosen account has been checked to work.
- Account switching and usage display store no secrets. Quota display reads each
  account's own credentials file transiently and calls the vendor usage endpoint; that
  token is never persisted or logged. The one secret Switchboard does keep is a lane
  token you mint yourself for automation, stored encrypted in its own settings file.
  See `lane-token` under Development.
- Usage is shown wherever the vendor gives an honest source. Claude and Codex both read
  the account's own sign-in and ask the vendor what that account has spent. When a check
  is refused, Switchboard falls back to a record the vendor's own software already keeps:
  for Claude, the usage log Claude Desktop writes for the same organization; for Codex,
  the rate-limit reply its CLI recorded in that account's session log (usually the cause
  is a token that CLI has not refreshed in a while). It says why the fallback is standing
  in, and always shows when the snapshot was taken rather than passing it off as live.
  Antigravity's usage is read by asking its own CLI. Gemini and Qwen publish nothing, and
  the card says so instead of showing an empty bar.
- Claude plans differ in which windows they have. Most have a five-hour session window and
  a weekly one. Ultra (formerly Max 20x) has no five-hour window, only the weekly one plus
  a weekly cap on the Fable model. Everything below that mentions the five-hour window
  applies only where the account has one. The Fable cap is shown on the card, but it is
  not one of the limits that moves the default or picks a lane, and it raises no alert
  unless you set a threshold for it (see `switchboard notify`).
- Hovering over the tray icon shows every signed-in account for each installed provider
  and, where the provider reports them, that account's session and weekly usage. Each
  provider is a heading, with its accounts indented beneath it, the account in use first.
  Windows cuts a tray hover at 127 characters, so a compact layout is used when that is
  what fits, and when even that does not, only the account in use for each tool, with a
  count of the ones left out. The icon already identifies Switchboard, so the hover
  spends none of the limit repeating the app name.
- The hover itself starts no provider request: it shows readings already made by the
  Accounts page or the tray's five-minute pass. That pass reads usage live only when it
  has a reason to: the quota watch is on, a notification hook is set, or Antigravity is
  signed in (its usage is read on every pass). Normal reads are shared for five minutes. A
  rate-limited response backs automatic checks off for thirty minutes. A rejected
  credential backs off for an hour unless the credential file changes. A newer sign-in
  check on the Accounts page also clears any older tray warning.
- A fallback never replaces something newer. When a live check fails and the snapshot
  standing in was taken before the last live reading, the card keeps that reading, says
  the newer check failed, and marks it stale once it is old enough to be. A snapshot is
  also never given the reset time of a window that began after it was taken, so last
  week's usage cannot pass for this week's.
- The Apps tab shows what is actually running. An app card gets a green corner dot while
  a process of that app is alive, matched by its program file (or, for a Store app, the
  package folder its processes run from) so a same-named file elsewhere never counts. A
  background worker with no window, such as a Slack bridge, can be watched too: give it a
  name and a piece of its command line (or pick it from a searchable list of what is
  running now), and its card says Running or Not running. The
  check is a local process listing taken only while the window is open; nothing is ever
  started or stopped.
- Installs and updates delegate to vendor mechanisms: winget, npm, pip, or the vendor's
  own install script. A tool with no such command for Windows is detected but not
  installed, and links to the vendor site instead. Nothing is bundled.
- Antigravity is kept up to date by Switchboard rather than by itself. Its CLI looks for a
  new version of itself whenever it starts, and it does that in a second process it gives
  a console of its own, so Windows draws a command window on screen for about a second,
  several times an hour. Nothing the program starting it can do will hide that window.
  While Switchboard is running it keeps the CLI's own record of that check current, which
  stops the CLI starting one, and runs `agy update` itself once a day with no window. That
  is also the only thing the Providers tab will say about Antigravity: the vendor has no
  command that reports an available update without installing it, so the row reports the
  result of the last update Switchboard ran, and says it does not know once that result is
  more than two days old.
- Execution lanes are the failover pool. A lane is one account of one tool. Besides the
  four tools above, a lane can use a tool with a single machine-wide login, such as
  Antigravity, Copilot or Junie. `switchboard run` picks the first healthy lane (on
  "Switch automatically", the accounts of each tool are taken soonest weekly reset
  first), launches the vendor's own CLI pinned to that account, and, when a run stops on a
  provider limit, a provider server error, or a sign-in the vendor refused, drops that
  lane and starts the command again in the next one. Between two Claude accounts the
  conversation goes with it: the session is copied into the incoming account and resumed
  there, so the new account carries on from where the spent one stopped instead of
  starting over. Every other combination gets a handoff instead: Switchboard writes one
  from what the spent session said as it worked, and tells the next tool to read it.
  Claude and Codex can each hand over to the other, and to another account of their own.
  Moving work that has already started to a different tool asks first, unless you passed
  `--yes`. A handoff you
  wrote yourself is used as it is and never overwritten.

## MCP servers

An MCP server connects an AI client to an outside service such as an issue tracker or an
error reporter, or to a program on your own machine. Every client keeps its own private
list, so connecting one service to five clients means doing the same job five times, and a
new machine repeats all of it.

The MCP tab keeps the list in one place and registers it with each client you have. Claude
Code, Codex, Antigravity, Junie and VS Code are supported today. "Active servers" shows what
is switched on right now, with a chip per client, including anything a client was given
outside Switchboard; "Browse" is a catalogue of public servers with search and categories,
and a short suggested list at the top of it.

- A server is either remote (an https address) or local (a program the client starts
  itself, with optional arguments and environment values, for example `node` and the path
  to a script). The add form at the foot of the tab takes either: an address starting
  `https://`, or a command with its arguments in the box beside it. Environment values, and
  an argument with a space in it, need the terminal (see below).
- For a remote server, Switchboard stores a name and an https address, nothing more. **No
  sign-in ever passes through it, and it opens no port and proxies nothing.** Each client
  still signs in for itself and keeps its own credentials, exactly as it does today. A
  local server's environment values often hold an API key, so be aware they are kept in
  `%APPDATA%\Switchboard\mcp.json` and written into each client you add the server to,
  just as that client would keep them if you set it up there by hand.
- A local server's command, arguments and environment values may not contain any of
  `` " ' ` < > | & ; $ ( ) % ^ ``. On Windows the clients' own commands run through the
  command prompt, and those are the characters that could make a value start a second
  command. A server whose entry uses one can still be shown and removed here, but has to be
  set up inside the client itself.
- Registration delegates to the client's own CLI where one exists, because the config
  formats genuinely conflict and at least one client destroys its whole server list when
  handed a shape it does not expect. Where a file must be edited, a timestamped backup is
  written first and a config that cannot be parsed is refused rather than overwritten.
- Claude Code and Antigravity each keep more than one list on a machine, and a session
  reads only one of them, so a server added while one account was in use would be missing
  under the next. Switchboard shares them automatically: every server any of these
  lists has is added to every other list of the same tool. For Claude Code the lists are the
  `.claude.json` in the folder `CLAUDE_CONFIG_DIR` points at, the one in your home folder
  (something may start Claude without that variable set), and the one in each Claude
  account's folder registered here. For Antigravity they are `~/.gemini/config`,
  `~/.gemini/antigravity-ide`, and each profile T3 Code keeps under
  `~/.t3/userdata/providers/antigravity`, each holding an `mcp_config.json`.
- That sharing runs whenever the MCP tab opens and on `switchboard mcp list`, `register`
  and `sync`. It only ever adds: an entry already in a list is left exactly as it is, even
  where another list describes the same name differently, and the one change it makes to an
  existing Antigravity entry is to add the second address key Antigravity's two readers use,
  with the entry's own address. Every file is backed up beside itself before it is changed,
  and only the newest three backups are kept. A file that does not exist yet is not
  created, and a file that is empty, cannot be read or will not parse is left alone and
  named in the output of `switchboard mcp sync`. A server switched off here is not shared,
  so it cannot creep back on from a list that still had it. For the same reason, taking a
  server out of Claude Code or Antigravity takes it out of every one of that tool's lists.
- A chip shows four states: not registered, registered and signed in, registered but not
  signed in, and plain registered for a client that cannot report its sign-in state. A
  tick that meant "signed out and broken" would be worse than no tick, so that last case
  says what it knows rather than guessing.
- The mark at the left of an active row is a switch for the whole server: one click takes
  it out of every client that has it, and the next click puts it back. Switching off
  copies each client's own entry out first, so it works for servers Switchboard could
  remove but never re-create. Those copies are the client's entry as written, arguments
  and environment included, because a partial copy could not be put back; they live in
  `%APPDATA%\Switchboard\mcp.json`, are never shown in the panel, and are not part of an
  exported configuration. A client that refuses keeps its copy and is named in the
  message, so the button can be pressed again.
- Servers needing an API key are deliberately absent from the catalogue. They cannot work
  without stored secrets, and listing them would offer a server that looks configured and
  fails on first use.

The same is available from a terminal:

```
switchboard mcp list [--json]                       servers and their state in each client
switchboard mcp add <name> <https url>              add a remote server to the list
switchboard mcp add <name> [-e KEY=VALUE ...] --stdio <command> [args...]
                                                    add a local server; everything after
                                                    the command is passed to it as typed
switchboard mcp remove <name>                       take a server off Switchboard's list
switchboard mcp register <name> [client|all]        give a server to one client, or every one here
switchboard mcp unregister <name> [client|all]      take it out of one client, or every one
switchboard mcp disable <name>                      switch it off everywhere, keeping a copy
switchboard mcp enable <name>                       put it back from that copy
switchboard mcp sync [--json]                       share servers across accounts now
```

`<client>` is one of `claude`, `codex`, `antigravity`, `junie` or `vscode`; leaving it out
means all of them. With `--json`, anything Switchboard has to say about a file it left
alone goes to standard error, so standard output is only the JSON.

## Customizations and automations

The Customizations tab extends that same single-source-of-truth model beyond MCP servers to
plugins, skills (`SKILL.md`), global rules (`CLAUDE.md`, `GEMINI.md`, `AGENTS.md`), custom
agents, a multi-source marketplace, and provider-agnostic scheduled automations.

- Eligible providers are discovered dynamically from the tools installed or registered on
  the machine, so newly installed tools (such as Grok or Qwen) appear automatically in the
  `Providers (active/total)` selector without manual configuration.
- Skills, rules, and custom agents are stored in `%APPDATA%\Switchboard\customizations` and
  propagated across every registered account folder of each enabled provider, with
  timestamped backups before any existing file is updated.
- The Marketplace view aggregates trusted catalogs from Google Antigravity, Anthropic
  Claude Code, OpenAI Codex, and the official MCP catalogue, and can also install skills or
  plugins directly from any GitHub `owner/repo`.
- Low-level machine automations run scheduled prompts through Switchboard's lane pool so
  recurring maintenance or audits can fail over across providers automatically.

```
switchboard customizations [status] [--json]        installed plugins, skills, rules, agents and MCP
switchboard customizations marketplace [query]      search the trusted multi-source marketplace
switchboard customizations install <name|owner/repo> [--client <id|all>]
switchboard customizations skill <enable|disable> <name> [client|all]
switchboard customizations sync-rule "<text>" [--client <id|all>]
switchboard automations [list] [--json]             list scheduled provider-agnostic automations
switchboard automations add "<name>" "<prompt>" [--every <minutes>] [--cwd <dir>]
switchboard automations run <id>                    execute an automation immediately
switchboard automations enable|disable|remove <id>
```

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

The About panel can export the portable part of Switchboard's own configuration to a
versioned JSON file and import it later: account registrations and active choices,
preferences, custom app launchers, and custom MCP server definitions. It does not contain
tokens, vendor credential files, MCP client sign-ins, or the environment values of a local
MCP server (an import keeps the ones this machine already has for the same server), and
it does not carry the lane pool, spend policies, lane tokens or notification hooks, which
stay on the machine that set them up. Import
validates the complete file and writes a pre-import recovery backup under
`%APPDATA%\Switchboard\backups` before replacing anything.
An in-app upgrade writes the same kind of importable backup immediately before its setup
program is launched; if that backup cannot be written, the upgrade does not start.

After installing, updates come from inside the app: it checks the [Releases](../../releases)
automatically, and the version number in the header becomes an Update button when a newer
version exists. The check asks GitHub without signing in, which GitHub allows 60 times an
hour for everything on your network together. When GitHub refuses it, for that limit or
anything else, the check asks again through the GitHub CLI (`gh`) if it is signed in, and
otherwise says when the limit lifts rather than that the check failed.

Releases are built by CI whenever master receives a `package.json` version that has not
been released yet; CI creates the `v<version>` tag on that commit. Pushing a matching tag by
hand still works, and a version that is already released is never built twice.

## Development

```
npm install
npm run icons
npm test
npm start
npm run catalog   # refreshes the MCP server catalogue in core/
npm run dist      # builds dist/Switchboard-Setup-<version>.exe
```

Tests that need scratch space take it from `tempDir` in `test-support/tempdir.js`, never
from `mkdtempSync` directly. `tempDir` removes what it made when the test process ends, and
`npm test` first runs `test-support/sweep-temp.js` to collect anything a killed process
left behind. Add any new fixture prefix to `PREFIXES` in that file; `test/tempdir.test.js`
reads the test sources and fails if one is missing. This is not housekeeping for its own
sake: these directories used to be left in `%TEMP%` forever, about 1,900 a day, and `%TEMP%`
is shared with every other program on the machine.

Tests also never touch the app's own data. `npm test` loads
`test-support/isolate-appdata.js` into every test process, which points `APPDATA` at a
throwaway folder before any test runs, so nothing a test writes through `dataDir()` can land
beside the real settings, accounts or usage cache, and no result depends on what that
folder holds on the machine running the suite. `test/isolation.test.js` fails if the script
stops loading it. A suite that writes app data should still set its own `APPDATA`, so it is
safe when run on its own with `node --test`.

`npm run catalog` regenerates `core/catalog-remote.json` from Docker's published MCP
catalogue over plain HTTPS. Docker itself is not needed, to regenerate it or to use it: the
result is data we ship, not a dependency. It keeps only servers reachable at an https
address and drops any that need an API key.

The core (`core/`, `bin/cli.js`) is plain Node with no Electron dependency; the tray shell
is a thin skin over it. `switchboard` is also a CLI: `status`, `accounts`, `add`,
`remove`, `use`, `color`, `detect`, `providers`, `doctor`, `quota`, `lanes`, `lane-token`,
`watch`, `notify`, `mcp`, `dry-run` and `run`. Running it with no command prints the same
list with a line each.

Everything the tray decides, the CLI decides the same way, because both call the same code
in `core/`. That is what makes a machine with no desktop usable: `switchboard lanes` edits
the same pool the Lanes tab edits, and `switchboard watch` runs the same quota watch the
tray runs on its five-minute timer.

`switchboard status` is the whole picture in one screen, and the only way to read the
machine from somewhere else: per tool, the variable and its value, every registered
account, which one new terminals will use, whether it is signed in, and how much of its
allowance is left with the reset times. `switchboard status --json` prints the same thing
for scripts.

`switchboard lanes` is the failover pool: `lanes` lists it in the order as set (and says
when "Switch automatically" ranks each tool's accounts by reset instead), `lanes add
<accountId> [--metered] [--budget <amount>]` appends one, `lanes order <id>...` reorders
it, `lanes remove <id>` takes one out, and `lanes budget <id> <amount|none>` sets or
clears what a metered lane may spend. A metered lane
with no budget is deliberately unselectable rather than unlimited, and the listing says so
rather than leaving it to be discovered by a run that skips it.

`switchboard lane-token <laneId>` mints a token a Claude lane can hand to automation, so
fleets authenticate with the token instead of opening the account folder's credential
file. Minting runs `claude setup-token` interactively in your terminal, inside the
lane's own account folder with any inherited token stripped, so it can never bind the
wrong account. Claude's own tool prints the minted token on screen, exactly as it does
when run by hand; copy it and paste it at the prompt Switchboard shows next. The token
is validated by a small real Claude run using it before it is stored, and a refused one
is not stored at all; a check that cannot reach the vendor stores the token anyway and
says it is unverified, so you can confirm it later with `--check`. It is kept in
`%APPDATA%\Switchboard\settings.json`, encrypted with a key derived from your Windows user
name, computer name and home folder. That keeps it unreadable in a copy of the file taken
to another machine or account, but not from a program running as you on this one, so
still treat that file as a secret. A token that cannot be decrypted (the computer was
renamed, say) is never handed out; Health says so and asks for a new one to be minted.
The minting login's identity is stamped into the stored entry,
so a lane folder later signed in to a different account stops receiving the token (and
Health says why) instead of quietly billing the account the token was minted for; a
folder with no readable sign-in identity refuses to mint until it is signed in.
`lane-token <laneId> --check` asks the vendor whether the
stored token is still honoured, and `lane-token <laneId> --remove` deletes it. The token
never appears in `lanes --json`, the tray, a config export, or anything Switchboard
itself prints; the one place it is ever visible is the mint step above, where the
vendor's own tool shows it to you once.
`switchboard dry-run --json --with-token` adds the token to the JSON for the calling
process only, and only when the caller passes the flag; a token the vendor has revoked
is marked dead, stops being emitted, and shows up as a Health warning saying to mint a
new one, while the lane itself keeps running on its folder sign-in. Uninstalling
Switchboard leaves `settings.json` behind in `%APPDATA%\Switchboard`, so remove lane
tokens first if the machine is being retired.

`switchboard watch` is the quota watch without the tray. `--once` takes a single pass, for
Task Scheduler or cron; without it, it stays running and takes a pass every five minutes,
or every `--interval <minutes>` if you would rather set the gap yourself. `--mode notify`
reports what "Tell me" would suggest (lane order, with the last-day exception below) and
`--mode auto` switches the machine default as "Switch automatically" does (soonest weekly
reset first), so the two can pick different accounts. Either overrides the
stored setting for that one command without writing it back, and `--json` prints each pass
as one line of JSON. Readings come through the same shared cache the tray fills, so running
both costs no extra requests for quota readings. Stored lane tokens are validated on the
same schedule, throttled to about one small Claude run per token per hour, and the tray
checks them on every pass even with the quota watch off, so a revoked token is noticed
within the hour rather than at the next failed run. An explicit `--check` is never
throttled and always asks the vendor immediately.

The watch moves the default before an account is completely out, not after. Two windows
decide it: the five hour session window and the weekly one. Where an account has a five
hour window, that is the one that stops work first in practice, because it is the smallest
and fills fastest, and it can sit at ninety odd percent while the weekly figure still looks
comfortable. So an account gives the machine default up as soon as either window passes
its mark (90 percent of the five hour window, 95 percent of the weekly one) and somewhere
better exists. An account with no five hour window (Ultra) is judged on the weekly one
alone.

Winning the default back is a stricter test than giving it up, deliberately. An account
that has been passed over takes the default back only once it has dropped clear to under
87 percent and 92 percent, and a reading anywhere in the gap between the two sets of marks
leaves the default exactly where it already is. Without that gap a single mark answered in
both directions, and the two usage sources do not always agree to the point: the live usage
endpoint and the Claude Desktop fallback can read a couple of percent apart for the same
account. A reading hovering around 90 percent then moved the default pass after pass, worst
of all on a lane pool, where the order pulls the default back to the first lane the moment
that lane looks roomy again, so it left and returned all day long. Three points is wider
than the two sources disagree by and small enough that an account which has genuinely
recovered is preferred again well inside one window.

The order decides which account is preferred; usage only decides which accounts are in the
running. One run is judged differently: a lane at 95 percent still works, so
`switchboard run` will happily use it and fall over to the next lane if it does hit the
wall. Pointing every terminal on the machine at an account with minutes left is the thing
these limits prevent.

On "Switch automatically", for a tool with lanes, the order is soonest weekly reset first.
A weekly window is use-it-or-lose-it: whatever is unspent when the week turns over is
forfeited, so the account that turns over first is spent first, and the least is lost
across all of them. Accounts of the same tool are ranked by when their week resets, however
far off that is, and the lane order only settles accounts that reset at the same time. Each
tool keeps the places its lanes were given, so the lane order still decides which tool a
run tries first, and a metered lane never moves, because pay-per-use quota does not expire.
Only an account that can take work right now is ranked: one that is signed out, whose
sign-in cannot be read, whose lane is cooling down, that has hit a limit, or whose usage
cannot be read follows the ones that can run, in the order as set. Ranked on its reading
alone, a signed-out account (which can still have a reading) took its tool's first place,
was skipped there, and the work went to whatever came next, a metered lane included. For
the machine default the bar is higher: only an account with room to take the default is
ranked, so the places ahead of a metered lane go to accounts that could actually take it.

A week that has not started yet (nothing used, so the vendor states no reset) or that has
turned over since the reading was taken counts as a whole week from its next reset, the
latest of all, so the account whose week was just used up hands over to the next soonest
straight away. A week under way whose reading states no reset goes after those whose
reading does, and before any week that has only begun, since it must end within seven
days. A reset once read is carried over to later fallback readings until it passes, so a
reading does not normally lose its reset; the case this covers is an account whose live
usage call has kept failing since its week turned over. Resets are compared to the minute,
because the vendor states them to the millisecond and two readings of the same reset
differ in the last digits; compared exactly, two accounts whose weeks end together would
trade the default every few minutes.

The tray and the Accounts page list each tool's accounts in the order the default is
picked in: those with room first, soonest reset first, then any account too close to a
limit to take the default, which the tray marks "nearly out". A pay-per-use (metered) lane
keeps its place in the lane order, so when every subscription is too full and the default
moves onto one, it is listed below the accounts marked "nearly out", and the Accounts page
says lane order picked it. Otherwise the account shown in use is
normally the first in the list; it can sit lower while a switch waits out the ten-minute
cooldown, and a default whose own usage or sign-in merely failed to read is left where it
is rather than moved on the absence of a reading, as on "Tell me". A
run uses the same ranking, but counts any account that can run at all, since a run that
hits the wall simply moves on to the next lane. `run` and `dry-run` rank on the last reading
the shared cache holds for each account, at any age, because a reset time stays true until
it passes, and read in full only the lanes they actually reach, so an account whose usage
call is failing is not asked on every run just to be ranked last. When a full reading shows
that an account ranked first cannot run after all, the rest of its tool is ranked again
before the run moves on, so the work does not slip past an account of the same tool that
has room. Because both commands rank on whatever the cache holds at the moment, `dry-run`
names the lane `run` would take with the same arguments and the same readings. They go by
the stored setting, so on a machine that runs `switchboard watch --mode auto` without
storing it, runs keep the order as set. A tool with only one subscription account has
nothing to rank: it follows its lane order, and the tray and the Accounts page say "set by
lane order" for it. Gemini CLI and Qwen Code report no usage at all, so runs take their
lanes in the order as set, and the watch has no reading to move their default on, so it
never moves it between subscription accounts. It moves it only onto the first ready
pay-per-use lane, and only when the account in use is signed out or has no subscription
lane of its own. The tray and the Accounts page say "no usage reading" for them. The app does not offer to switch
them by hand on "Switch automatically", so choose "Tell me" or "Do nothing" to change them.

On "Tell me", and on "Switch automatically" for Claude Code with no lanes configured, the
old rule applies: the order is the lane order as set, with one exception. When an
account's weekly window resets within the next day and still has room, the watch moves the
default there for that last day (on "Tell me" it suggests the move instead), and back once
the reset passes and lane order resumes. Soonest turnover wins when several qualify. With
no lanes configured there is no preferred account, so after that last day the default
stays where the move put it. A metered lane never qualifies, and the usual rules still
hold: only a signed-in account with a current reading and room on both windows is trusted
with the default, and a default whose own meter merely failed to read is left where it is
rather than bounced on a blip.

On "Tell me", the tray says each suggestion once instead of on every five-minute pass, and
"no account has room" once for each time it ends. A suggestion is said again only after the
account in use has changed, or after the watch setting is chosen again in the tray. A
switch the watch makes on "Switch automatically" is always reported. `switchboard watch`
prints every pass's decisions to its own output, which is its log, but what it sends to
the notification hooks follows the same once-only rule. What has already been said is kept
in `%APPDATA%\Switchboard\alerts.json`, so this holds across separate `watch --once` runs
too. It keeps two records: what went to the notification hooks, which
the tray and `switchboard watch` share so the hooks hear each thing once when both are
running, and what the tray showed on the desktop, so a terminal watch that told the hooks
first does not stop the desktop notification.

`switchboard notify` manages notification hooks for quota thresholds, lane switches and
exhaustion events. You can configure an incoming webhook URL (such as a Slack or Discord
webhook), a local shell command hook, and threshold percentages per usage window:

- `switchboard notify` shows current notification hooks and threshold settings.
- `switchboard notify --webhook <url|none>` configures or removes the webhook URL.
- `switchboard notify --command <cmd|none>` configures or removes the local command hook.
- `switchboard notify --threshold session=80 --threshold week=85` sets alert thresholds.
  Any window an account reports can be named (for example `week_fable` or `week_opus`);
  only `session` and `week` have a threshold by default.
- `switchboard notify --test` dispatches a test alert through configured hooks.
- `switchboard notify --json` outputs configuration and status in JSON.

Notifications are evaluated automatically during background quota passes (in both
`switchboard watch` and the tray's five-minute pass, whatever the watch is set to). When
an account crosses a threshold (default: 80% of the five hour session window, 85% of the
weekly window), Switchboard sends one alert for that reset period, even if a later reading
dips under the mark and back. A reading whose window has already reset raises none. The
tray also shows it as a desktop notification, with or without hooks. Account switches and "no account has room" go to the hooks too; suggestions
made on "Tell me" do not. Payloads include standard `text` (Slack) and `content`
(Discord) fields, along with structured JSON delivered to command hooks via stdin and the
`SWITCHBOARD_EVENT` environment variable. The same settings can also be configured from
the Notification hooks section under the About tab in the desktop app.

`switchboard run` is the execution broker. It walks the lanes in order (soonest weekly reset
first within each tool on "Switch automatically", as described above), takes the first
healthy one, and launches the vendor's own CLI with an environment scoped to that
lane's account. The tool's folder variable is set to that account's folder, and every
variable that would sign the tool in some other way, or send its requests and its bill
elsewhere, is removed: `ANTHROPIC_API_KEY` and Claude's token variables, `OPENAI_API_KEY`
and `CODEX_API_KEY`, `GEMINI_API_KEY` and `GOOGLE_API_KEY`, `GH_TOKEN` for Copilot, and
the like. An account signs in one way only, through its own folder, set up from
Switchboard with the vendor's own sign-in (Codex, for one, takes an API key there). The
same goes for a sign-in, a sign-out and a terminal opened on an account, and for whatever
the agent itself runs during the session. Health mentions any of these variables it finds
set for a tool you use here. It does not offer to remove them, because other programs
(`gh`, git and so on) may rely on the same ones. Switchboard's own
flags can go anywhere on the line; everything after a `--` goes to the tool untouched.

Your arguments are passed through as you wrote them, with one addition: on a Claude lane
it puts `--session-id` in front of them, so that if the run has to move accounts later it
knows which conversation to take with it. If your own command line already names the
session, with `--resume <id>` or a `--session-id` of your own, it adds nothing and uses
your name instead (either spelling, `--resume <id>` or `--resume=<id>`), so your session
moves between accounts just the same. `--continue`
and `--fork-session` name no session Switchboard can find, so a run using them is not
carried. `--provider` and `--account` narrow the pool, `--no-fallback` keeps it to one
lane, and `--quiet` moves Switchboard's own lines to standard error so a caller can parse
the tool's output. `--spec <file>` supplies a command line per tool instead, for a caller
that cannot know in advance which tool it will get; the session name is added to its
Claude command line in the same way.

Lanes can sit in any order, whatever each caller supports. A caller that can only drive
some tools says which, and lanes for the rest are left out before anything is chosen, for
the first pick and for every fallback after it. A spec says so by itself: the tools it
holds a command line for are the tools the run may use. `--harnesses claude,codex` says
the same thing without a spec, which is what `dry-run` needs, since a caller usually asks
which lane it will get before it has written one. `dry-run` reads `--spec` too, only for
the tools it covers, so its answer is always the lane `run` would take with the same
arguments and the same readings. A narrowed `dry-run --json` answer carries a `harnesses` field listing the
tools it was narrowed to, because a version from before this existed ignores the flag
and answers for every lane: a caller that named its tools and does not get them back
knows the order still matters on that machine. A run says once which lanes it left out and
why, so a lane that never gets work from that caller does not look broken. Because a lane
the caller cannot drive is left out before anything is chosen, the order never has to be
arranged around a particular caller.

Choosing a lane reads each account only when its lane comes up, and stops at the first lane
with room, for `dry-run`, for the first pick of a run and for every fallback. A lane further
down cannot change that answer, and reading it can be slow: a usage reading older than five
minutes means asking the vendor, and Antigravity's means starting its CLI twice. Reading
every lane first would make an answer about the top lane wait many seconds on a lane it
was never going to pick, long enough for an automated caller with a deadline to give up.
Every account is still read when no lane has room, because the last resort, a lane whose
usage could not be read, is only chosen once all of them have been seen. On "Switch
automatically" a tool's accounts are ranked the first time the walk reaches one of its
lanes, from the last reading the shared cache holds for each (the reset time is all
ranking needs, and it stays true until it passes), so ranking never asks the vendor and a
tool the walk never reaches is never looked at. Readings come from the shared cache the
tray fills on its five-minute pass, including its Antigravity reading, so a check that
does reach Antigravity normally finds one there instead of starting the CLI itself.

A prompt piped into `switchboard run` reaches every lane the run lands on, not only the
first. An automated caller hands its prompt over on standard input, and the first tool
reads that pipe to its end, so a tool on the next lane that merely inherited it would start
with no question at all. So the input is recorded as it arrives and replayed to a lane the
run falls back to. It is passed on while it is still arriving and never waited for, and
the process is not kept alive by it, so a caller that leaves its pipe open cannot hang a
run. Only a complete prompt is replayed: a caller feeding turns down a pipe it keeps open
would otherwise have every earlier turn run twice, so a lane it falls back to gets what
arrives from then on. Input past 8 MB is still delivered to the lane that is running and
is simply not kept for a second one.

When a lane takes over part-way with a handoff to read, where it is told about the
handoff depends on how the caller gave its command line and its prompt:

- With a spec and a piped prompt, a sentence offering the handoff follows the replayed
  prompt on standard input. The command line is the wrong place: after Claude's
  list-valued flags the sentence is swallowed as one more tool name, and Codex and
  Antigravity reject a stray argument outright. The sentence is worded for a tool that
  also has the request in front of it: the handoff opens with the first thing that
  session was ever asked, which in a conversation several requests long is not what is
  being asked now, so the request is said to be what counts and the handoff is offered as
  the first tool's notes. Only a handoff this run derived is offered this way. It is never
  added to input that is a stream of JSON messages, which a bare sentence would corrupt;
  the run says so, and the lane starts from the request alone.
- With a spec and nothing piped at all, a lane of a different tool gets the pointer added
  to the end of its command line, because there is nowhere else to put it. A lane of the
  same tool does not: it runs the same spec, which already holds the request as an
  argument, and Codex refuses a second one outright. Input that is still arriving or too
  big to keep is not "nothing", so it gets no pointer on the command line either. In both
  cases the run says the handoff went unused.
- Without a spec, the lane taking over is started with just the one sentence pointing at
  the handoff, because your arguments were written for the first tool or already hold a
  prompt. The exception is a command line that resumes a conversation by name on the same
  tool: it is kept as it is, since it holds the request being asked now, and the handoff
  would only offer that conversation's first request.

A person at a keyboard is unaffected by the piping: their tool keeps the real terminal,
and none of it applies unless both the input and the output are something other than a
terminal.

A fallback that changes tool is always announced, as
`[switchboard] Cross-provider failover: claude to codex (lane <id>).`, because the new
tool does not hold the conversation the old one had and a caller that handed over one
process has no other way to find out. It is also said when only the vendor behind a lane
changes. Automated callers match on that line; under `--quiet` it is on standard error
with Switchboard's other lines.

A run that ends on a provider limit, a provider server error, or a sign-in the vendor
refused, drops that lane and starts again in the next healthy one. An ordinary non-zero
exit is still reported and left alone, because guessing would move work to another account
on any old failure.

The three are read apart, because they do not mean the same thing. A limit means the
account is real and merely spent, and a server error (a 500, 502, 503, 504 or 529 reply,
or the vendor saying it is overloaded) means the vendor failed part-way: either way the
work started, and between two lanes of the same tool it is carried across so the next
account picks it up mid-task. A refused sign-in means the run never began, so there is no
new work to carry or hand off: the next lane is given whatever the refused one was given
(a conversation carried into it, or the handoff it was pointed at), and when the next lane
is back on the tool whose work it is, the conversation itself is carried from the last
lane that ran. A handoff you wrote yourself is only ever given to a different tool, so it
is not passed back to the tool whose work it is. Otherwise the command simply starts there
as if it were the first. When a handoff is written after a lane that itself started from
one, the new handoff keeps the original objective and adds that lane's work to what was
already recorded. A refused sign-in and a server error are both said out loud with
the account named. That matters most for the sign-in: a spent lane returns by itself when
its window resets and a broken one does not, so without that line every later run would
quietly start one lane lower and nobody would know a lane had gone.

All three readings are deliberately narrow, and they are taken from the tool's own output.
A refused sign-in is recognized from specific phrases, never from a lone word like
unauthorized, because a run's output includes what the agent itself printed and an agent
discussing an unauthorized request in somebody else's code must not be mistaken for a lane
that cannot log in. Output is only ever classified after a non-zero exit, which keeps the
cost of a wrong reading to a run that had already failed. They are checked in order:
limit, then refused sign-in, then server error. Where a limit and a sign-in failure both
appear, it is read as a limit: an exhausted account is not a broken one, and sending
somebody to repair a sign-in that was never at fault is the worse mistake.

Classification reads the tool's standard output as well as its standard error, because
that is where a harness actually reports both of these. It is captured only when
Switchboard's own output is not a terminal, so an interactive run at a keyboard is
reported rather than classified, on the same reasoning as a limit notice: a person is
already reading it.

Between two Claude accounts the retry is a real continuation. Claude Code keeps each
session as a file under the account folder it ran in, and that file is portable, so
Switchboard copies the session into the incoming account and resumes it there. The new
account sees everything the spent one had established and picks the work up mid-task.
This works whoever named the session, Switchboard or your own command line. The spent
account keeps its own copy. A copy the incoming account already holds is never
overwritten, with one exception that loses nothing: an older copy of the very same
conversation (identical as far as it goes, just shorter), which is brought up to date. An
identical copy is simply resumed.
Switchboard reads none of it: this is a file copy, not a summary, and nothing is sent
anywhere.

The same happens before any Claude lane resumes a conversation by name
(`--resume <id>`), not only on a failover. A caller that keeps one conversation going over
many requests, such as a chat bot answering a thread, can land on a different account each
time, and the conversation lives in whichever account it last ran in. So Switchboard looks
for that session in every registered Claude account folder and, when another account has
gone further with it, brings that copy over first and says so. A copy that differs from
the others is a conversation of its own and is left alone.

Every part of that is allowed to fail without ending the run. A spent lane that left no
session, a destination holding a different conversation under the same name, an
unreadable folder: each falls back to starting the tool from your command line as given,
and the run says which happened. That is a fresh start, unless your own command line
resumes a session by name, in which case it resumes whatever that account holds under it. Carrying only works between Claude accounts, because Codex files its sessions
differently and that has not been proven the same way.

Every other hop gets a written handoff instead, because a session file means nothing to
another vendor and Codex sessions have not been shown to move between accounts at all.
The spent session already wrote the handoff without being asked: an agent narrates its
work as it goes, so the text of its turns holds the objective it was set, what it got done
and the decisions it took along the way. Switchboard lifts exactly that out of the
transcript and writes it as a handoff document under `%APPDATA%\Switchboard\handoffs`,
under a name derived from the working directory, then tells the next tool to read that
file and continue from its next actions. No summarising model is involved, so nothing here
can invent a decision that was never made, and it costs nothing.

Claude and Codex are both readable this way, so either can hand over to the other or to a
second account of its own. The two are found differently. Switchboard names a Claude
session itself, so it knows the exact file, and where a caller built its own command line
and named the session there (`--session-id` or `--resume` with an id), the name is read
from that command line. Codex has no such flag, so its session is recognised afterwards by
the working directory it recorded and by having been written during this run; a session
left over from earlier work in the same directory is ignored rather than handed over as
though it were current.

A handoff you wrote yourself is used exactly as it is and never overwritten, on the
grounds that it may be better than anything derivable and is not Switchboard's to replace.
One that Switchboard derived is a different thing, and it says so just under its title,
with the run it belongs to. It describes that run and nothing else, so it is removed when
the run ends, and one found from an earlier run (a run that was killed before it could
tidy up) is replaced or removed rather than followed, so an unrelated later run is never
pointed at it. A same-tool hop only ever uses a handoff its own run derived, and so does a
caller with a spec that piped its prompt; a hop to another tool otherwise points at a
handoff you wrote yourself too. Where there is nothing to write from, because the spent
lane was not a Claude or Codex session or died before saying anything, it says a handoff
is missing rather than inventing one.

Moving work to a different tool asks first, unless you passed `--yes`, whether or not
there is a handoff, as soon as any lane has actually run, including when the hop passes a
lane whose sign-in was refused on the way. It can only ask a person: with no terminal on
standard input there is nobody to answer, so without `--yes` the run is not moved to
another tool, says that `--yes` is needed, and ends with a failing exit. A hop between two
lanes of the same tool goes ahead without asking, and so does a hop after the first lane's
sign-in was refused, because nothing had started yet.

Two limits are worth stating plainly. Only Claude and Codex sessions can be read, so a hop
away from any other tool (Gemini, Qwen, Antigravity and the rest) still starts fresh;
adding one is a table entry in `core/transcripts.js` and a session layout somebody has
actually checked. And the document is capped at 4 KB. A long run is recorded from its most
recent work backwards, and a long first request keeps its opening, each trimmed until the
document fits, and the run says when it had to do that. The document also gets the
redaction of common API-key shapes.

A run never uses a stored lane token; the launched tool authenticates with the account
folder's own sign-in. `switchboard dry-run` answers which lane would be picked without
launching anything.
