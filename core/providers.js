import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { freshPathDirs } from './env.js';

const run = promisify(execFile);

const WIN_EXTS = ['.exe', '.cmd', '.bat', ''];

/** Find a binary inside a list of directories. Pure enough to test. */
export function findBinIn(dirs, bin) {
  for (const dir of dirs) {
    for (const ext of WIN_EXTS) {
      const candidate = path.join(dir, bin + ext);
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
      } catch { /* unreadable dir */ }
    }
  }
  return null;
}

/**
 * The tool table. Installs always delegate to a vendor mechanism; Switchboard never
 * bundles or downloads binaries itself. Tools without a vendor-verifiable Windows
 * install command are detect-only: `install.via = 'manual'` links to the vendor site.
 */
export const TOOLS = [
  { id: 'claude', name: 'Claude Code', url: 'https://code.claude.com', bin: 'claude', versionArgs: ['--version'], appPaths: () => [path.join(os.homedir(), '.local', 'bin', 'claude.exe')], install: { via: 'winget', cmd: 'winget install --id Anthropic.ClaudeCode -e' } },
  { id: 'codex', name: 'Codex', url: 'https://developers.openai.com/codex', bin: 'codex', versionArgs: ['--version'], install: { via: 'npm', cmd: 'npm install -g @openai/codex' } },
  { id: 'gemini', name: 'Gemini CLI', url: 'https://github.com/google-gemini/gemini-cli', bin: 'gemini', versionArgs: ['--version'], install: { via: 'npm', cmd: 'npm install -g @google/gemini-cli' } },
  { id: 'copilot', name: 'Copilot CLI', url: 'https://github.com/github/copilot-cli', bin: 'copilot', versionArgs: ['--version'], install: { via: 'npm', cmd: 'npm install -g @github/copilot' } },
  { id: 'junie', name: 'Junie CLI', url: 'https://www.jetbrains.com/junie', bin: 'junie', versionArgs: ['--version'], install: { via: 'npm', cmd: 'npm install -g @jetbrains/junie' } },
  { id: 'qwen', name: 'Qwen Code', url: 'https://github.com/QwenLM/qwen-code', bin: 'qwen', versionArgs: ['--version'], install: { via: 'npm', cmd: 'npm install -g @qwen-code/qwen-code' } },
  { id: 'amp', name: 'Amp', url: 'https://ampcode.com', bin: 'amp', versionArgs: ['--version'], install: { via: 'npm', cmd: 'npm install -g @sourcegraph/amp' } },
  { id: 'opencode', name: 'OpenCode', url: 'https://opencode.ai', bin: 'opencode', versionArgs: ['--version'], install: { via: 'npm', cmd: 'npm install -g opencode-ai' } },
  { id: 'grok', name: 'Grok Build', url: 'https://x.ai', bin: 'grok', versionArgs: ['--version'], install: { via: 'vendor', cmd: 'irm https://x.ai/cli/install.ps1 | iex' } },
  { id: 'cursor', name: 'Cursor CLI (cursor-agent)', url: 'https://cursor.com', note: 'No automated Windows install from the vendor yet', bin: 'cursor-agent', versionArgs: ['--version'], install: { via: 'manual', url: 'https://cursor.com' } },
  { id: 'aider', name: 'Aider', url: 'https://aider.chat', note: 'Installs with pip (needs Python)', bin: 'aider', versionArgs: ['--version'], install: { via: 'pip', cmd: 'python -m pip install aider-install; aider-install' } },
  { id: 'antigravity', name: 'Antigravity CLI (agy)', url: 'https://antigravity.google', note: 'The desktop app is separate (see Apps)', bin: 'agy', versionArgs: ['--version'], install: { via: 'vendor', cmd: 'irm https://antigravity.google/cli/install.ps1 | iex' } },
  { id: 'ollama', name: 'Ollama', url: 'https://ollama.com', bin: 'ollama', versionArgs: ['--version'], appPaths: () => [path.join(process.env.LOCALAPPDATA || '', 'Programs', 'Ollama', 'ollama.exe')], install: { via: 'winget', cmd: 'winget install --id Ollama.Ollama -e' } },
];

/** The uninstall command for a tool, when its mechanism supports one. */
export function uninstallCmdFor(tool) {
  if (tool.install.via === 'winget') {
    const id = tool.install.cmd.match(/--id\s+(\S+)/)?.[1];
    return id ? `winget uninstall --id ${id}` : null;
  }
  if (tool.install.via === 'npm') {
    const pkg = tool.install.cmd.split(/\s+/).pop();
    return pkg ? `npm uninstall -g ${pkg}` : null;
  }
  return null; // pip and manual installs are removed the way the vendor documents
}

/**
 * The command for a lifecycle action. One place, so the UI can only ever run what
 * the mechanism actually supports; null means the action does not exist for this tool.
 */
export function installCmdFor(tool, mode = 'install') {
  const { via, cmd } = tool.install;
  if (via === 'manual') return null;
  switch (mode) {
    case 'install':
      return cmd;
    case 'update':
      return via === 'winget' ? cmd.replace('winget install', 'winget upgrade') : cmd;
    case 'reinstall':
      // winget refuses to reinstall without --force; npm, pip, and vendor scripts
      // are safely re-runnable as-is.
      return via === 'winget' ? `${cmd} --force` : cmd;
    case 'uninstall':
      return uninstallCmdFor(tool);
    default:
      return null;
  }
}

