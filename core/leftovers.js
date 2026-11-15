// Stopping what a vendor CLI started and then left running.
//
// Reading Antigravity's usage means starting its CLI, and every start of that CLI also
// starts each MCP server in its lists, as a process of its own. When the CLI ends it does
// not stop them. Most notice that nobody is listening any more and end a second or two
// later. One that does not stays for good, and a usage check runs every five minutes and
// starts the CLI twice. On one machine a single server of that kind had grown to 984
// copies, 3,935 processes, in under two days (found 2026-11-14).
//
// Measured the same day on another machine, with version 1.5.9 of the CLI and four servers
// that do end by themselves: one start brought up 20 other processes, 11 of them were
// still running when the CLI had gone, and one of those started 2 more a second and a
// half later that never ended. The CLI has no flag and no setting that starts it without
// its servers (every name tried with --settings was refused as unknown, and its documented
// settings list has none), and its own bug tracker says print mode starts a server even
// when the list marks it as switched off. So nothing Switchboard passes can prevent this,
// and whoever starts the CLI for a reading has to stop what that reading started.
//
// What makes that awkward on Windows:
//
// - Ending the CLI does not end what it started, and Node only ever ends the one process
//   it started itself.
// - `taskkill /T` follows a tree down from a process that is still running. By the time
//   the CLI's answer is in, the CLI has ended, and the tree has no top to start from.
// - What survives is the note every process carries of which process id started it. The
//   id of an ended process can be given to a new one, though, so the id alone proves
//   nothing. A process counts as started by another only when it was created while that
//   other one is known to have held the id.
// - Stopping by id has the same trap, at the worst moment: these servers are ending by
//   themselves at exactly the time they are being stopped. So each one is opened first,
//   which keeps its id from being reused, then checked to be the process that was listed,
//   and only then ended.
//
// Node cannot list processes or open one, so both jobs go to one Windows PowerShell
// process that is started alongside the CLI, which makes it ready by the time the CLI
// ends. Everything that decides what counts as a leftover is here in plain functions, so
// it is tested without starting anything.
//
// Elsewhere there is no note to follow once a parent has ended, because orphans are handed
// to the init process. There the CLI is started as the leader of a process group of its
// own, and the group is what gets stopped.
//
// Limits, stated rather than hidden. A process that cuts itself loose (starts a copy of
// itself and ends at once, or leaves its group) is not followed. And when PowerShell
// cannot be started or does not answer in time, nothing is stopped and the outcome says
// the check did not happen, rather than claiming a clean machine.
import { spawn } from 'node:child_process';

/** Microseconds between 1601-01-01, where Windows starts counting, and 1970-01-01. */
const WINDOWS_EPOCH_US = 11644473600000000n;

/**
 * A Windows file time (100 nanosecond steps since 1601, as text) in microseconds since
 * 1970. It stays a BigInt until the end, because the raw count is larger than a Number
 * holds exactly.
 */
export function fileTimeToMicros(text) {
  try {
    return Number(BigInt(String(text).trim()) / 10n - WINDOWS_EPOCH_US);
  } catch {
    return null;
  }
}

/** The reverse of fileTimeToMicros, as the text the helper compares against. */
export function microsToFileTime(micros) {
  return String((BigInt(Math.round(micros)) + WINDOWS_EPOCH_US) * 10n);
}

const WMI_DATE = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;

/**
 * When a process was created, from the text Windows gives: local time to the microsecond,
 * then how many minutes that is ahead of UTC. The offset is in the text itself, so the
 * answer does not depend on this machine's time zone or on which side of a clock change
 * the process was started.
 */
export function wmiDateToMicros(text) {
  const m = WMI_DATE.exec(String(text ?? '').trim());
  if (!m) return null;
  const local = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  if (Number.isNaN(local)) return null;
  const aheadOfUtc = (m[8] === '-' ? -1 : 1) * Number(m[9]);
  return (local - aheadOfUtc * 60000) * 1000 + Number(m[7]);
}

/**
 * One listing of the machine's processes, from the helper's reply: the moment the listing
 * began, then a line per process. A line that does not parse is skipped, and a reply with
 * no opening line is no listing at all, so a broken helper can never look like a machine
 * with nothing running.
 */
