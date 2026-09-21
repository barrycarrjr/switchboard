// Argument handling for `dry-run` and `run`. It lives here rather than in bin/cli.js so the
// decisions can be tested on their own: they are pure, and getting them wrong hands one
// harness's flags to another harness's binary.
import fs from 'node:fs';

export function parseRunArgs(rawArgs) {
  const parsed = { provider: null, account: null, harnesses: null, noFallback: false, yes: false, quiet: false, spec: null, commandArgs: [] };
  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg === '--') {
      parsed.commandArgs.push(...rawArgs.slice(i + 1));
      break;
    }
    if (arg === '--provider' && i + 1 < rawArgs.length) {
      parsed.provider = rawArgs[++i];
    } else if (arg === '--account' && i + 1 < rawArgs.length) {
      parsed.account = rawArgs[++i];
    } else if (arg === '--harnesses' && i + 1 < rawArgs.length) {
      parsed.harnesses = parseHarnessList(rawArgs[++i]);
    } else if (arg === '--no-fallback') {
      parsed.noFallback = true;
    } else if (arg === '--yes' || arg === '-y') {
      parsed.yes = true;
    } else if (arg === '--quiet') {
      parsed.quiet = true;
    } else if (arg === '--spec' && i + 1 < rawArgs.length) {
      parsed.spec = rawArgs[++i];
    } else {
      parsed.commandArgs.push(arg);
    }
    i++;
  }
  return parsed;
}

/**
 * The tools a caller says it can drive, from `--harnesses claude,codex`.
 *
 * Lane order belongs to the person who owns the machine, and the tool table is much wider
 * than any one caller: a bot that can build a command line for Claude and Codex has no use
 * for a Copilot lane, however healthy it is. Without a way to say so, the caller was handed
 * whichever lane came first, and a lane it could not drive was worse than no lane at all,
 * because the usable one right below it was never offered.
 *
 * An empty list is returned as null, which means "no restriction". A caller that names
 * nothing has not asked for an empty pool, and reading it that way would turn a typo into
 * "no lanes match" on every run.
 */
export function parseHarnessList(value) {
  const names = String(value ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  return names.length ? [...new Set(names)] : null;
}

/**
 * Every tool this invocation may run on, or null when it may run on any.
 *
 * A spec already says which tools the caller can drive: the ones it wrote a command line
 * for. So a spec narrows the pool on its own, with no second flag to keep in step with it,
 * and `--harnesses` exists for the caller that has to ask (`dry-run`) before it has
 * written a spec at all. Given both, a lane has to satisfy both.
 */
export function drivableHarnesses(parsed, spec) {
  const fromSpec = spec?.harnessArgs ? Object.keys(spec.harnessArgs).map((h) => h.toLowerCase()) : null;
  const named = parsed?.harnesses?.length ? parsed.harnesses : null;
  if (fromSpec && named) return named.filter((h) => fromSpec.includes(h));
  return fromSpec ?? named;
}

// A run spec is a caller-built command line per harness. switchboard derives the executable
// from the selected lane, so a caller that cannot see the lane in advance cannot build one
// argv that is correct for every harness it is willing to run on. The spec is how it does.
export function parseRunSpec(raw) {
  let data;
  try {
    // A spec written by a Windows tool often carries a byte order mark, which JSON.parse
    // refuses. Dropping it is kinder than failing a file that is otherwise correct.
    data = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  } catch (e) {
    throw new Error(`Run spec is not valid JSON: ${e.message}`);
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('Run spec must be a JSON object');
  }
  const harnessArgs = data.harnessArgs;
  if (!harnessArgs || typeof harnessArgs !== 'object' || Array.isArray(harnessArgs)) {
    throw new Error('Run spec must contain a harnessArgs object');
  }
  // Tool names are lower case everywhere else, so they are made so here, once. The pool is
  // narrowed by these names and the command line is looked up by them, and if only one of
  // the two forgave a capital letter, `dry-run` would name a lane that `run` then refused.
  const byTool = {};
  for (const [harness, argv] of Object.entries(harnessArgs)) {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
      throw new Error(`Run spec harnessArgs.${harness} must be an array of strings`);
    }
    byTool[harness.toLowerCase()] = argv;
  }
  return { harnessArgs: byTool };
}

export function loadRunSpec(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`Cannot read run spec ${filePath}: ${e.message}`);
  }
  return parseRunSpec(raw);
}

