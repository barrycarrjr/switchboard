import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accountsFile, samePath, writeJsonAtomic } from './paths.js';
import { readUserEnv, setUserEnv } from './env.js';

/**
 * An account is a label plus a vendor config folder. Nothing else is stored:
 * credentials stay in the vendor's own folder, owned by the vendor's own login flow.
 *
 * A tool only belongs here if its own environment variable can move the whole login
 * to another folder. Two shapes exist and they are not interchangeable:
 *
 *   envShape 'home'    the variable names the config folder itself
 *                      (CLAUDE_CONFIG_DIR=...\.claude-work)
 *   envShape 'parent'  the variable names a stand-in home directory and the tool
 *                      appends its own folder name (GEMINI_CLI_HOME=...\work, so
 *                      the config folder is ...\work\.gemini)
 *
 * Tools whose sign-in lives outside the config folder are deliberately absent.
 * GitHub Copilot CLI is the case in point: COPILOT_HOME moves its settings, but the
 * token sits in Windows Credential Manager keyed by GitHub login, so a second folder
 * would look like a second account and share the first one's identity.
 */
export const PROVIDERS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    envVar: 'CLAUDE_CONFIG_DIR',
    envShape: 'home',
    dirName: '.claude',
    credFile: '.credentials.json',
    loginHint: 'claude auth login --claudeai',
    loginCmd: 'claude auth login --claudeai',
    loginNote: 'Complete the browser sign-in; this terminal is scoped to this account.',
    quota: 'claude',
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    envVar: 'CODEX_HOME',
    envShape: 'home',
    dirName: '.codex',
    credFile: 'auth.json',
    loginHint: 'codex login',
    loginCmd: 'codex login',
    quota: 'codex',
    usageUrl: 'https://chatgpt.com/codex/settings/usage',
  },
  gemini: {
    id: 'gemini',
    name: 'Gemini CLI',
    envVar: 'GEMINI_CLI_HOME',
    envShape: 'parent',
    dirName: '.gemini',
    credFile: 'oauth_creds.json',
    loginHint: 'gemini (then choose "Login with Google")',
    loginCmd: 'gemini',
    loginNote: 'Choose "Login with Google" when the CLI asks how to authenticate.',
    // Antigravity keeps its own state in ~/.gemini too, so the folder existing is no
    // evidence that Gemini CLI is signed in there. Only a credential file is.
    sharedDirName: true,
    quota: null,
    quotaNote: 'Google publishes no usage endpoint for Gemini CLI sign-ins, so Switchboard has nothing honest to show.',
  },
  qwen: {
    id: 'qwen',
    name: 'Qwen Code',
    envVar: 'QWEN_HOME',
    envShape: 'home',
    dirName: '.qwen',
    credFile: 'oauth_creds.json',
    loginHint: 'qwen (then choose "Qwen OAuth")',
    loginCmd: 'qwen',
    loginNote: 'Choose "Qwen OAuth" when the CLI asks how to authenticate.',
    quota: null,
    quotaNote: 'Qwen publishes no usage endpoint for OAuth sign-ins, so Switchboard has nothing honest to show.',
  },
};

// Convenience method kept on the definition so callers can ask a provider for its own
// default without importing the helper.
for (const def of Object.values(PROVIDERS)) {
  def.defaultHome = () => defaultHome(def);
}

export function providerDef(provider) {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`unknown provider: ${provider}`);
  return def;
}

/** The config folder a provider uses when its variable is unset. */
export function defaultHome(def, homeDir = os.homedir()) {
  return path.join(homeDir, def.dirName);
}

/** The config folder a value of the provider's variable selects. */
export function homeFromEnvValue(def, value) {
  if (!value) return null;
  return def.envShape === 'parent' ? path.join(value, def.dirName) : value;
}

/** The value the provider's variable needs in order to select this config folder. */
export function envValueForHome(def, home) {
  return def.envShape === 'parent' ? path.dirname(path.resolve(home)) : path.resolve(home);
}

// These credentials outrank a Claude config-folder login. Account-scoped terminals
// must not inherit them or a sign-in/use action can silently target the wrong account.
export const CLAUDE_CREDENTIAL_ENV_VARS = [
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_REFRESH_TOKEN',
  'CLAUDE_CODE_OAUTH_SCOPES',
  'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR',
  'CCR_OAUTH_TOKEN_FILE',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'CLAUDE_SECURESTORAGE_CONFIG_DIR',
];

/** Persistent/current inputs that can make changing CLAUDE_CONFIG_DIR ineffective. */
export function configuredClaudeCredentialOverrides({
  user = () => null,
  machine = () => null,
  processEnv = process.env,
} = {}) {
  const current = new Set(Object.entries(processEnv ?? {})
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name.toUpperCase()));
  return CLAUDE_CREDENTIAL_ENV_VARS
    .filter((name) => name !== 'CLAUDE_CODE_OAUTH_SCOPES')
    .filter((name) => Boolean(user(name) || machine(name) || current.has(name.toUpperCase())));
}

