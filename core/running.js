import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { packageFamilyFromAppId } from './apps.js';

const run = promisify(execFile);

/**
 * Which of the things Switchboard launches are actually running right now. One process
 * snapshot answers for everything: an app matches by its program file, a bridge (a
 * background worker such as a Slack bot, which usually runs inside node or python and
 * so cannot be told apart by program file) matches by the text of its command line.
 * The matching itself is pure and lives here so it can be tested; only the snapshot
 * touches the machine.
 */

/**
 * Parse the JSON the snapshot command prints. PowerShell renders one process as a bare
 * object rather than a one-element list, so both shapes are accepted. Anything
 * unreadable is an empty list: the caller treats a missing snapshot separately.
 */
export function parseProcessList(text) {
  try {
    const parsed = JSON.parse(String(text));
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    return rows
      .filter((r) => r && typeof r === 'object')
      .map((r) => ({
        name: String(r.Name ?? ''),
        path: r.ExecutablePath == null ? null : String(r.ExecutablePath),
        commandLine: r.CommandLine == null ? null : String(r.CommandLine),
      }));
  } catch {
    return [];
  }
}

/**
 * Snapshot the running processes: name, program file, command line. Null when the
 * machine cannot answer (not Windows, or the query failed), which the UI shows as
 * unknown rather than as everything-stopped bureaucratically.
 */
