import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const APP_NAME = 'Switchboard';

/** App data directory, shared by the CLI and the Electron shell. */
export function dataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, APP_NAME);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function accountsFile() {
  return path.join(dataDir(), 'accounts.json');
}

/** Servers a person added by hand. The built-in catalogue lives in code, not here. */
export function mcpFile() {
  return path.join(dataDir(), 'mcp.json');
}

/**
 * Write-then-rename so a process killed mid-write (the installer force-closes the
 * running app during an upgrade) can never leave a torn file behind: either the old
 * content survives or the new content lands whole.
 */
export function writeJsonAtomic(file, value) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

/** Case-insensitive path equality with separators and trailing slashes normalized. */
export function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) => path.resolve(String(p)).replace(/[\\/]+$/, '').toLowerCase();
  return norm(a) === norm(b);
}
