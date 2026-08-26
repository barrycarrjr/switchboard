# CLI Command Reference

*(Stub: `status`, `accounts`, `add`, `remove`, `use`, `detect`, `providers`, `doctor`,
`quota`, `dry-run` and `run` are still to be written up here. Run `switchboard` with no
arguments for their flags in the meantime.)*

Everything below works with no desktop session and no Electron: `bin/cli.js` imports only
`core/`, and reads and writes the same files the tray app does.

## `switchboard lanes`

The failover pool `switchboard run` chooses from, in priority order. The first healthy lane
gets the work, so the order is the policy.

```
switchboard lanes [--json]
switchboard lanes add <accountId> [--metered] [--budget <n>]
switchboard lanes remove <laneId>
switchboard lanes order <laneId>...
switchboard lanes budget <laneId> <amount|none>
```

- `add` appends at the lowest priority. Account ids come from `switchboard accounts`. The
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
- `notify` prints what it would do, including the `switchboard use` command that would do
  it. `auto` performs the switch, after re-reading the target's sign-in state: the reading
  that chose it can be minutes old, and a sign-out in between would point every new
  terminal at an account that cannot work.
- `--json` prints one object per pass: `{ at, mode, decisions }`.
- Readings go through the shared quota cache, so a watch running every five minutes leaves
  readings behind for `dry-run` rather than competing with it for the same rate limit.

Changing the machine default is a Windows facility (`setx`, user-scope environment). On any
other platform the watch says so and reports rather than pretending to switch; `switchboard
run` still routes by lane, because it scopes the account to the child process instead.
