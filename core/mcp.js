import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mcpFile, writeJsonAtomic } from './paths.js';
import { readUserEnv } from './env.js';

const run = promisify(execFile);

/**
 * MCP servers give an AI client access to an outside service (an issue tracker, an
 * error reporter). Every client keeps its own private list and its own private login,
 * so connecting one service to four clients means doing the same job four times, and
 * a new machine repeats all of it.
 *
 * Switchboard stores the definition only: a name and an https URL. It holds no token,
 * opens no port and proxies nothing. Each client still performs its own sign-in and
 * keeps its own credentials, exactly as it does today.
 *
 * Registration delegates to each client's own CLI rather than editing its config file.
 * The file formats genuinely conflict (TOML versus JSON, `servers` versus `mcpServers`,
 * a `type` field that one client requires and another rejects) and at least one client
 * silently destroys its whole server list when handed a shape it does not expect. The
 * vendor knows its own dialect; we should not second-guess it.
 */

/**
 * Two tiers, deliberately.
 *
 * FEATURED is short and hand-checked: every URL here has been exercised directly or found
 * documented by the client vendor. It is what someone sees first, because a wall of
 * seventy-odd choices is not a starting point.
 *
 * CATALOG_FILE is the long tail, a snapshot of the remote-only entries from Docker's
 * public MCP catalogue. It is data, not a dependency: Docker is not needed to read it, or
 * to run anything. Regenerate it with `npm run catalog` when it goes stale.
 */
export const FEATURED = [
  {
    name: 'atlassian',
    label: 'Atlassian (Jira, Confluence)',
    url: 'https://mcp.atlassian.com/v1/mcp',
    note: 'Registers itself automatically and needs no client secret.',
  },
  {
    name: 'sentry',
    label: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
  },
  {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
  },
  {
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
  },
  {
    name: 'zapier',
    label: 'Zapier',
    url: 'https://mcp.zapier.com/api/v1/connect',
  },
  {
    name: 'slack',
    label: 'Slack',
    url: 'https://mcp.slack.com/mcp',
    // Slack publishes no registration endpoint and its token endpoint accepts only
    // client_secret_post, so a client must be a pre-registered confidential client.
    // Clients without that arrangement fail sign-in with "Dynamic client registration
    // not supported". Listed so the limitation is visible rather than rediscovered.
    caveat: 'Only clients Slack has pre-registered can sign in. Others fail at login.',
  },
].map((s) => ({ ...s, transport: s.transport ?? 'http', featured: true }));

let catalogCache = null;

/** The long-tail catalogue, read once. A missing or broken file just means no browse list. */
export function catalogServers() {
  if (catalogCache) return catalogCache;
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'catalog-remote.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    catalogCache = Array.isArray(parsed) ? parsed.map((s) => ({ ...s, featured: false })) : [];
  } catch {
    catalogCache = [];
  }
  return catalogCache;
}

/**
 * Search and filter the catalogue. Matching is on title, name, description and tags, so
 * "jira" finds Atlassian even though the word does not appear in its title.
 */
