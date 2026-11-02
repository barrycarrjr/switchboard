# CLI Command Reference

*(Stub: `status`, `accounts`, `add`, `remove`, `use`, `detect`, `providers`, `doctor`,
`quota`, `dry-run` and `run` are still to be written up here. Run `switchboard` with no
arguments for their flags in the meantime.)*

Everything below works with no desktop session and no Electron: `bin/cli.js` imports only
`core/`, and reads and writes the same files the tray app does.

## `switchboard color`

The color an account is shown in, in the window and the tray.

```
switchboard color <id> <hex|none>
switchboard color --from-t3
```

- A color is a hex value, `2563eb` or `abc`, stored as `#` plus six lowercase digits.
  Leave the `#` off when typing it: PowerShell and bash both read `#` after a space as the
  start of a comment, so the color never reaches Switchboard. A quoted `'#2563eb'` works
  too. Anything else is refused and nothing changes. `none` clears it.
- `--from-t3` reads T3 Code's `~/.t3/userdata/settings.json` and gives each registered
  account the accent color of the T3 Claude or Codex instance on the same config folder.
  It prints each account it set. A T3 instance with no folder set is skipped.
- `switchboard accounts` prints an account's color at the end of its line.

## `switchboard lanes`

The failover pool `switchboard run` chooses from, in the order as set. The first healthy lane
gets the work. With the watch set to "Switch automatically", the subscription accounts of a
tool whose usage Switchboard reads (Claude Code, Codex) are taken soonest weekly reset first
instead. The order as set decides everything else: which tool
comes first, where a metered lane sits, accounts that reset at the same time, and accounts that
cannot be ranked. `lanes` says so when that applies.

```
switchboard lanes [--json]
switchboard lanes add <accountId> [--metered] [--budget <n>]
switchboard lanes remove <laneId>
switchboard lanes order <laneId>...
switchboard lanes budget <laneId> <amount|none>
```

- `add` appends at the lowest priority. On "Switch automatically" that position only settles
  ties for a Claude Code or Codex subscription lane: those are taken soonest weekly reset
  first, so a new one whose week resets soonest is used first. Account ids come from `switchboard accounts`. The
  harness and the vendor behind it are derived from the account, not supplied: a lane on a
  Claude account is `claude / anthropic`, and `--provider` accepts either name.
- A second lane naming the same account on the same billing is refused. Selection walks the
  pool in order, so the first one would answer every time and the second could never be
  reached.
- `order` accepts a partial list; lanes left out keep their relative order at the end. An id
  that names no lane is refused before anything is written, so a typo cannot silently
  reorder nothing.
- `budget` applies to metered lanes. `none` clears it, which blocks the lane: a metered lane
  with no budget is unselectable rather than unlimited.

Exit code 1 on anything refused.

## `switchboard watch`

The quota watch, without the tray. It reads every account a decision could name, then either
reports the switch of the machine default or performs it. Running processes are never
touched, and quota that cannot be read is never acted on.

```
switchboard watch [--once] [--interval <minutes>] [--mode notify|auto] [--json]
```

- `--once` takes one pass and exits, which is the shape Task Scheduler and cron want.
  Without it the command stays running and takes a pass every `--interval` minutes,
  default 5. A pass that fails is reported and the next one still runs.
- `--mode` overrides the stored `quotaWatch` setting for this command only and is never
  written back, so a scheduled task cannot quietly change what the desktop app does. With
  no `--mode` and the setting off, the command explains and exits 1.
- `notify` prints what "Tell me" would suggest, including the `switchboard use` command
  that would do it. It follows the lane order (with the last-day exception), so it can
  name a different account from `auto`, which picks as "Switch automatically" does,
  soonest weekly reset first. `auto` performs the switch, after re-reading the target's sign-in state: the reading
  that chose it can be minutes old, and a sign-out in between would point every new
  terminal at an account that cannot work.
- `--json` prints one object per pass: `{ at, mode, decisions }`.
- Readings go through the shared quota cache, so a watch running every five minutes leaves
  readings behind for `dry-run` rather than competing with it for the same rate limit.

Changing the machine default is a Windows facility (`setx`, user-scope environment). On any
other platform the watch says so and reports rather than pretending to switch; `switchboard
run` still routes by lane, because it scopes the account to the child process instead.

## `switchboard t3`

Points T3 Code environments (a WSL distro, or another machine reached with ssh) at the
Claude accounts the lease broker lends, so T3 there needs no Claude sign-in of its own.

```
switchboard t3 setup [wsl:<distro>|ssh:<host> ...] [--all] [--replace-symlink] [--no-proof] [--json]
switchboard t3 status [--saved] [--json]
switchboard t3 sign-in <wsl:<distro>|ssh:<host>>
switchboard t3 forget <wsl:<distro>|ssh:<host>>
```

- A bare name is a WSL distro when one by that name exists, otherwise an ssh host (an alias
  from `~/.ssh/config` works). With no target, every WSL distro is set up. `--all` sets up
  again every environment set up before.
