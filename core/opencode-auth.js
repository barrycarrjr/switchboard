import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * OpenCode authentication file locations on Windows and Unix-like systems.
 * OpenCode stores configured connections and credentials in auth.json.
 */
export function defaultOpenCodeAuthPaths() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  return [
    path.join(localAppData, 'opencode', 'auth.json'),
    path.join(home, '.local', 'share', 'opencode', 'auth.json'),
    path.join(home, '.config', 'opencode', 'auth.json'),
  ];
}

/**
 * Read and decode the OpenCode auth.json file.
 * Returns a map of providerId -> { type, key, access, expires }, or empty object if missing/invalid.
 */
export function readOpenCodeAuth(customPath = null) {
  const candidatePaths = customPath ? [customPath] : defaultOpenCodeAuthPaths();
  for (const filePath of candidatePaths) {
    try {
      if (!fs.existsSync(filePath)) continue;
      const raw = fs.readFileSync(filePath, 'utf8');
      const data = JSON.parse(raw);
      if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
        return data;
      }
    } catch {
      // Unreadable or malformed JSON is ignored safely
    }
  }
  return {};
}

/**
 * Retrieve a valid secret (API key or OAuth access token) for a provider from OpenCode.
 * Checks expiry if an expiration timestamp is recorded.
 */
export function openCodeCredential(providerId, { customPath = null, now = Date.now() } = {}) {
  const auth = readOpenCodeAuth(customPath);
  const entry = auth[providerId];
  if (!entry || typeof entry !== 'object') return null;

  if (entry.expires != null) {
    const expiresMs = entry.expires < 1e12 ? entry.expires * 1000 : entry.expires;
    const nowMs = now < 1e12 ? now * 1000 : now;
    if (expiresMs <= nowMs) return null;
  }

  if (typeof entry.access === 'string' && entry.access.trim()) {
    return entry.access.trim();
  }
  if (typeof entry.key === 'string' && entry.key.trim()) {
    return entry.key.trim();
  }
  return null;
}