export function parseListing(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  const head = /^at (\d+)$/.exec(lines[0]);
  if (!head) return null;
  const at = fileTimeToMicros(head[1]);
  if (at == null) return null;
  const rows = [];
  for (const line of lines.slice(1)) {
    const m = /^(\d+) (\d+) (\S+) (.*)$/.exec(line);
    if (!m) continue;
    const created = wmiDateToMicros(m[3]);
    if (created == null) continue;
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), created, name: m[4].trim() });
  }
  return { at, rows };
}

/** The helper's answer to a stop request: one line per process, in the order asked. */
export function parseStops(lines) {
  if (!Array.isArray(lines)) return null;
  const answers = [];
  for (const line of lines) {
    const m = /^(\d+) (stopped|gone|other|refused) (\d+)$/.exec(line);
    if (!m) return null;
    answers.push({ pid: Number(m[1]), state: m[2], at: fileTimeToMicros(m[3]) });
  }
  return answers;
}

/**
 * The processes a run is answerable for: the programs it started itself (the roots) and
 * everything found to descend from them (the members).
 *
 * `keep` names programs that are never taken in, whatever started them. Antigravity's CLI
 * starts a second copy of itself to update itself, and ending that half way could leave a
 * broken install, so the CLI's own program name is kept out. Nothing a kept process starts
 * is followed either.
 */
export function createFamily({ keep = [] } = {}) {
  return {
    roots: [],
    members: new Map(),
    keep: new Set(keep.map((name) => String(name).toLowerCase())),
  };
}

/** Times are microseconds since 1970 throughout; `startedAt` is taken before the start. */
export function addRoot(family, { pid, startedAt }) {
  const root = { pid, startedAt, exitedAt: null };
  family.roots.push(root);
  return root;
}

/**
 * Whether `row` was started by something in the family.
 *
 * The parent id on a row names whichever process held that id when the row was created,
 * so the question is always "did ours hold it then?".
 *
 * - A root holds its id from its start until Node hears that it ended: Node keeps the
 *   process open until that moment, and an open process keeps its id.
 * - A member in this same listing was created before the row and is still here, so it
 *   held the id the whole time between.
 * - A member that has gone held the id at least until `aliveAt`, the last moment it was
 *   known to be there. A row created after that is not taken, even though it probably is
 *   a child: "probably" would mean ending someone else's process when it is wrong.
 */
function startedByFamily(family, row) {
  for (const root of family.roots) {
    if (root.pid !== row.ppid || row.created < root.startedAt) continue;
    if (root.exitedAt == null || row.created <= root.exitedAt) return true;
  }
  for (const member of family.members.values()) {
    if (member.pid !== row.ppid || row.created < member.created) continue;
    if (member.present || row.created <= member.aliveAt) return true;
  }
  return false;
}

/** Fold one listing into the family: who is still here, and who has joined. */
export function absorb(family, listing) {
  const here = new Map(listing.rows.map((row) => [`${row.pid}:${row.created}`, row]));
  for (const [key, member] of family.members) {
    member.present = here.has(key);
    // In the listing means alive when it began, or created during it.
    if (member.present) member.aliveAt = Math.max(member.aliveAt, listing.at, member.created);
  }
  // A child can be listed before its parent, so keep going until a pass adds nobody.
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of listing.rows) {
      const key = `${row.pid}:${row.created}`;
      if (family.members.has(key)) continue;
      if (family.keep.has(row.name.toLowerCase())) continue;
      if (!startedByFamily(family, row)) continue;
      family.members.set(key, {
        pid: row.pid,
        created: row.created,
        name: row.name,
        aliveAt: Math.max(listing.at, row.created),
        present: true,
      });
      grew = true;
    }
  }
  return family;
}

/** Members in the last listing, oldest first, so a parent is stopped before its children. */
export function running(family) {
  return [...family.members.values()].filter((m) => m.present).sort((a, b) => a.created - b.created);
}

/**
 * Record what the helper did with each process it was asked to stop. One that was really
 * stopped was, at that moment, proven to be the listed process, so anything it started up
 * to then is still its child in the next listing.
 */
