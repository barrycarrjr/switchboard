import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountsFile, samePath, writeJsonAtomic } from './paths.js';
import { readUserEnv, setUserEnv } from './env.js';

/**
 * An account is a label plus a vendor config folder. Nothing else is stored:
 * credentials stay in the vendor's own folder, owned by the vendor's own login flow.
 */
export const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    envVar: 'CLAUDE_CONFIG_DIR',
    defaultHome: () => path.join(os.homedir(), '.claude'),
    credFile: '.credentials.json',
    loginHint: 'claude setup-token (run inside a terminal after switching to this account)',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    envVar: 'CODEX_HOME',
    defaultHome: () => path.join(os.homedir(), '.codex'),
    credFile: 'auth.json',
    loginHint: 'codex login',
  },
};

export function loadRegistry(file = accountsFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed.accounts)) return { accounts: parsed.accounts };
  } catch { /* first run or unreadable: start empty, never guess */ }
  return { accounts: [] };
}

export function saveRegistry(registry, file = accountsFile()) {
  writeJsonAtomic(file, { accounts: registry.accounts });
}

function slug(label) {
  return String(label).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'account';
}

export function addAccount(registry, { provider, label, home }) {
  if (!PROVIDERS[provider]) throw new Error(`unknown provider: ${provider}`);
  if (!label || !home) throw new Error('label and home are required');
  if (registry.accounts.some((a) => a.provider === provider && samePath(a.home, home))) {
    throw new Error('that folder is already registered for this provider');
  }
  let id = `${provider}-${slug(label)}`;
  let n = 2;
  while (registry.accounts.some((a) => a.id === id)) id = `${provider}-${slug(label)}-${n++}`;
  const account = { id, provider, label: String(label), home: path.resolve(home) };
  registry.accounts.push(account);
  return account;
}

/** Rename keeps the id stable so nothing that references the account breaks. */
export function renameAccount(registry, id, label) {
  const account = registry.accounts.find((a) => a.id === id);
  if (!account) throw new Error(`no such account: ${id}`);
  const clean = String(label ?? '').trim();
  if (!clean) throw new Error('label cannot be empty');
  account.label = clean;
  return account;
}

export function removeAccount(registry, id) {
  const i = registry.accounts.findIndex((a) => a.id === id);
  if (i === -1) throw new Error(`no such account: ${id}`);
  return registry.accounts.splice(i, 1)[0];
}

/** Vendor homes that exist on disk but are not registered yet. */
export function detectDefaults(registry) {
  const found = [];
  for (const p of Object.values(PROVIDERS)) {
    const home = p.defaultHome();
    if (!fs.existsSync(home)) continue;
    if (registry.accounts.some((a) => a.provider === p.id && samePath(a.home, home))) continue;
    found.push({ provider: p.id, label: 'Default', home });
  }
  return found;
}

const CANDIDATE_PREFIX = { claude: '.claude', codex: '.codex' };

/**
 * Sibling config folders that LOOK like additional accounts (a dot-folder named after
 * the vendor that contains the vendor's credential file) but are not registered.
 * These are offered, never auto-registered: only the person knows what a folder is for.
 */
export function detectCandidates(registry, homeDir = os.homedir()) {
  const candidates = [];
  let entries = [];
  try {
    entries = fs.readdirSync(homeDir, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const p of Object.values(PROVIDERS)) {
    const prefix = CANDIDATE_PREFIX[p.id];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
      const home = path.join(homeDir, entry.name);
      if (samePath(home, p.defaultHome())) continue; // defaults are handled elsewhere
      if (!fs.existsSync(path.join(home, p.credFile))) continue; // must actually be signed in
      if (registry.accounts.some((a) => a.provider === p.id && samePath(a.home, home))) continue;
      const label = entry.name.replace(prefix, '').replace(/^[-_.]+/, '') || entry.name;
      candidates.push({ provider: p.id, label, home });
    }
  }
  return candidates;
}

/** The home a NEW process would use for this provider right now. */
export function activeHome(provider, envReader = readUserEnv) {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`unknown provider: ${provider}`);
  return envReader(def.envVar) || def.defaultHome();
}

/** Resolve the active home to a registered account, if any. */
export function activeAccount(registry, provider, envReader = readUserEnv) {
  const home = activeHome(provider, envReader);
  return registry.accounts.find((a) => a.provider === provider && samePath(a.home, home)) || null;
}

/**
 * Make an account the machine default for new processes. Always sets the variable
 * to an explicit path (never deletes it), so the state is inspectable and undoable.
 */
export function setActive(registry, id, envSetter = setUserEnv) {
  const account = registry.accounts.find((a) => a.id === id);
  if (!account) throw new Error(`no such account: ${id}`);
  const def = PROVIDERS[account.provider];
  envSetter(def.envVar, account.home);
  return account;
}