/** Build a child environment that resolves to exactly one registered account. */
export function accountScopedEnv(account, baseEnv = process.env) {
  const def = providerDef(account?.provider);
  const rejected = new Set([def.envVar.toUpperCase()]);
  if (account.provider === 'claude') {
    for (const name of CLAUDE_CREDENTIAL_ENV_VARS) rejected.add(name.toUpperCase());
  }
  const env = {};
  for (const [name, value] of Object.entries(baseEnv ?? {})) {
    // Windows treats environment names case-insensitively even though a JS object does not.
    if (!rejected.has(name.toUpperCase())) env[name] = value;
  }
  env[def.envVar] = envValueForHome(def, account.home);
  return env;
}

/**
 * Turn a folder someone picked into the folder the vendor will actually read.
 * A 'parent' shaped tool always appends its own folder name, so picking
 * "C:\profiles\work" means the account really lives in "C:\profiles\work\.gemini".
 */
export function normalizeHome(provider, picked) {
  const def = providerDef(provider);
  const resolved = path.resolve(picked);
  if (def.envShape !== 'parent') return resolved;
  return path.basename(resolved).toLowerCase() === def.dirName.toLowerCase()
    ? resolved
    : path.join(resolved, def.dirName);
}

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
  const def = providerDef(provider);
  if (!label || !home) throw new Error('label and home are required');
  const resolved = path.resolve(home);
  // A 'parent' shaped variable can only ever select a folder with the vendor's own
  // name, so registering any other folder would produce an account that silently
  // never activates. Refuse it here rather than let the switch quietly do nothing.
  if (def.envShape === 'parent' && path.basename(resolved).toLowerCase() !== def.dirName.toLowerCase()) {
    throw new Error(`a ${def.name} account folder must be named ${def.dirName}: ${def.envVar} names the folder above it`);
  }
  if (registry.accounts.some((a) => a.provider === provider && samePath(a.home, resolved))) {
    throw new Error('that folder is already registered for this provider');
  }
  let id = `${provider}-${slug(label)}`;
  let n = 2;
  while (registry.accounts.some((a) => a.id === id)) id = `${provider}-${slug(label)}-${n++}`;
  const account = { id, provider, label: String(label), home: resolved };
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
export function detectDefaults(registry, homeDir = os.homedir()) {
  const found = [];
  for (const p of Object.values(PROVIDERS)) {
    const home = defaultHome(p, homeDir);
    if (!fs.existsSync(home)) continue;
    if (p.sharedDirName && !fs.existsSync(path.join(home, p.credFile))) continue;
    if (registry.accounts.some((a) => a.provider === p.id && samePath(a.home, home))) continue;
    found.push({ provider: p.id, label: 'Default', home });
  }
  return found;
}

function dirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return [];
  }
}

/**
 * Config folders that LOOK like additional accounts but are not registered.
 * These are offered, never auto-registered: only the person knows what a folder is for.
 *
 * Where to look follows the variable's shape. A 'home' shaped tool can be pointed at
 * any folder, so sibling dot-folders (~/.claude-work) are the convention. A 'parent'
 * shaped tool can only ever read its own folder name, so its extra accounts live one
 * level down (~/work/.gemini) and that is the only place worth scanning.
 */
export function detectCandidates(registry, homeDir = os.homedir()) {
  const candidates = [];
  const entries = dirEntries(homeDir);
  const known = (provider, home) => registry.accounts.some((a) => a.provider === provider && samePath(a.home, home));

  for (const p of Object.values(PROVIDERS)) {
    const home = defaultHome(p, homeDir);
    if (p.envShape === 'parent') {
      for (const entry of entries) {
        const candidate = path.join(homeDir, entry.name, p.dirName);
        if (samePath(candidate, home)) continue;
        if (!fs.existsSync(path.join(candidate, p.credFile))) continue;
        if (known(p.id, candidate)) continue;
        candidates.push({ provider: p.id, label: entry.name, home: candidate });
      }
      continue;
    }
    for (const entry of entries) {
      if (!entry.name.startsWith(p.dirName)) continue;
      const candidate = path.join(homeDir, entry.name);
      if (samePath(candidate, home)) continue; // defaults are handled elsewhere
      if (!fs.existsSync(path.join(candidate, p.credFile))) continue; // must actually be signed in
      if (known(p.id, candidate)) continue;
      const label = entry.name.replace(p.dirName, '').replace(/^[-_.]+/, '') || entry.name;
      candidates.push({ provider: p.id, label, home: candidate });
    }
  }
  return candidates;
}

/** The home a NEW process would use for this provider right now. */
export function activeHome(provider, envReader = readUserEnv) {
  const def = providerDef(provider);
  return homeFromEnvValue(def, envReader(def.envVar)) || defaultHome(def);
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
  const def = providerDef(account.provider);
  envSetter(def.envVar, envValueForHome(def, account.home));
  return account;
}