- ssh runs with `BatchMode=yes`: the machine must accept a key sign-in, because a password
  prompt cannot be answered on a pipe. Everything sent to the target (the key included)
  travels inside a script on stdin, never on a command line.
- On the target it checks Claude Code, curl, node or python3, the GNU tools the scripts use
  (`base64`, `sha256sum`, `mktemp`, `timeout`, `cp`), that T3 has run there, and that the
  broker answers. Then it writes, in this order: the client key (kept when the broker
  already accepts the one there; otherwise the environment gets its own key labelled
  `T3 <name>`, which `gateway provision-client` never reuses for this machine),
  `~/.config/switchboard/broker-url` for an ssh machine (or `broker-port` inside WSL when
  the port is not 8318), `~/.local/bin/switchboard-lease`, one
  `~/.local/bin/t3-claude-<account>` per account the broker can lend, T3's quota hub key
  (kept equal to the machine's client key), and last T3's `settings.json`.
- T3 gets one provider per account (`Claude - <label> (Switchboard)`, in the account's
  color) and one "any account" provider that lets the broker pick the account with the most
  room, plus the Switchboard quota hub under Usage providers (moved, not duplicated, when the
  broker's address changes). New providers leave T3's config-folder field empty, so Claude
  there reads the same settings and MCP servers as the plain `claude` command; the account
  comes from the lent token. Entries made by hand before are adopted with their ids, names,
  colors and config folders, so conversations on them keep working, and a hand-written
  wrapper that differs is copied to `<name>.before-switchboard-<time>` before it is
  replaced. Nothing is removed or turned off; a Claude entry on the machine's own sign-in is
  listed as left alone. The previous settings file is kept as
  `settings.json.before-switchboard-<time>`, a settings file that cannot be read is never
  overwritten, and if T3 saved the file while the setup ran it is planned again.
- The proof sends one short message per account through its wrapper on the target (Haiku),
  from the home folder, and reports which answered. An account out of allowance at that
  moment is reported as such and does not make the environment fail. `--no-proof` skips it.
- A symlinked `switchboard-lease` (a developer's link into a checkout) is left alone and
  named; `--replace-symlink` installs a copy instead.
- Codex and Antigravity get the same entries the main machine has: one Codex entry per Codex
  account Switchboard knows (the account whose folder here is `.codex` uses `~/.codex` there;
  each other one gets its own sign-in folder under `~/.codex-t3`, which T3 keeps apart as that
  entry's shadow home), and, when this machine's T3 has Antigravity turned on or Switchboard
  has an Antigravity lane, one enabled Antigravity entry. An entry already there, on or off,
  is left as it is; a hand-made Codex entry on another folder is listed as left alone. Neither can be lent: OpenAI and Google offer no long-lived
  subscription token, and copies of a sign-in log each other out. So each account is signed in
  once per machine, and the setup asks each machine which are already done and lists only the
  missing ones; a Codex state it cannot read is shown as unknown, not as signed out. For Codex, `switchboard t3 sign-in <target>` runs `codex login --device-auth`
  on that machine for each account still signed out (making its folder first), in this terminal: Codex shows a link and
  a code to enter in your browser (device code sign-in must be on in ChatGPT, under Settings,
  Security). Antigravity's sign-in belongs to T3 itself, kept apart from the `agy` command's,
  so it is done in T3: pick the environment, then Settings, Providers, Antigravity (Install
  first where T3 has not installed its Antigravity program there yet), then Sign in; T3 shows
  a link to open in your own browser. Codex's usage reaches T3 through the Switchboard hub;
  T3 reads Antigravity's itself once signed in. Grok and Junie need their own sign-in on each
  machine where they are used.
- An ssh machine needs the gateway on scope `lan`. The scope is never changed from here; a
  narrower one is reported with the command that widens it.
- A target that never answered, or refused before anything was written, is not remembered.
  A remembered one that does not answer keeps its last result, with the failed attempt and
  its age shown beside it.
- `t3 status` lists each environment as ready, out of date (its lease wrapper is older than
  this Switchboard, an account was added, or the broker's port or address moved) or not
  working (the last setup or proof failed, or its key was revoked), each with its age. It asks
  every machine at once which Codex and Antigravity sign-ins are done (read-only) and saves the
  answer with its time, so `--saved` and the Gateway tab show it afterwards with its age; a
  machine that does not answer keeps its last reading and is marked as not reached, with the
  reason. A Codex state it cannot read keeps what was known before. When there is nothing to
  ask (no Codex account, Antigravity not in use) no machine is contacted. `--saved` skips the
  asking. Health warns only about environments that are not working or out of date, not about
  sign-ins still to do.
  At start the tray refreshes the wrapper files of an environment
  whose wrapper is out of date, and only those: it never issues a key (a revoked key stays
  revoked), never writes T3's settings and never proves. `t3 forget` stops listing one;
  nothing on the machine is changed. The Gateway tab's T3 Code Environments card does all of
  this in clicks.
- The lease wrapper itself passes `--version` and `--help` straight to claude without
  borrowing (T3 checks each provider with `--version` every few minutes), refuses to run
  claude when a lease carries no credential, and reports a session ended by a stop signal.