export function noteStops(family, asked, answers) {
  const stopped = [];
  asked.forEach((member, i) => {
    const answer = answers[i];
    if (!answer || answer.pid !== member.pid || answer.state !== 'stopped') return;
    if (answer.at != null) member.aliveAt = Math.max(member.aliveAt, answer.at);
    stopped.push(member);
  });
  return stopped;
}

// The helper: reads one request a line, answers with lines and then `done`.
//   list              -> `at <file time>`, then `<id> <parent id> <created> <name>` each
//   stop <id>:<file time> ...  -> `<id> <stopped|gone|other|refused> <file time>` each
// The time on `at` is taken before the listing starts, so everything in it was alive then
// or created since. A stop opens the process before it looks at it: an open process keeps
// its id, so the one that is checked is the one that is ended. `other` means the id now
// belongs to a different process, which is left alone. The creation time Windows lists is
// cut to the microsecond, hence the allowance of 20 steps of 100 nanoseconds. Single
// quotes only and every statement closed with a semicolon, because this travels as one
// line in one command-line argument.
const HELPER = [
  "$ErrorActionPreference = 'Stop';",
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;',
  '$reader = [Console]::In; $writer = [Console]::Out; $nl = [string][char]10;',
  'while ($true) {',
  '  $line = $reader.ReadLine(); if ($null -eq $line) { break };',
  '  $text = New-Object System.Text.StringBuilder;',
  "  if ($line -eq 'list') {",
  '    try {',
  "      [void]$text.Append('at ').Append([DateTime]::UtcNow.ToFileTimeUtc()).Append($nl);",
  "      foreach ($p in (Get-WmiObject -Query 'SELECT ProcessId,ParentProcessId,CreationDate,Name FROM Win32_Process')) {",
  "        if ($p.CreationDate) { [void]$text.Append($p.ProcessId).Append(' ').Append($p.ParentProcessId).Append(' ').Append($p.CreationDate).Append(' ').Append($p.Name).Append($nl) };",
  '      };',
  "    } catch { $text.Length = 0; [void]$text.Append('failed').Append($nl) };",
  "  } elseif ($line.StartsWith('stop ')) {",
  "    foreach ($item in $line.Substring(5).Split(' ')) {",
  "      $pair = $item.Split(':'); $state = 'gone'; $when = 0;",
  '      try {',
  '        $proc = [System.Diagnostics.Process]::GetProcessById([int]$pair[0]);',
  '        try {',
  '          $null = $proc.Handle;',
  '          $when = [DateTime]::UtcNow.ToFileTimeUtc();',
  "          if ($proc.HasExited) { $state = 'gone' }",
  "          elseif ([Math]::Abs($proc.StartTime.ToFileTimeUtc() - [long]$pair[1]) -lt 20) { $proc.Kill(); $state = 'stopped' }",
  "          else { $state = 'other' };",
  "        } catch { $state = 'refused' } finally { $proc.Close() };",
  "      } catch { if ($state -ne 'refused') { $state = 'gone' } };",
  "      [void]$text.Append($pair[0]).Append(' ').Append($state).Append(' ').Append($when).Append($nl);",
  '    };',
  '  };',
  "  [void]$text.Append('done').Append($nl); $writer.Write($text.ToString()); $writer.Flush();",
  '}',
].join(' ');

/** How long one request to the helper may take before it is given up on. */
const HELPER_TIMEOUT_MS = 5000;

/**
 * Start the helper. Requests are answered one at a time, in order. Every failure (it
 * would not start, it ended, it took too long) answers null from then on, and never
 * throws: the caller's real job is a usage reading, and that must not fail because the
 * tidying could not be done.
 */
