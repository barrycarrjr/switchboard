import { spawnSync } from 'node:child_process';

const HKCU = 'HKCU\\Environment';
const HKLM = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';

function regQuery(hive, name) {
  const r = spawnSync('reg', ['query', hive, '/v', name], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0 || !r.stdout) return null;
  // "    NAME    REG_SZ    value" (value may contain spaces)
  const line = r.stdout.split(/\r?\n/).find((l) => l.match(/REG_(EXPAND_)?SZ/));
  if (!line) return null;
  const m = line.match(/REG_(?:EXPAND_)?SZ\s+(.*)$/);
  return m ? m[1].trim() : null;
}

/** Read a variable from the user's persistent environment (registry, not this process). */
export function readUserEnv(name) {
  if (process.platform !== 'win32') return process.env[name] ?? null;
  return regQuery(HKCU, name);
}

/** Read a variable from the machine-wide persistent environment. */
export function readMachineEnv(name) {
  if (process.platform !== 'win32') return null;
  return regQuery(HKLM, name);
}

/** Expand %VAR% references against the current process environment. */
export function expandEnvString(value) {
  return String(value ?? '').replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m);
}

/**
 * Directories on the PERSISTED PATH (user + machine, fresh from the registry) plus
 * this process's PATH. A running app's own PATH goes stale the moment an installer
 * adds a new entry; the registry does not.
 */
export function freshPathDirs() {
  const parts = [
    expandEnvString(readUserEnv('Path') ?? ''),
    expandEnvString(readMachineEnv('Path') ?? ''),
    process.env.PATH ?? '',
  ].join(';');
  return [...new Set(parts.split(';').map((p) => p.trim()).filter(Boolean))];
}

/**
 * Delete a user-scope variable. .NET's SetEnvironmentVariable removes the registry
 * value AND broadcasts the change, which plain `reg delete` does not.
 */
export function deleteUserEnv(name) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid variable name: ${name}`);
  if (process.platform !== 'win32') {
    delete process.env[name];
    return true;
  }
  const r = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::SetEnvironmentVariable('${name}', $null, 'User')`], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`removing ${name} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return true;
}

/**
 * Persist a user-scope variable. setx also broadcasts the change so Explorer and
 * newly launched apps pick it up without a logoff.
 */
export function setUserEnv(name, value) {
  if (String(value).length > 1000) throw new Error(`${name}: value too long for setx`);
  if (process.platform !== 'win32') {
    process.env[name] = String(value);
    return true;
  }
  const r = spawnSync('setx', [name, String(value)], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`setx ${name} failed: ${(r.stderr || r.stdout || '').trim()}`);
  return true;
}