// How the child's streams are wired. stdout is only captured when nothing is attached to a
// terminal, which is exactly the automated case: capturing it costs the child its terminal,
// and a harness that renders a live interface (an interactive Claude or Codex session) then
// falls back to plain text. A person at a keyboard reads a limit notice themselves, so
// losing stdout classification there costs nothing.
//
// stdin is inherited when a person is typing into it, because an interactive tool needs the
// real terminal. When a caller piped its prompt in, the child gets a pipe of its own that
// the prompt is replayed into: see core/piped-input.js for why inheriting it was only ever
// good for the first lane.
export function childStdio(stdoutIsTty, replayStdin = false) {
  return [replayStdin ? 'pipe' : 'inherit', stdoutIsTty ? 'inherit' : 'pipe', 'pipe'];
}

// Whether the harness gets a console window of its own on Windows. A caller with no
// terminal is an automated one (a Slack bridge, a scheduled run, anything started from a
// hidden launcher), and this process is an Electron binary running as node, so it has no
// console for the child to inherit: Windows hands the child a brand new one and shows it.
// That is a command window popping onto the desktop every time a bot answers a message.
// Hiding it there is the whole fix. A person who typed the command keeps their window,
// because the harness renders its interface into that terminal's console and taking it
// away would break interactive runs.
export function childWindowsHide(stdoutIsTty) {
  return !stdoutIsTty;
}

// Missing harness returns null so the caller can refuse to run rather than guess. The
// handoff prompt is APPENDED, because a headless form can need a subcommand and flags
// (`codex exec - <prompt>`) and replacing the argv with the bare prompt would not run.
export function resolveSpecArgv(spec, harness, handoffPrompt = null) {
  const argv = spec?.harnessArgs?.[String(harness ?? '').toLowerCase()];
  if (!Array.isArray(argv)) return null;
  return handoffPrompt ? [...argv, handoffPrompt] : [...argv];
}

/**
 * `switchboard lanes add <accountId> [--metered] [--budget <n>]`.
 *
 * The value after --budget is consumed explicitly rather than picked out by looking for
 * the argument that is not a flag: "--budget 25 claude-work" would otherwise register a
 * lane for an account called "25".
 */
export function parseLaneAddArgs(rawArgs = []) {
  const parsed = { accountId: null, billing: 'subscription', budget: null };
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--metered') {
      parsed.billing = 'metered';
    } else if (arg === '--subscription') {
      parsed.billing = 'subscription';
    } else if (arg === '--budget') {
      if (i + 1 >= rawArgs.length) throw new Error('--budget needs an amount');
      parsed.budget = rawArgs[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown option: ${arg}`);
    } else if (parsed.accountId) {
      throw new Error('name exactly one account');
    } else {
      parsed.accountId = arg;
    }
  }
  if (!parsed.accountId) throw new Error('name the account this lane runs on');
  if (parsed.budget !== null && parsed.billing !== 'metered') {
    // A budget on a subscription lane would be stored and never read, which reads as a
    // cap that is being enforced.
    throw new Error('--budget applies to metered lanes only');
  }
  return parsed;
}

/**
 * `switchboard watch [--once] [--interval <minutes>] [--mode notify|auto] [--json]`.
 *
 * The mode is an override for this process only: it is never written back to settings,
 * so a scheduled task cannot quietly change what the desktop app does.
 */
export function parseWatchArgs(rawArgs = []) {
  const parsed = { once: false, intervalMinutes: 5, mode: null, json: false };
  for (let i = 0; i < rawArgs.length; i++) {
    const arg = rawArgs[i];
    if (arg === '--once') {
      parsed.once = true;
    } else if (arg === '--json') {
      parsed.json = true;
    } else if (arg === '--interval') {
      if (i + 1 >= rawArgs.length) throw new Error('--interval needs a number of minutes');
      const minutes = Number(rawArgs[++i]);
      if (!Number.isFinite(minutes) || minutes < 1) throw new Error('--interval must be at least 1 minute');
      parsed.intervalMinutes = minutes;
    } else if (arg === '--mode') {
      if (i + 1 >= rawArgs.length) throw new Error('--mode needs notify or auto');
      const mode = String(rawArgs[++i]);
      if (mode !== 'notify' && mode !== 'auto') throw new Error('--mode must be notify or auto');
      parsed.mode = mode;
    } else {
      throw new Error(`unknown option: ${arg}`);
    }
  }
  return parsed;
}