export function openHelper({ spawnImpl = spawn, timeoutMs = HELPER_TIMEOUT_MS } = {}) {
  let child = null;
  let failed = false;
  let pending = '';
  let lines = [];
  const waiting = [];

  const giveUp = () => {
    failed = true;
    for (const w of waiting.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
  };
  const fail = () => {
    if (failed) return;
    giveUp();
    try { child?.kill(); } catch { /* already gone */ }
  };

  try {
    child = spawnImpl('powershell', ['-NoProfile', '-NonInteractive', '-Command', HELPER], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    child.on('error', fail);
    child.on('exit', fail);
    child.stdin.on('error', fail);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      pending += chunk;
      const parts = pending.split(/\r?\n/);
      pending = parts.pop();
      for (const line of parts) {
        if (line !== 'done') {
          lines.push(line);
          continue;
        }
        const reply = lines;
        lines = [];
        const w = waiting.shift();
        if (!w) continue;
        clearTimeout(w.timer);
        w.resolve(reply);
      }
    });
  } catch {
    failed = true;
  }

  const ask = (request) => new Promise((resolve) => {
    if (failed) return resolve(null);
    const timer = setTimeout(fail, timeoutMs);
    waiting.push({ resolve, timer });
    try {
      child.stdin.write(`${request}\n`);
    } catch {
      fail();
    }
  });

  return {
    async list() {
      return parseListing(await ask('list'));
    },
    async stop(members) {
      if (members.length === 0) return [];
      return parseStops(await ask(`stop ${members.map((m) => `${m.pid}:${microsToFileTime(m.created)}`).join(' ')}`));
    },
    close() {
      if (failed) return;
      giveUp();
      // Closing its input is how the helper is told to end; the timer is for one that
      // does not listen.
      try { child.stdin.end(); } catch { /* already gone */ }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } }, 2000);
      timer.unref?.();
      child.once('exit', () => clearTimeout(timer));
    },
  };
}

/** The most a program's output may run to, the same limit Node's own execFile applies. */
const OUTPUT_LIMIT = 1024 * 1024;

/**
 * How long to wait for the rest of a program's output once it has ended. Its output
 * normally closes with it. It stays open only when something the program started is
 * holding on to it, and that something is about to be stopped.
 */
const OUTPUT_GRACE_MS = 300;

/**
 * Run one program to its end and answer with what it printed, the way execFile does: a
 * non-zero exit, a timeout or too much output is a failure. Unlike execFile it hands back
 * the process as soon as it exists (`onStart`) and the moment it ends (`onExit`), and it
 * does not wait on output that a leftover is keeping open.
 */
export function runProgram(file, args, options = {}, { spawnImpl = spawn, onStart = null, onExit = null } = {}) {
  const { timeout = 0, ...spawnOptions } = options;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(file, args, { ...spawnOptions, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      reject(e);
      return;
    }
    let stdout = '';
    let settled = false;
    let ended = null;
    let problem = null;
    let killTimer = null;
    let graceTimer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      clearTimeout(graceTimer);
      try { child.stdout?.destroy(); } catch { /* already closed */ }
      try { child.stderr?.destroy(); } catch { /* already closed */ }
      if (problem) reject(problem);
      else if (!ended || ended.code !== 0) reject(new Error(`${file} ended with ${ended?.signal ?? ended?.code ?? 'no exit code'}`));
      else resolve({ stdout });
    };
    const stop = (why) => {
      if (!problem) problem = new Error(why);
      try { child.kill(); } catch { /* already gone */ }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > OUTPUT_LIMIT) stop(`${file} printed more than expected`);
    });
    // Read and dropped: a program whose error output nobody reads stalls once it fills.
    child.stderr?.resume();
    child.stdin?.on('error', () => { /* the program closed its input; nothing is written to it */ });
    child.on('error', (e) => {
      problem = problem ?? e;
      finish();
    });
    child.on('exit', (code, signal) => {
      ended = { code, signal };
      try { onExit?.(child); } catch { /* the reading matters more than the bookkeeping */ }
      graceTimer = setTimeout(finish, OUTPUT_GRACE_MS);
    });
    child.on('close', finish);
    if (timeout > 0) killTimer = setTimeout(() => stop(`${file} timed out after ${timeout}ms`), timeout);
    try { onStart?.(child); } catch { /* as above */ }
  });
}

/** How many times the helper is asked to stop what is still running before giving up. */
const STOP_ROUNDS = 3;

/** How long a stopped process is given to disappear from the list before looking again. */
const SETTLE_MS = 150;

/** The longest a sweep waits for programs it is told have ended to actually be reported so. */
const EXIT_WAIT_MS = 5000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const describe = (member) => ({ pid: member.pid, name: member.name });

