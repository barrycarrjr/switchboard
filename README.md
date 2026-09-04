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

- An account is a vendor config folder. Switchboard registers labels and folder paths,
  nothing else. Four tools qualify, because each has a variable that moves its whole
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
- A desktop app follows the same switch where the app can. Claude Desktop keeps each
  account in its own data folder, so the Apps tab names the account its Launch button
  will open (the one that is the machine default right now) and puts the others behind
  the arrow, exactly as the terminal buttons do. Switchboard finds the standard folder
  and any `~/.claude-desktop*` folder the app has run in, names each one after the
  registered account it is signed in as, and lets you add a folder kept anywhere else.
  Signing in stays the app's own job, and an app that keeps one login per machine
  (Antigravity), switches accounts inside itself (T3 Code), or has no account at all
  (LM Studio) keeps its plain button.
- Account switching and usage display store no secrets. Quota display reads each
  account's own credentials file transiently and calls the vendor usage endpoint; that
  token is never persisted or logged. The one secret Switchboard does keep is a lane
  token you mint yourself for automation, held in plain text in its own settings file.
  See `lane-token` under Development.
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
- Installs and updates delegate to vendor mechanisms: winget, npm, pip, or the vendor's
  own install script. A tool with no such command for Windows is detected but not
  installed, and links to the vendor site instead. Nothing is bundled.
- Execution lanes are the failover pool. `switchboard run` picks the first healthy lane,
  launches the vendor's own CLI pinned to that account, and, when a run stops on a
  provider limit or cannot sign in at all, drops that lane and starts the command again in
  the next one. Between
  two Claude accounts the conversation goes with it: the session is copied into the
  incoming account and resumed there, so the new account carries on from where the spent
  one stopped instead of starting over. Every other combination gets a handoff instead:
  Switchboard writes one from what the spent session said as it worked, and tells the
  next tool to read it. Claude and Codex can each hand over to the other, and to another
  account of their own. A handoff you wrote yourself is used as it is and never
  overwritten.

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
- A chip shows four states: not registered, registered and signed in, registered but not
  signed in, and plain registered for a client that cannot report its sign-in state. A
  tick that meant "signed out and broken" would be worse than no tick, so that last case
  says what it knows rather than guessing.
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

The About panel can export the portable part of Switchboard's own configuration to a
versioned JSON file and import it later: account registrations and active choices,
preferences, custom app launchers, and custom MCP server definitions. It does not contain
tokens, vendor credential files, or MCP client sign-ins, and it does not carry the lane
pool, spend policies or lane tokens, which stay on the machine that set them up. Import
validates the complete file and writes a pre-import recovery backup under
`%APPDATA%\Switchboard\backups` before replacing anything.
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
is a thin skin over it. `switchboard` is also a CLI: `status`, `accounts`, `add`,
`remove`, `use`, `detect`, `providers`, `doctor`, `quota`, `lanes`, `lane-token`, `watch`,
`dry-run` and `run`. Running it with no command prints the same list with a line each.

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
file. Minting runs `claude setup-token` interactively in your terminal, inside the
lane's own account folder with any inherited token stripped, so it can never bind the
wrong account. Claude's own tool prints the minted token on screen, exactly as it does
when run by hand; copy it and paste it at the prompt Switchboard shows next. The token
is validated by a small real Claude run using it before it is stored, and a refused one
is not stored at all; a check that cannot reach the vendor stores the token anyway and
says it is unverified, so you can confirm it later with `--check`. It is kept in plain
text in `%APPDATA%\Switchboard\settings.json`, so treat that file as a secret.
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
reports what it would do and `--mode auto` switches the machine default, overriding the
stored setting for that one command without writing it back, and `--json` prints each pass
as one line of JSON. Readings come through the same shared cache the tray fills, so running
both costs no extra requests for quota readings. Stored lane tokens are validated on the
same schedule, throttled to about one small Claude run per token per hour, and the tray
checks them on every pass even with the quota watch off, so a revoked token is noticed
within the hour rather than at the next failed run. An explicit `--check` is never
throttled and always asks the vendor immediately.

The watch moves the default before an account is completely out, not after. Two windows
decide it: the five hour session window and the weekly one. The five hour window is the one
that stops work first in practice, because it is the smallest and fills fastest, and it can
sit at ninety odd percent while the weekly figure still looks comfortable. So an account
gives the machine default up as soon as either window passes its mark (90 percent of the
five hour window, 95 percent of the weekly one) and somewhere better exists.

Winning the default back is a stricter test than giving it up, deliberately. An account
that has been passed over takes the default back only once it has dropped clear to under
87 percent and 92 percent, and a reading anywhere in the gap between the two sets of marks
leaves the default exactly where it already is. Without that gap a single mark answered in
both directions, and the two usage sources do not always agree to the point: the live usage
endpoint and the Claude Desktop fallback can read a couple of percent apart for the same
account. A reading hovering around 90 percent then moved the default pass after pass, worst
of all on a lane pool, where lane order pulls the default back to the top lane the moment
that lane looks roomy again, so it left and returned all day long. Three points is wider
than the two sources disagree by and small enough that an account which has genuinely
recovered is preferred again well inside one window.