async function whichPath(bin) {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const { stdout } = await run(finder, [bin], { windowsHide: true, timeout: 4000 });
    const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first || null;
  } catch {
    return null;
  }
}

async function binVersion(bin, args) {
  try {
    const { stdout } = await run(bin, args, { windowsHide: true, timeout: 8000, shell: process.platform === 'win32' });
    const lines = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Some tools print warnings before the version; prefer the line that has one.
    return lines.find((l) => /\d+\.\d+/.test(l)) || lines[0] || null;
  } catch {
    return null;
  }
}

/** Where a tool's binary is, if it is on this machine at all. No version calls. */
async function locate(tool) {
  if (tool.bin) {
    let hit = await whichPath(tool.bin);
    // The persisted PATH sees entries added since this process started.
    if (!hit && process.platform === 'win32') hit = findBinIn(freshPathDirs(), tool.bin);
    if (hit) return { path: hit, onPath: true };
  }
  const app = tool.appPaths?.().find((p) => p && fs.existsSync(p));
  return { path: app ?? null, onPath: false };
}

export async function detectTool(tool) {
  const out = { id: tool.id, name: tool.name, url: tool.url ?? null, note: tool.note ?? null, bin: tool.bin ?? null, installed: false, onPath: false, version: null, path: null, install: tool.install, uninstallCmd: uninstallCmdFor(tool) };
  const found = await locate(tool);
  out.path = found.path;
  out.onPath = found.onPath;
  out.installed = found.path != null;
  // A version means running the tool, which is the slow part; only the copy found on
  // PATH can answer, and an app-path hit is already proof enough that it is installed.
  if (found.onPath) out.version = await binVersion(out.path, tool.versionArgs || ['--version']);
  return out;
}

/**
 * Installed-or-not for every tool. Same lookup as detectTool without asking each one
 * for its version, which is what makes a full detect take seconds: the terminal
 * buttons only need to know what exists.
 */
export async function detectInstalled() {
  return Promise.all(TOOLS.map(async (tool) => {
    const found = await locate(tool);
    return { id: tool.id, name: tool.name, bin: tool.bin ?? null, installed: found.path != null };
  }));
}

export async function detectAll() {
  return Promise.all(TOOLS.map(detectTool));
}

/** Re-detect one tool, for the after-install watcher. */
export async function detectToolById(id) {
  const tool = TOOLS.find((t) => t.id === id);
  if (!tool) throw new Error(`unknown tool: ${id}`);
  return detectTool(tool);
}

/** Pure parser for `winget upgrade --id X` output. Exported for tests. */
export function parseWingetUpgrade(stdout, id) {
  if (/No applicable up(grade|date)|No installed package/i.test(stdout)) return { updateAvailable: false, latest: null };
  const row = stdout.split(/\r?\n/).find((l) => l.includes(id));
  if (!row) return { updateAvailable: null, latest: null }; // unparseable: claim nothing
  const versions = row.match(/\d+[\w.-]*\.\d+[\w.-]*/g) || [];
  return { updateAvailable: true, latest: versions[1] ?? versions[0] ?? null };
}

/** Pure-ish semver-lite comparison. Exported for tests. */
export function isNewerVersion(latest, installedText) {
  const ver = (s) => (String(s ?? '').match(/\d+(?:\.\d+)+/) || [null])[0];
  const a = ver(latest);
  const b = ver(installedText);
  if (!a || !b) return null;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * Ask the vendor mechanism whether a newer version exists. This is the ONLY place an
 * "update available" claim may come from; unknown stays unknown.
 */
export async function checkUpdate(tool, installedVersion) {
  if (!['winget', 'npm'].includes(tool.install.via)) return { updateAvailable: null, latest: null };
  try {
    if (tool.install.via === 'winget') {
      const id = tool.install.cmd.match(/--id\s+(\S+)/)?.[1];
      const { stdout } = await run('winget', ['upgrade', '--id', id], { windowsHide: true, timeout: 20000 });
      return parseWingetUpgrade(stdout, id);
    }
    if (tool.install.via === 'npm') {
      const pkg = tool.install.cmd.split(/\s+/).pop();
      const { stdout } = await run('npm', ['view', pkg, 'version'], { windowsHide: true, timeout: 15000, shell: process.platform === 'win32' });
      const latest = stdout.trim();
      const newer = isNewerVersion(latest, installedVersion);
      return { updateAvailable: newer, latest: newer ? latest : null };
    }
  } catch (e) {
    // winget exits non-zero when no upgrade applies; read its message before giving up
    const text = String(e.stdout || e.message || '');
    if (/No applicable up(grade|date)|No installed package/i.test(text)) return { updateAvailable: false, latest: null };
  }
  return { updateAvailable: null, latest: null };
}

export async function checkAllUpdates(detected) {
  const out = {};
  await Promise.all(detected.filter((d) => d.installed).map(async (d) => {
    const tool = TOOLS.find((t) => t.id === d.id);
    out[d.id] = await checkUpdate(tool, d.version);
  }));
  return out;
}