export function searchCatalog(servers, { query = '', category = '' } = {}) {
  const q = String(query).trim().toLowerCase();
  const cat = String(category).trim().toLowerCase();
  return servers.filter((s) => {
    if (cat && String(s.category ?? '').toLowerCase() !== cat) return false;
    if (!q) return true;
    const hay = [s.name, s.title, s.label, s.description, s.note, ...(s.tags ?? [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/** Categories present in a set of servers, with counts, most populated first. */
export function categoriesOf(servers) {
  const counts = new Map();
  for (const s of servers) {
    const c = String(s.category ?? 'other').toLowerCase();
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/**
 * How each client is told about a server. `shell` is set on Windows because these
 * entry points are variously .exe, .cmd and .ps1, and only the shell resolves all three.
 *
 * Claude Desktop is deliberately absent: its config file takes local commands only, and
 * writing a URL into it makes the application delete its entire server list. Its remote
 * connections are account-level and are configured on the vendor's website, not here.
 *
 * Cursor is deliberately absent for now: it ships no CLI for this, so supporting it means
 * editing its config file directly, and that is not code worth shipping untested.
 */
export const CLIENTS = {
  claude: {
    id: 'claude',
    name: 'Claude Code',
    bin: 'claude',
    addArgs: (s) => ['mcp', 'add', '-t', 'http', '-s', 'user', s.name, s.url],
    removeArgs: (s) => ['mcp', 'remove', '-s', 'user', s.name],
    listArgs: () => ['mcp', 'list'],
    site: 'https://claude.com/product/claude-code',
    format: 'json',
    rootKey: 'mcpServers',
    configFile: claudeUserConfigFile,
    // Claude records which servers it has signed in to, by url. Reading the names tells
    // us whether a registered server actually works; the tokens are never touched.
    authFile: () => path.join(readUserEnv('CLAUDE_CONFIG_DIR') || path.join(os.homedir(), '.claude'), '.credentials.json'),
    parseAuth: parseClaudeAuthorizedUrls,
  },
  codex: {
    id: 'codex',
    name: 'Codex',
    bin: 'codex',
    addArgs: (s) => ['mcp', 'add', s.name, '--url', s.url],
    removeArgs: (s) => ['mcp', 'remove', s.name],
    listArgs: () => ['mcp', 'list'],
    site: 'https://developers.openai.com/codex',
    format: 'toml',
    configFile: () => path.join(readUserEnv('CODEX_HOME') || path.join(os.homedir(), '.codex'), 'config.toml'),
  },
  /**
   * Junie is JetBrains' agent, and it reads a plain JSON file of the same shape as Claude
   * Code's. It is an IDE plugin rather than a command, so presence is the config folder
   * existing, not a binary on PATH.
   *
   * Note this is Junie specifically, not JetBrains AI Assistant, which keeps a separate
   * list in XML under each IDE version's options folder. Nor is it the IDE's own MCP
   * server, which is the opposite direction: the IDE exposing itself to agents.
   */
  junie: {
    id: 'junie',
    name: 'Junie',
    site: 'https://www.jetbrains.com/junie/',
    via: 'file',
    format: 'json',
    rootKey: 'mcpServers',
    entry: (s) => ({ url: s.url }),
    configFile: () => path.join(os.homedir(), '.junie', 'mcp', 'mcp.json'),
    detect: () => fs.existsSync(path.join(os.homedir(), '.junie')),
  },

  /**
   * VS Code is edited through its own config file rather than its CLI. `code --add-mcp`
   * can only add: no list, no remove, so the panel could never show or undo what it did.
   * It also takes a JSON string as one argument, and these entry points need a shell on
   * Windows, which mangles the quoting and makes the call fail outright.
   *
   * Writing this file is safe in a way Claude Desktop's is not: it is plain JSON with a
   * documented root key, and VS Code rereads it rather than rewriting it on launch.
   */
  vscode: {
    id: 'vscode',
    name: 'VS Code',
    bin: 'code',
    site: 'https://code.visualstudio.com/',
    via: 'file',
    // VS Code calls the map `servers`; everyone else calls it `mcpServers`.
    format: 'json',
    rootKey: 'servers',
    entry: (s) => ({ type: 'http', url: s.url }),
    configFile: () => path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Code', 'User', 'mcp.json'),
  },
};

/**
 * Claude Code keeps user-scope servers in `.claude.json`, but where that file lives
 * depends on CLAUDE_CONFIG_DIR: set, and it sits inside that folder; unset, and it sits
 * in the home directory. Getting this wrong reads a stale file and reports servers the
 * client is not actually loading, so the two cases are handled apart rather than joined.
 */
export function claudeUserConfigFile(envReader = readUserEnv) {
  const dir = envReader('CLAUDE_CONFIG_DIR');
  return dir ? path.join(dir, '.claude.json') : path.join(os.homedir(), '.claude.json');
}

/** First key of a TOML table path, honouring quotes: `a.b` and `"a".b` both give `a`. */
function firstTomlKey(tablePath) {
  const s = String(tablePath).trim();
  for (const q of ['"', "'"]) {
    if (s.startsWith(q)) {
      const end = s.indexOf(q, 1);
      return end > 0 ? s.slice(1, end) : null;
    }
  }
  const seg = s.split('.')[0].trim();
  return seg || null;
}

/**
 * Server names from a Codex config. Only the first path segment counts, so the sub-table
 * `[mcp_servers.foo.env]` is the same server as `[mcp_servers.foo]` and not a second one.
 */
export function parseCodexServerNames(toml) {
  const names = new Set();
  for (const line of String(toml ?? '').split(/\r?\n/)) {
    const m = line.match(/^\s*\[mcp_servers\.(.+)\]\s*$/);
    if (!m) continue;
    const first = firstTomlKey(m[1]);
    if (first) names.add(first);
  }
  return [...names];
}

/**
 * Add or replace one server in a JSON config, returning the new text.
 *
 * A file that is not valid JSON, or not an object, is refused outright rather than
 * rewritten. Silently replacing a config nobody can parse is how a client loses its whole
 * server list, and that is not a mistake worth making twice.
 */
export function upsertJsonServer(text, rootKey, name, entry) {
  const doc = parseJsonObject(text);
  const map = doc[rootKey];
  const servers = map && typeof map === 'object' && !Array.isArray(map) ? map : {};
  return JSON.stringify({ ...doc, [rootKey]: { ...servers, [name]: entry } }, null, 2) + '\n';
}

/** Remove one server from a JSON config. Reports whether anything actually changed. */
export function deleteJsonServer(text, rootKey, name) {
  const doc = parseJsonObject(text);
  const map = doc[rootKey];
  if (!map || typeof map !== 'object' || Array.isArray(map) || !(name in map)) {
    return { changed: false, out: text };
  }
  const servers = { ...map };
  delete servers[name];
  return { changed: true, out: JSON.stringify({ ...doc, [rootKey]: servers }, null, 2) + '\n' };
}

function parseJsonObject(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return {};
  let doc;
  try {
    doc = JSON.parse(raw);
  } catch {
    throw new Error('that config file is not valid JSON, so it has been left alone');
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    throw new Error('that config file is not a JSON object, so it has been left alone');
  }
  return doc;
}

/**
 * Urls Claude has an OAuth session for. The keys are `<serverName>|<hash>` and each entry
 * carries the url it was issued against, which is the reliable thing to match on: someone
 * may register the same service under a different name.
 */
export function parseClaudeAuthorizedUrls(text) {
  try {
    const map = JSON.parse(String(text ?? '')).mcpOAuth;
    if (!map || typeof map !== 'object') return [];
    return Object.values(map).map((e) => e && e.serverUrl).filter((u) => typeof u === 'string');
  } catch {
    return [];
  }
}

/** Server names from a JSON config. An unreadable or unexpected file reports nothing. */
export function parseJsonServerNames(text, rootKey) {
  try {
    const map = JSON.parse(text)?.[rootKey];
    return map && typeof map === 'object' && !Array.isArray(map) ? Object.keys(map) : [];
  } catch {
    return [];
  }
}

/**
 * Server names become config keys and command arguments in three different tools, so
 * keep them boring: lowercase, no spaces, no punctuation beyond a hyphen.
 */
export function isValidServerName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/** Only https endpoints. A URL reaches a shell, so anything exotic is refused outright. */
export function isValidHttpUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  if (/[\s"'`\\<>|&;$()]/.test(url)) return false;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** Throws with a readable reason, so callers do not have to compose the message. */
export function assertValidServer(server) {
  if (!server || typeof server !== 'object') throw new Error('a server needs a name and a url');
  if (!isValidServerName(server.name)) {
    throw new Error(`invalid server name: ${server.name}. Use lowercase letters, digits and hyphens.`);
  }
  if (!isValidHttpUrl(server.url)) {
    throw new Error(`invalid server url: ${server.url}. Use a plain https address.`);
  }
  return server;
}

/**
 * Servers a person added themselves, kept beside the account registry. The built-in
 * catalogue is code; this file is only ever what someone typed in.
 */
export function loadServers(file = mcpFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(parsed.servers)) return { servers: parsed.servers };
  } catch { /* first run or unreadable: start empty, never guess */ }
  return { servers: [] };
}

export function saveServers(registry, file = mcpFile()) {
  writeJsonAtomic(file, { servers: registry.servers });
}

export function addServer(registry, { name, url, label }) {
  assertValidServer({ name, url });
  if (registry.servers.some((s) => s.name === name)) {
    throw new Error(`a server named ${name} is already registered`);
  }
  const server = { name, url, label: label ? String(label) : name };
  registry.servers.push(server);
  return server;
}

export function removeServer(registry, name) {
  const before = registry.servers.length;
  registry.servers = registry.servers.filter((s) => s.name !== name);
  if (registry.servers.length === before) throw new Error(`no such server: ${name}`);
  return true;
}

/** Catalogue plus anything added locally, catalogue first, local wins on a name clash. */
export function allServers(registry = loadServers()) {
  return dedupeServers([...(registry.servers ?? []), ...FEATURED]);
}

/**
 * The default view: the short featured list, whatever was added by hand, and anything a
 * client already has registered even if it came from neither. The long catalogue is a
 * separate screen; showing eighty rows here would bury the handful that matter.
 */
export function yourServers(registry = loadServers(), clientIds = Object.keys(CLIENTS)) {
  const inUse = new Set();
  for (const id of clientIds) for (const n of registeredNames(id)) inUse.add(n);
  const extra = catalogServers().filter((s) => inUse.has(s.name));
  return dedupeServers([...(registry.servers ?? []), ...FEATURED, ...extra]);
}

/** Trailing slashes and casing differ between sources; the endpoint is what matters. */
export function sameEndpoint(a, b) {
  const norm = (u) => String(u ?? '').trim().toLowerCase().replace(/\/+$/, '');
  return Boolean(norm(a)) && norm(a) === norm(b);
}

/**
 * Keep the first entry for each service, matching on name AND on url.
 *
 * Both matter: the featured list calls Atlassian `atlassian` while the catalogue calls it
 * `atlassian-remote`, and they are the same endpoint. Deduping on name alone showed the
 * service twice, and the copy someone found by searching was the one their clients were
 * not registered against.
 */
export function dedupeServers(list) {
  const out = [];
  for (const s of list) {
    const existing = out.find((k) => k.name === s.name || sameEndpoint(k.url, s.url));
    if (!existing) {
      out.push({ ...s });
      continue;
    }
    // Curated on top of the catalogue: the first entry wins on identity and wording, but
    // takes any field it lacks from the duplicate. That is how the hand-written Atlassian
    // keeps its label and note while gaining the catalogue's description, category and
    // tags, which is what makes it findable by searching "jira".
    for (const key of ['description', 'category', 'tags', 'title', 'transport']) {
      if (existing[key] === undefined && s[key] !== undefined) existing[key] = s[key];
    }
  }
  return out;
}

/** Everything, for the browse screen: local first, then featured, then the catalogue. */
export function browseServers(registry = loadServers()) {
  return dedupeServers([...(registry.servers ?? []), ...FEATURED, ...catalogServers()]);
}

function client(clientId) {
  const c = CLIENTS[clientId];
  if (!c) throw new Error(`unknown client: ${clientId}`);
  return c;
}

const execOpts = { windowsHide: true, timeout: 60000, shell: process.platform === 'win32' };

/**
 * Whether the client is on this machine. Most are a binary on PATH; a plugin-style client
 * like Junie has no command, so it declares its own presence check instead.
 */
export async function clientAvailable(clientId) {
  const c = client(clientId);
  if (c.detect) {
    try {
      return Boolean(c.detect());
    } catch {
      return false;
    }
  }
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    await run(finder, [c.bin], execOpts);
    return true;
  } catch {
    return false;
  }
}

/**
 * Register one server with one client. Sign-in is the client's own business and may
 * open a browser; that is the vendor's flow and Switchboard neither drives nor sees it.
 */
export async function registerServer(clientId, server) {
  const c = client(clientId);
  assertValidServer(server);
  if (c.via === 'file') {
    const file = c.configFile();
    const out = upsertJsonServer(readIfPresent(file), c.rootKey, server.name, c.entry(server));
    writeConfig(file, out);
    return { ok: true, client: c.id, server: server.name, output: `Wrote ${server.name} to ${file}` };
  }
  const { stdout, stderr } = await run(c.bin, c.addArgs(server), execOpts);
  return { ok: true, client: c.id, server: server.name, output: `${stdout ?? ''}${stderr ?? ''}`.trim() };
}

export async function unregisterServer(clientId, server) {
  const c = client(clientId);
  assertValidServer(server);
  if (c.via === 'file') {
    const file = c.configFile();
    const { changed, out } = deleteJsonServer(readIfPresent(file), c.rootKey, server.name);
    if (!changed) return { ok: true, client: c.id, server: server.name, output: 'Nothing to remove.' };
    writeConfig(file, out);
    return { ok: true, client: c.id, server: server.name, output: `Removed ${server.name} from ${file}` };
  }
  if (!c.removeArgs) throw new Error(`${c.name} has no remove command.`);
  const { stdout, stderr } = await run(c.bin, c.removeArgs(server), execOpts);
  return { ok: true, client: c.id, server: server.name, output: `${stdout ?? ''}${stderr ?? ''}`.trim() };
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * Same discipline as every other vendor file this app edits: back up first, then write.
 * Unlike the one-off health fixes, servers get added and removed often, so old backups are
 * pruned rather than left to pile up in someone's config folder forever.
 */
export const BACKUPS_KEPT = 3;

function writeConfig(file, text, keep = BACKUPS_KEPT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    pruneBackups(file, keep);
  }
  fs.writeFileSync(file, text);
}

/** Keep the newest few backups of one file. Names sort chronologically, being ISO stamps. */
export function pruneBackups(file, keep = BACKUPS_KEPT, fsImpl = fs) {
  const dir = path.dirname(file);
  const prefix = path.basename(file) + '.bak-';
  let entries;
  try {
    entries = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  const stale = entries.filter((n) => n.startsWith(prefix)).sort().slice(0, -keep);
  for (const name of stale) {
    try {
      fsImpl.unlinkSync(path.join(dir, name));
    } catch { /* someone else removed it, or it is locked: not worth failing the write over */ }
  }
  return stale;
}

/**
 * What a client already has, read straight from its config file.
 *
 * Note the deliberate asymmetry: registering goes through the vendor's CLI because the
 * dialects are destructive to write by hand, but reading a file is harmless and instant.
 * Asking each CLI instead would mean running `mcp list`, and at least one of them health
 * checks every server first, which takes tens of seconds and would make the panel crawl.
 */
export function registeredNames(clientId) {
  const c = client(clientId);
  let text;
  try {
    text = fs.readFileSync(c.configFile(), 'utf8');
  } catch {
    return []; // no config yet, or unreadable: nothing is registered as far as we can tell
  }
  return c.format === 'toml' ? parseCodexServerNames(text) : parseJsonServerNames(text, c.rootKey);
}

/**
 * Urls a client holds a sign-in for, or null when it cannot say.
 *
 * Only some clients record this somewhere readable. Codex keeps MCP tokens in the Windows
 * credential store, so there is nothing on disk to read and the honest answer is "unknown"
 * rather than a guess. A green tick that means "signed out and broken" is worse than no tick.
 */
export function authorizedUrls(clientId) {
  const c = client(clientId);
  if (!c.authFile || !c.parseAuth) return null;
  try {
    return c.parseAuth(fs.readFileSync(c.authFile(), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * State for every known server against every client, in one pass. Each cell is one of:
 *   'off'        not registered
 *   'on'         registered, and this client cannot report whether it is signed in
 *   'ready'      registered and signed in
 *   'needs-auth' registered, and this client says it has no session for it
 */
export function registrationMatrix(servers, clientIds = Object.keys(CLIENTS)) {
  const names = {};
  const auth = {};
  for (const id of clientIds) {
    names[id] = new Set(registeredNames(id));
    const urls = authorizedUrls(id);
    auth[id] = urls === null ? null : new Set(urls);
  }
  return servers.map((s) => ({
    ...s,
    state: Object.fromEntries(clientIds.map((id) => {
      if (!names[id].has(s.name)) return [id, 'off'];
      if (auth[id] === null) return [id, 'on'];
      return [id, auth[id].has(s.url) ? 'ready' : 'needs-auth'];
    })),
  }));
}

/** Raw `mcp list` output, for the panel to show what a client currently believes. */
export async function listRegistered(clientId) {
  const c = client(clientId);
  if (!c.listArgs) return { client: c.id, supported: false, output: '' };
  try {
    const { stdout, stderr } = await run(c.bin, c.listArgs(), { ...execOpts, timeout: 120000 });
    return { client: c.id, supported: true, output: `${stdout ?? ''}${stderr ?? ''}`.trim() };
  } catch (e) {
    return { client: c.id, supported: true, output: '', error: String(e?.message ?? e) };
  }
}