Lane order still decides which account is preferred; usage only decides which accounts are
in the running. One run is judged differently: a lane at 95 percent still works, so
`switchboard run` will happily use it and fall over to the next lane if it does hit the
wall. Pointing every terminal on the machine at an account with minutes left is the thing
these limits prevent.

The watch also spends quota that is about to be lost. A weekly window is use-it-or-lose-it:
whatever is unspent when the week turns over is forfeited. So when any account's weekly
window resets within the next day and still has room, the default moves there for that last
day, even though the preferred account is perfectly healthy, and moves back on its own once
the reset passes and lane order resumes. The return is the lane pool's doing: with no lanes
configured there is no preferred account, so the default simply stays where the last switch
put it, as it always has. Soonest turnover wins when several qualify. A metered lane never
qualifies, because pay-per-use quota does not expire, and the usual rules still hold: only a
signed-in account with a current reading and room on both windows is trusted with the
default, and a default whose own meter merely failed to read is left where it is rather than
bounced on a blip.

`switchboard run` is the execution broker. It reads where every lane stands, takes the
first healthy one, and launches the vendor's own CLI with an environment scoped to that
lane's account: the account's own folder and nothing inherited from the calling shell that
could bill somebody else. Your arguments are passed through as you wrote them, with one
addition: on a Claude lane it puts `--session-id` in front of them, so that if the run
has to move accounts later it knows which conversation to take with it. If your own
command line already steers the session, with `--resume`, `--continue`, `--fork-session`
or a `--session-id` of your own, it adds nothing and carries nothing; that session is
yours. `--provider` and
`--account` narrow the pool, `--no-fallback` keeps it to one lane, and `--quiet` moves
Switchboard's own lines to standard error so a caller can parse the tool's output.
`--spec <file>` supplies a command line per tool instead, for a caller that cannot know
in advance which tool it will get; a fallback to a tool the file says nothing about is
refused rather than guessed at.

A run that ends on a provider limit, or on a sign-in the vendor refused, drops that lane
and starts again in the next healthy one. An ordinary non-zero exit is still reported and
left alone, because guessing would move work to another account on any old failure.

The two are read apart, because they do not mean the same thing. A limit means the account
is real and merely spent: the work started, and between two lanes of the same tool it is
carried across so the next account picks it up mid-task. A refused sign-in means the run
never began, so there is no session to carry and no handoff to write, and the command
simply starts on the next lane as if it were the first. Only the sign-in failure is said
out loud with the account named, because a spent lane returns by itself when its window
resets and a broken one does not: without that line, every later run would quietly start
one lane lower and nobody would know a lane had gone.

Both readings are deliberately narrow, and they are taken from the tool's own output. A
refused sign-in is recognised from specific phrases, never from a lone word like
unauthorized, because a run's output includes what the agent itself printed and an agent
discussing an unauthorized request in somebody else's code must not be mistaken for a lane
that cannot log in. Output is only ever classified after a non-zero exit, which keeps the
cost of a wrong reading to a run that had already failed. Where a limit and a sign-in
failure both appear, it is read as a limit: an exhausted account is not a broken one, and
sending somebody to repair a sign-in that was never at fault is the worse mistake.

Classification reads the tool's standard output as well as its standard error, because
that is where a harness actually reports both of these. It is captured only when
Switchboard's own output is not a terminal, so an interactive run at a keyboard is
reported rather than classified, on the same reasoning as a limit notice: a person is
already reading it.

Between two Claude accounts the retry is a real continuation. Claude Code keeps each
session as a file under the account folder it ran in, and that file is portable, so
Switchboard copies the session into the incoming account and resumes it there. The new
account sees everything the spent one had established and picks the work up mid-task. The
spent account keeps its own copy, and a session the incoming account already holds is
never overwritten. Switchboard reads none of it: this is a file copy, not a summary, and
nothing is sent anywhere.

Every part of that is allowed to fail without ending the run. A spent lane that left no
session, a destination that already has one, an unreadable folder: each falls back to
starting the tool fresh, which is what used to happen every time, and the run says which
happened. Carrying only works between Claude accounts, because Codex files its sessions
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
session itself, so it knows the exact file. Codex has no such flag, so its session is
recognised afterwards by the working directory it recorded and by having been written
during this run; a session left over from earlier work in the same directory is ignored
rather than handed over as though it were current.

A handoff you wrote yourself is used exactly as it is and never overwritten, on the
grounds that it may be better than anything derivable and is not Switchboard's to replace.
Where there is nothing to write from either, because the spent lane was not a Claude
session or died before saying anything, it says a handoff is missing rather than inventing
one. In every case it asks before going ahead, unless you passed `--yes`.

Two limits are worth stating plainly. Gemini and Qwen lanes cannot be read at all yet, so
a hop involving either still starts fresh; adding one is a table entry in
`core/transcripts.js` and a session layout somebody has actually checked. And the document
is capped at 4 KB, as it always has been, so a long run is recorded from its most recent
work backwards and the run says when it had to do that. The document is written through
the same writer as before, which means it still gets the size limit and the redaction of
common API-key shapes.

A run never uses a stored lane token; the launched tool authenticates with the account
folder's own sign-in. `switchboard dry-run` answers which lane would be picked without
launching anything.
