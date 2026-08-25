// Argument handling for `dry-run` and `run`. It lives here rather than in bin/cli.js so the
// decisions can be tested on their own: they are pure, and getting them wrong hands one
// harness's flags to another harness's binary.
import fs from 'node:fs';

export function parseRunArgs(rawArgs) {
  const parsed = { provider: null, account: null, noFallback: false, yes: false, quiet: false, spec: null, commandArgs: [] };
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
  for (const [harness, argv] of Object.entries(harnessArgs)) {
    if (!Array.isArray(argv) || argv.some((a) => typeof a !== 'string')) {
      throw new Error(`Run spec harnessArgs.${harness} must be an array of strings`);
    }
  }
  return { harnessArgs };
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
// losing stdout classification there costs nothing. stdin is always inherited: the prompt
// arrives on switchboard's stdin and the child must keep reading it.
export function childStdio(stdoutIsTty) {
  return ['inherit', stdoutIsTty ? 'inherit' : 'pipe', 'pipe'];
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
  const argv = spec?.harnessArgs?.[harness];
  if (!Array.isArray(argv)) return null;
  return handoffPrompt ? [...argv, handoffPrompt] : [...argv];
}