export async function listProcesses() {
  if (process.platform !== 'win32') return null;
  try {
    const { stdout } = await run(
      'powershell',
      ['-NoProfile', '-Command', '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object Name,ExecutablePath,CommandLine | ConvertTo-Json -Compress'],
      { windowsHide: true, timeout: 20000, maxBuffer: 32 * 1024 * 1024 },
    );
    const rows = parseProcessList(stdout);
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

const normPath = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Is this app running? True/false when the app is identifiable in a process list,
 * null when it is not:
 * - a known program file matches on the process's program path;
 * - a Store app matches on the package folder its processes run from, which carries
 *   the package name and publisher hash (`...\WindowsApps\Claude_1.0_x64__hash\...`),
 *   so a program file merely sharing the exe name (the claude CLI, say) never counts;
 * - a custom launcher whose Start-menu id is itself a program path matches on that;
 * - anything else is null, and the card simply shows no state rather than a wrong one.
 */
export function appRunning(processes, { exePath = null, appId = null } = {}) {
  if (exePath) {
    const want = normPath(exePath);
    return processes.some((p) => normPath(p.path) === want);
  }
  const family = packageFamilyFromAppId(appId);
  if (family) {
    const cut = family.lastIndexOf('_');
    const re = new RegExp(`\\\\${escapeRe(family.slice(0, cut))}_[^\\\\]*__${escapeRe(family.slice(cut + 1))}\\\\`, 'i');
    return processes.some((p) => re.test(String(p.path || '')));
  }
  if (appId && /^[a-z]:\\.+\.exe$/i.test(String(appId))) {
    const want = normPath(appId);
    return processes.some((p) => normPath(p.path) === want);
  }
  return null;
}

/** A bridge is running when any process's command line (or program path) contains its match text. */
export function bridgeRunning(processes, match) {
  const needle = String(match || '').toLowerCase();
  if (!needle) return false;
  return processes.some((p) => String(p.commandLine || '').toLowerCase().includes(needle)
    || String(p.path || '').toLowerCase().includes(needle));
}

/**
 * What is wrong with a bridge entry someone typed in, or null when nothing is. A match
 * of one or two characters would light up on half the machine, so it is refused rather
 * than allowed to look authoritative.
 */
export function bridgeProblem({ label, match } = {}) {
  if (typeof label !== 'string' || !label.trim()) return 'the bridge needs a name';
  if (label.length > 200) return 'the name is too long';
  if (typeof match !== 'string' || !match.trim()) return 'the bridge needs command-line text to look for';
  if (match.trim().length < 3) return 'the match text is too short to identify one process';
  if (match.length > 500) return 'the match text is too long';
  if (/[\0\r\n]/.test(label) || /[\0\r\n]/.test(match)) return 'names and match text must be a single line';
  return null;
}

/** What is wrong with renaming a bridge, or null when valid. */
export function renameBridgeProblem({ label } = {}) {
  if (typeof label !== 'string' || !label.trim()) return 'the bridge needs a name';
  if (label.length > 200) return 'the name is too long';
  if (/[\0\r\n]/.test(label)) return 'names must be a single line';
  return null;
}

/**
 * Suggest a friendly label and distinctive match text from a running process's command line.
 */
export function suggestBridgeDetails(proc) {
  const name = String(proc?.name || '');
  const cmd = String(proc?.commandLine || '').trim();

  let script = '';
  if (cmd) {
    const fileArgMatch = cmd.match(/-File\s+["']?([^"'\r\n]+?)["']?(?:\s|$)/i);
    if (fileArgMatch) {
      script = fileArgMatch[1].trim();
    } else {
      const modMatch = cmd.match(/(?:^|\s)-m\s+([a-zA-Z0-9_.-]+)/i);
      if (modMatch) {
        script = modMatch[1].trim();
      } else {
        // Strip the leading executable to avoid matching the interpreter itself
        let args = cmd;
        if (cmd.startsWith('"')) {
          const closeQuote = cmd.indexOf('"', 1);
          if (closeQuote !== -1) args = cmd.slice(closeQuote + 1).trim();
        } else {
          const firstSpace = cmd.indexOf(' ');
          if (firstSpace !== -1) args = cmd.slice(firstSpace + 1).trim();
        }

        // Look for script file (.js, .mjs, .cjs, .ts, .py, .ps1, .rb, etc.) or absolute script path
        const scriptMatch = args.match(/(?:^|\s)["']?([a-zA-Z]:\\[^"'\r\n\t]+?|[^"'\r\n\s]+?\.(?:[cm]?js|ts|py|ps1|rb|sh|bat|cmd))["']?(?:\s|$)/i);
        if (scriptMatch) {
          script = scriptMatch[1].trim();
        }
      }
    }
  }

  let label = '';
  let match = '';

  if (script) {
    const norm = script.replace(/\//g, '\\');
    const parts = norm.split('\\').filter(Boolean);
    const fileName = parts[parts.length - 1] || '';
    const baseName = fileName.replace(/\.[^.]+$/, '');

    // Look upwards for the project/enclosing folder, skipping common code directories
    let project = '';
    const codeDirs = /^(src|bin|lib|dist|scripts|app|windows|linux|darwin|cmd|pkg)$/i;
    for (let i = parts.length - 2; i >= 0; i--) {
      const seg = parts[i];
      if (/^[a-zA-Z]:$/i.test(seg)) break;
      if (!codeDirs.test(seg)) {
        project = seg;
        break;
      }
    }
    if (!project) project = baseName;

    if (baseName && !/^(index|main|server|app|start|run|bot|bridge)$/i.test(baseName) && baseName !== project) {
      label = `${project} (${baseName})`;
    } else {
      label = project;
    }
    match = script;
  } else if (cmd) {
    const firstSpace = cmd.indexOf(' ');
    if (firstSpace !== -1 && firstSpace < cmd.length - 1) {
      match = cmd.slice(firstSpace + 1).replace(/^["']|["']$/g, '').trim();
      label = name.replace(/\.exe$/i, '');
    } else {
      match = name;
      label = name.replace(/\.exe$/i, '');
    }
  } else {
    match = name;
    label = name.replace(/\.exe$/i, '');
  }

  return {
    label: label.trim() || name.replace(/\.exe$/i, '') || 'Background process',
    match: match.trim() || name,
  };
}

/**
 * Filter and format candidate background processes to watch.
 */
export function candidateBridgeProcesses(processes, { query = '' } = {}) {
  if (!Array.isArray(processes)) return [];
  const q = String(query || '').trim().toLowerCase();

  const isExcluded = (p) => {
    const n = String(p.name || '').toLowerCase();
    const c = String(p.commandLine || '').toLowerCase();
    if (n === 'switchboard.exe') return true;
    if (c.includes('switchboard') && c.includes('--type=')) return true;
    if (n === 'tgitcache.exe') return true;
    if (!q) {
      if (/^(svchost|conhost|runtimebroker|backgroundtaskhost|taskhostw|searchhost|sihost|shellexperiencehost|startmenuexperiencehost|ctfmon|dllhost|smss|csrss|wininit|services|lsass|winlogon|fontdrvhost|dwm|spoolsv)\.exe$/i.test(n)) {
        return true;
      }
      if (!p.commandLine || p.commandLine.trim() === p.name || p.commandLine.trim() === `"${p.path}"`) {
        return true;
      }
    }
    return false;
  };

  const results = [];
  const seenMatches = new Set();

  for (const p of processes) {
    if (!p || typeof p !== 'object') continue;
    if (isExcluded(p)) continue;

    const name = String(p.name || '');
    const cmd = String(p.commandLine || '');
    const pathStr = String(p.path || '');

    const { label, match } = suggestBridgeDetails(p);

    if (q) {
      const matchText = `${name} ${cmd} ${pathStr} ${label} ${match}`.toLowerCase();
      if (!matchText.includes(q)) continue;
    }

    const key = `${label}|${match}`;
    if (seenMatches.has(key)) continue;
    seenMatches.add(key);

    results.push({
      name,
      path: pathStr || null,
      commandLine: cmd || null,
      label,
      match,
    });
  }

  results.sort((a, b) => {
    if (q) {
      const aInLabel = a.label.toLowerCase().includes(q);
      const bInLabel = b.label.toLowerCase().includes(q);
      if (aInLabel && !bInLabel) return -1;
      if (!aInLabel && bInLabel) return 1;
    }
    const isScriptInterp = (n) => /^(node|python|powershell|pwsh|deno|bun|ruby)\.exe$/i.test(n);
    const aInterp = isScriptInterp(a.name);
    const bInterp = isScriptInterp(b.name);
    if (aInterp && !bInterp) return -1;
    if (!aInterp && bInterp) return 1;
    return a.label.localeCompare(b.label);
  });

  return results.slice(0, 50);
}