function windowsWatch({ keep, openHelperImpl, spawnImpl, now }) {
  const family = createFamily({ keep });
  const exits = [];
  let helper = null;
  let early = null;

  return {
    run(file, args, options) {
      if (!helper) {
        // Started with the first program rather than after the last, so that it is up and
        // has listed once by the time there is something to stop. Half a second of
        // PowerShell starting up after the CLI has ended is long enough for a server to
        // start something new.
        helper = openHelperImpl();
        early = helper.list().then((listing) => { if (listing) absorb(family, listing); });
      }
      let root = null;
      let ended = null;
      const startedAt = now() * 1000;
      return runProgram(file, args, options, {
        spawnImpl,
        onStart(child) {
          if (!Number.isInteger(child.pid)) return;
          root = addRoot(family, { pid: child.pid, startedAt });
          exits.push(new Promise((resolve) => { ended = resolve; }));
        },
        onExit() {
          if (!root) return;
          root.exitedAt = now() * 1000;
          ended();
        },
      });
    },

    async sweep() {
      const outcome = { checked: false, stopped: [], left: [] };
      if (!helper) return { ...outcome, checked: true };
      try {
        await Promise.race([Promise.all(exits), pause(EXIT_WAIT_MS)]);
        // A root that is still running still owns what it started.
        if (family.roots.some((root) => root.exitedAt == null)) return outcome;
        await early;
        for (let round = 0; ; round++) {
          const listing = await helper.list();
          if (!listing) return outcome;
          absorb(family, listing);
          const alive = running(family);
          outcome.left = alive.map(describe);
          if (alive.length === 0 || round === STOP_ROUNDS) break;
          const answers = await helper.stop(alive);
          if (!answers) return outcome;
          outcome.stopped.push(...noteStops(family, alive, answers).map(describe));
          await pause(SETTLE_MS);
        }
        outcome.checked = true;
        return outcome;
      } catch {
        return outcome;
      } finally {
        helper.close();
      }
    },
  };
}

/** How long a process group is given to end after being asked, before it is forced. */
const GROUP_GRACE_MS = 1000;

function posixWatch({ wholeGroup, spawnImpl, killImpl }) {
  const groups = [];
  const signal = (pid, name) => {
    try {
      killImpl(-pid, name);
      return true;
    } catch {
      return false; // nobody left in the group, or not ours to signal
    }
  };

  return {
    run(file, args, options) {
      // `detached` makes the program the leader of a new process group, which is what
      // lets everything it starts be reached once it has ended.
      return runProgram(file, args, { ...options, detached: true }, {
        spawnImpl,
        onStart(child) {
          if (Number.isInteger(child.pid)) groups.push(child.pid);
        },
      });
    },

    async sweep() {
      const outcome = { checked: false, stopped: [], left: [] };
      // A group cannot be stopped in part, so when it may hold something that has to be
      // left alone, it is left alone whole.
      if (!wholeGroup) return outcome;
      const asked = groups.filter((pid) => signal(pid, 'SIGTERM'));
      const deadline = Date.now() + GROUP_GRACE_MS;
      let alive = asked;
      while (alive.length > 0 && Date.now() < deadline) {
        await pause(50);
        alive = alive.filter((pid) => signal(pid, 0));
      }
      for (const pid of alive) signal(pid, 'SIGKILL');
      outcome.stopped = asked.map((pid) => ({ pid, name: 'process group' }));
      outcome.checked = true;
      return outcome;
    },
  };
}

/**
 * Watch over a few programs that are about to be run, so that whatever they start can be
 * stopped once they have ended.
 *
 *   const watch = watchLeftovers({ keep: ['agy.exe'] });
 *   const answer = await watch.run(file, args, options);   // as often as needed
 *   const outcome = await watch.sweep();                    // once, after the last one
 *
 * `sweep` never throws and answers `{ checked, stopped, left }`: whether the check could
 * be made at all, what was stopped, and what is still running anyway.
 *
 * `wholeGroup` matters only away from Windows, where the programs kept out by `keep`
 * cannot be told apart: pass false when one of them may have been started.
 */
export function watchLeftovers({
  keep = [],
  wholeGroup = true,
  platform = process.platform,
  openHelperImpl = openHelper,
  spawnImpl = spawn,
  killImpl = process.kill.bind(process),
  now = Date.now,
} = {}) {
  return platform === 'win32'
    ? windowsWatch({ keep, openHelperImpl, spawnImpl, now })
    : posixWatch({ wholeGroup, spawnImpl, killImpl });
}
