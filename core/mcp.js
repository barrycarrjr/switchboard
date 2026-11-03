import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { accountsFile, mcpFile, samePath, writeJsonAtomic } from './paths.js';
import { readUserEnv } from './env.js';

const run = promisify(execFile);

/**
 * MCP servers give an AI client access to an outside service (an issue tracker, an
 * error reporter) or a local tool. Every client keeps its own private list and its own
 * private login, so connecting one service to five clients means doing the same job five
 * times, and a new machine repeats all of it.
 *
 * Switchboard stores the definition only: a name and either an https URL or a local
 * command the client starts itself (`command`, optional `args`, optional `env`). It holds
 * no sign-in session, opens no port and proxies nothing. Each client still performs its
 * own sign-in and keeps its own credentials, exactly as it does today.
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
    // Anything else fails with "Dynamic client registration not supported", and a
    // file-edited client fails later and more quietly, having written config that cannot
    // work. Naming the clients that can use it stops the attempt rather than explaining
    // the wreckage afterwards.
    only: ['claude'],
    caveat: 'Only clients Slack has pre-registered can sign in. Others cannot use it at all.',
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
 * The filter that means "the hand-checked list", rather than one of the categories the
 * catalogue data carries. The catalogue has no category by this name, and a regenerated
 * catalogue that grew one would simply be filtered by this instead.
 */
export const SUGGESTED = 'suggested';

/**
 * Search and filter the catalogue. Matching is on title, name, description and tags, so
 * "jira" finds Atlassian even though the word does not appear in its title.
 */
export function searchCatalog(servers, { query = '', category = '' } = {}) {
  const q = String(query).trim().toLowerCase();
  const cat = String(category).trim().toLowerCase();
  return servers.filter((s) => {
    if (cat === SUGGESTED) {
      if (!s.featured) return false;
    } else if (cat && String(s.category ?? '').toLowerCase() !== cat) return false;
    if (!q) return true;
    const hay = [s.name, s.title, s.label, s.description, s.note, ...(s.tags ?? [])].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/**
 * Categories to filter by: the suggestions first, because they are the recommended place
 * to start, then the catalogue's own categories, most populated first.
 */
export function categoriesOf(servers) {
  const counts = new Map();
  for (const s of servers) {
    const c = String(s.category ?? 'other').toLowerCase();
    counts.set(c, (counts.get(c) ?? 0) + 1);
  }
  const rest = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const suggested = servers.filter((s) => s.featured).length;
  return suggested ? [{ name: SUGGESTED, count: suggested }, ...rest] : rest;
}

/** Command-line environment flags (`-e KEY=VAL` or `--env KEY=VAL`) from a server's `env` map. */
export function stdioEnvFlags(flag, env) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) return [];
  const out = [];
  for (const [k, v] of Object.entries(env)) {
    out.push(flag, `${k}=${v}`);
  }
  return out;
}

/** The environment map a JSON client entry carries, or nothing when there is none. */
function envPart(s) {
  return s.env && typeof s.env === 'object' && Object.keys(s.env).length ? { env: s.env } : {};
}

/**
 * How each client is told about a server, remote (`url`) or local (`command`). `shell` is
 * set on Windows because these entry points are variously .exe, .cmd and .ps1, and only
 * the shell resolves all three. That is also why every value that reaches a command line
 * is held to the strict checks below and quoted by quoteWinShellArgs.
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
    addArgs: (s) => s.url
      ? ['mcp', 'add', '-t', 'http', '-s', 'user', s.name, s.url]
      : ['mcp', 'add', '-t', 'stdio', '-s', 'user', s.name, ...stdioEnvFlags('-e', s.env), '--', s.command, ...(s.args ?? [])],
    removeArgs: (s) => ['mcp', 'remove', '-s', 'user', s.name],
    listArgs: () => ['mcp', 'list'],
    site: 'https://claude.com/product/claude-code',
    format: 'json',
    rootKey: 'mcpServers',
    // The entry as Claude writes it, for the account folders its own CLI does not reach.
    entry: (s) => s.url
      ? { type: 'http', url: s.url }
      : { type: 'stdio', command: s.command, args: Array.isArray(s.args) ? s.args : [], ...envPart(s) },
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
    addArgs: (s) => s.url
      ? ['mcp', 'add', s.name, '--url', s.url]
      : ['mcp', 'add', s.name, ...stdioEnvFlags('--env', s.env), '--', s.command, ...(s.args ?? [])],
    removeArgs: (s) => ['mcp', 'remove', s.name],
    listArgs: () => ['mcp', 'list'],
    site: 'https://developers.openai.com/codex',
    format: 'toml',
    configFile: () => path.join(readUserEnv('CODEX_HOME') || path.join(os.homedir(), '.codex'), 'config.toml'),
  },
  /**
   * Antigravity's `agy` CLI. Its flags must come before the server name; a flag placed
   * after the name is rejected, which is why `-e` sits earlier here than for Claude.
   */
  antigravity: {
    id: 'antigravity',
    name: 'Antigravity',
    bin: 'agy',
    addArgs: (s) => s.url
      ? ['mcp', 'add', '-t', 'http', s.name, s.url]
      : ['mcp', 'add', '-t', 'stdio', ...stdioEnvFlags('-e', s.env), s.name, '--', s.command, ...(s.args ?? [])],
    removeArgs: (s) => ['mcp', 'remove', s.name],
    listArgs: () => ['mcp', 'list'],
    site: 'https://antigravity.google',
    format: 'json',
    rootKey: 'mcpServers',
    // Both `url` (read by the copy of the agent T3 Code runs) and `serverUrl` (read by the
    // agy CLI), because the same file can be read by either and each ignores the other key.
    entry: (s) => s.url
      ? { url: s.url, serverUrl: s.url, disabled: false }
      : {
          command: s.command,
          ...(Array.isArray(s.args) && s.args.length ? { args: s.args } : {}),
          ...envPart(s),
          disabled: false,
        },
    configFile: () => antigravityConfigFile(),
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
    entry: (s) => s.url
      ? { url: s.url }
      : { command: s.command, ...(Array.isArray(s.args) && s.args.length ? { args: s.args } : {}), ...envPart(s) },
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
    entry: (s) => s.url
      ? { type: 'http', url: s.url }
      : { type: 'stdio', command: s.command, ...(Array.isArray(s.args) && s.args.length ? { args: s.args } : {}), ...envPart(s) },
    configFile: () => path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Code', 'User', 'mcp.json'),
  },
};

/**
 * Claude Code keeps user-scope servers in `.claude.json`, but where that file lives
 * depends on CLAUDE_CONFIG_DIR: set, and it sits inside that folder; unset, and it sits
 * in the home directory. Getting this wrong reads a stale file and reports servers the
 * client is not actually loading, so the two cases are handled apart rather than joined.
 */
export function claudeUserConfigFile(envReader = readUserEnv, home = os.homedir()) {
  const dir = envReader('CLAUDE_CONFIG_DIR');
  return dir ? path.join(dir, '.claude.json') : path.join(home, '.claude.json');
}

/** Antigravity's own MCP list. GEMINI_HOME moves the folder it sits in. */
export function antigravityConfigFile(envReader = readUserEnv, home = os.homedir()) {
  return path.join(envReader('GEMINI_HOME') || path.join(home, '.gemini'), 'config', 'mcp_config.json');
}

function uniquePaths(files) {
  const unique = [];
  for (const file of files) {
    if (!unique.some((u) => samePath(u, file))) unique.push(file);
  }
  return unique;
}

/**
 * Every user-level `.claude.json` that could be the one a Claude Code session reads: the
 * one CLAUDE_CONFIG_DIR points at now, the one in the home folder, and one per Claude
 * account registered here. Switching accounts moves CLAUDE_CONFIG_DIR, and a server that
 * lives in only one of these files silently vanishes from every session started under
 * another. The home folder's copy stays on the list because something may still start
 * Claude without the variable set.
 */
export function claudeAllConfigFiles({ envReader = readUserEnv, home = os.homedir(), accounts = accountsFile() } = {}) {
  const candidates = [claudeUserConfigFile(envReader, home), path.join(home, '.claude.json')];
  try {
    const parsed = JSON.parse(fs.readFileSync(accounts, 'utf8'));
    for (const acc of parsed?.accounts ?? []) {
      if (acc?.provider === 'claude' && typeof acc.home === 'string' && fs.existsSync(acc.home)) {
        candidates.push(path.join(acc.home, '.claude.json'));
      }
    }
  } catch { /* no accounts file yet: the first two are all there is */ }
  return uniquePaths(candidates);
}

/**
 * Every Antigravity MCP list on the machine: its own (`~/.gemini/config`), the IDE's
 * (`~/.gemini/antigravity-ide`), and one per profile T3 Code gives the copy of the agent it
 * runs (`~/.t3/userdata/providers/antigravity/<id>/config`). Each reads only its own file,
 * so a server added to one is invisible to the others until it is copied across.
 */
export function antigravityAllConfigFiles({ envReader = readUserEnv, home = os.homedir() } = {}) {
  const candidates = [antigravityConfigFile(envReader, home), path.join(home, '.gemini', 'config', 'mcp_config.json')];
  const ideDir = path.join(home, '.gemini', 'antigravity-ide');
  if (fs.existsSync(ideDir)) candidates.push(path.join(ideDir, 'mcp_config.json'));
  const t3Root = path.join(home, '.t3', 'userdata', 'providers', 'antigravity');
  try {
    for (const d of fs.readdirSync(t3Root, { withFileTypes: true })) {
      if (d.isDirectory()) candidates.push(path.join(t3Root, d.name, 'config', 'mcp_config.json'));
    }
  } catch { /* no T3 Code profiles, or the folder cannot be listed */ }
  return uniquePaths(candidates);
}

/** The files a multi-home client's servers can live in. Every other client has one. */
function clientConfigFiles(clientId) {
  if (clientId === 'claude') return claudeAllConfigFiles();
  if (clientId === 'antigravity') return antigravityAllConfigFiles();
  return [client(clientId).configFile()];
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

/** A TOML value of the form `key = "text"`, or null. Backslashes arrive doubled. */
function tomlString(line, keys) {
  const m = line.match(new RegExp(`^\\s*(${keys})\\s*=\\s*(["'])(.*?)\\2\\s*$`));
  if (!m) return null;
  const value = m[2] === '"' ? m[3].replace(/\\(["\\])/g, '$1') : m[3];
  return { key: m[1], value };
}

/**
 * Servers from a Codex config, as a name and whatever address it carries.
 *
 * Only the first path segment names the server, so the sub-table `[mcp_servers.foo.env]`
 * is the same server as `[mcp_servers.foo]` and not a second one. Addresses are read only
 * from the server's own table: a sub-table holds environment variables, which are that
 * person's secrets and are never read here.
 */
export function parseCodexServerEntries(toml) {
  const found = new Map();
  let own = null;
  for (const line of String(toml ?? '').split(/\r?\n/)) {
    const header = line.match(/^\s*\[(.+)\]\s*$/);
    if (header) {
      own = null;
      const table = header[1].trim().match(/^mcp_servers\.(.+)$/);
      if (!table) continue;
      const rest = table[1].trim();
      const first = firstTomlKey(rest);
      if (!first) continue;
      if (!found.has(first)) found.set(first, { name: first });
      // `[mcp_servers.foo]` is the server itself; `[mcp_servers.foo.env]` is not.
      if (rest === first || rest === `"${first}"` || rest === `'${first}'`) own = first;
      continue;
    }
    if (!own) continue;
    const pair = tomlString(line, 'url|command');
    if (pair && !found.get(own)[pair.key]) found.get(own)[pair.key] = pair.value;
  }
  return [...found.values()];
}

/** Server names from a Codex config. */
export function parseCodexServerNames(toml) {
  return parseCodexServerEntries(toml).map((s) => s.name);
}

/**
 * The arguments and environment of one local server in a Codex config, read only when
 * that server is being copied into another client, which cannot start it without them.
 * Best effort: anything this simple reader does not understand is left out, and what it
 * does read is checked again before it reaches a command line.
 */
function parseCodexStdioDetails(block, name) {
  const out = {};
  let section = null;
  for (const line of String(block ?? '').split(/\r?\n/)) {
    const header = line.match(/^\s*\[(.+)\]\s*$/);
    if (header) {
      const table = header[1].trim().match(/^mcp_servers\.(.+)$/);
      if (!table) { section = null; continue; }
      const rest = table[1].trim();
      if (rest === name || rest === `"${name}"` || rest === `'${name}'`) section = 'main';
      else if (rest === `${name}.env` || rest === `"${name}".env` || rest === `'${name}'.env`) section = 'env';
      else section = null;
      continue;
    }
    if (section === 'main') {
      const m = line.match(/^\s*args\s*=\s*\[(.*)\]\s*$/);
      if (m) {
        try {
          const parsed = JSON.parse(`[${m[1]}]`);
          if (Array.isArray(parsed) && parsed.every((x) => typeof x === 'string')) out.args = parsed;
        } catch { /* not the double-quoted form JSON can read: left out */ }
      }
    } else if (section === 'env') {
      const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(["'])(.*?)\2\s*$/);
      if (kv) {
        if (!out.env) out.env = {};
        out.env[kv[1]] = kv[2] === '"' ? kv[3].replace(/\\(["\\])/g, '$1') : kv[3];
      }
    }
  }
  return out;
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

/**
 * Servers from a JSON config, as a name and whatever address each carries: `url` (or
 * Antigravity's `serverUrl`) for a remote server, `command` for one the client starts
 * itself. An entry the client itself marks `disabled` is not running, so it is not
 * reported. An unreadable or unexpected file reports nothing. Arguments and environment
 * variables are deliberately not read here; they hold API keys, and nothing that shows a
 * server on screen needs them.
 */
export function parseJsonServerEntries(text, rootKey) {
  try {
    const map = JSON.parse(text)?.[rootKey];
    if (!map || typeof map !== 'object' || Array.isArray(map)) return [];
    return Object.entries(map)
      .filter(([, entry]) => !(entry && typeof entry === 'object' && entry.disabled === true))
      .map(([name, entry]) => {
        const out = { name };
        if (entry && typeof entry.url === 'string' && entry.url) out.url = entry.url;
        else if (entry && typeof entry.serverUrl === 'string' && entry.serverUrl) out.url = entry.serverUrl;
        if (entry && typeof entry.command === 'string' && entry.command) out.command = entry.command;
        return out;
      });
  } catch {
    return [];
  }
}

/** Server names from a JSON config. An unreadable or unexpected file reports nothing. */
export function parseJsonServerNames(text, rootKey) {
  return parseJsonServerEntries(text, rootKey).map((s) => s.name);
}

/**
 * Server names become config keys and command arguments in five different tools, so
 * keep them boring: lowercase, no spaces, no punctuation beyond a hyphen.
 */
export function isValidServerName(name) {
  return typeof name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(name);
}

/**
 * A name that is safe to remove: wider than the one we would create.
 *
 * Removing only ever needs a name. It is a key in a JSON config, or the last argument to
 * the client's own remove command, and on Windows that command goes through a shell, so
 * the name still has to be inert. But it does not have to be a name Switchboard would
 * have chosen: a client's config already holds `MCP_DOCKER` and `node_repl`, which the
 * stricter rule rejects for having a capital and an underscore. Holding removal to that
 * rule meant the panel showed a server it could not take back out.
 */
export function isRemovableServerName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name);
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

/**
 * Characters a local server's command, arguments and environment values may not contain.
 *
 * On Windows these values are joined into one line for cmd.exe (see CLIENTS), and a
 * client installed as a .cmd file hands them through cmd a second time. Quoting keeps
 * spaces in one piece, but only refusing these keeps a value from doing anything else:
 * `& | < > ( )` start or redirect another command, `^` is cmd's escape character, `%`
 * expands a variable whose value could itself carry any of the others, and `"` would let
 * a value close the quotes put around it. The rest are the POSIX shell's equivalents,
 * refused too so a definition means the same thing on every machine it is imported to.
 */
const SHELL_UNSAFE = /[\r\n\0"'`<>|&;$()%^]/;

/** A local stdio command (executable name or path), free of shell metacharacters. */
export function isValidStdioCommand(command) {
  if (typeof command !== 'string') return false;
  const trimmed = command.trim();
  if (!trimmed || trimmed.length > 512) return false;
  return !SHELL_UNSAFE.test(trimmed);
}

/** Optional stdio argument list: an array of non-empty strings held to the same rule. */
export function isValidStdioArgs(args) {
  if (args === undefined) return true;
  if (!Array.isArray(args) || args.length > 64) return false;
  return args.every((a) => typeof a === 'string' && a.length > 0 && a.length <= 512 && !SHELL_UNSAFE.test(a));
}

/** Optional stdio environment map: variable-name keys, and values held to the same rule. */
export function isValidStdioEnv(env) {
  if (env === undefined) return true;
  if (!env || typeof env !== 'object' || Array.isArray(env)) return false;
  const keys = Object.keys(env);
  if (keys.length > 64) return false;
  return keys.every((k) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(k)
    && typeof env[k] === 'string' && env[k].length <= 2048 && !SHELL_UNSAFE.test(env[k]));
}

/** Throws with a readable reason, so callers do not have to compose the message. */
export function assertValidServer(server) {
  if (!server || typeof server !== 'object') throw new Error('a server needs a name and a url or command');
  if (!isValidServerName(server.name)) {
    throw new Error(`invalid server name: ${server.name}. Use lowercase letters, digits and hyphens.`);
  }
  const hasUrl = server.url !== undefined && server.url !== null && String(server.url).trim() !== '';
  const hasCommand = server.command !== undefined && server.command !== null && String(server.command).trim() !== '';
  if (!hasUrl && !hasCommand) {
    throw new Error(`invalid server url: ${server.url}. Use a plain https address or a local command.`);
  }
  if (hasUrl) {
    if (!isValidHttpUrl(server.url)) {
      throw new Error(`invalid server url: ${server.url}. Use a plain https address.`);
    }
    return server;
  }
  if (!isValidStdioCommand(server.command)) {
    throw new Error(`invalid server command: ${server.command}. Use a program name or path with none of " ' \` < > | & ; $ ( ) % ^ in it.`);
  }
  if (!isValidStdioArgs(server.args)) {
    throw new Error(`invalid server args for ${server.name}: each must be a non-empty value with none of " ' \` < > | & ; $ ( ) % ^ in it.`);
  }
  if (!isValidStdioEnv(server.env)) {
    throw new Error(`invalid server env for ${server.name}: names must be variable names and values may not contain " ' \` < > | & ; $ ( ) % ^.`);
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
    if (Array.isArray(parsed.servers)) {
      return { servers: parsed.servers, disabled: Array.isArray(parsed.disabled) ? parsed.disabled : [] };
    }
  } catch { /* first run or unreadable: start empty, never guess */ }
  return { servers: [], disabled: [] };
}

export function saveServers(registry, file = mcpFile()) {
  writeJsonAtomic(file, { servers: registry.servers, disabled: registry.disabled ?? [] });
}

export function addServer(registry, { name, url, command, args, env, label, note } = {}) {
  const candidate = {
    name,
    ...(url !== undefined ? { url } : {}),
    ...(command !== undefined ? { command } : {}),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
  };
  assertValidServer(candidate);
  if (registry.servers.some((s) => s.name === name)) {
    throw new Error(`a server named ${name} is already registered`);
  }
  // A url wins when both arrive, exactly as it does when the server is registered, so what
  // is stored is what a client would actually be given.
  const local = !url && command;
  const server = {
    name,
    ...(url ? { url } : {}),
    ...(local ? { command: String(command).trim(), transport: 'stdio' } : {}),
    ...(local && Array.isArray(args) && args.length ? { args: [...args] } : {}),
    ...(local && env && typeof env === 'object' && Object.keys(env).length ? { env: { ...env } } : {}),
    ...(note ? { note: String(note) } : {}),
    label: label ? String(label) : name,
  };
  registry.servers.push(server);
  return server;
}

/**
 * The words after `switchboard mcp add`, as the definition they describe.
 *
 *   <name> <https url>
 *   <name> [-e KEY=VALUE ...] --stdio <command> [args...]
 *
 * Everything after the command belongs to it, flags included, so a server that takes
 * `--port 3000` can be written as it is. Anything else unexpected is refused rather than
 * dropped, because a definition missing a word it was given is a server that will not
 * start, and the place to find that out is here.
 */
export function parseMcpAddArgs(argv) {
  const usage = 'usage: switchboard mcp add <name> <https url>, or switchboard mcp add <name> [-e KEY=VALUE ...] --stdio <command> [args...]';
  const [name, ...rest] = argv ?? [];
  if (!name || name.startsWith('-')) throw new Error(usage);
  const stdioAt = rest.indexOf('--stdio');
  if (stdioAt === -1) {
    if (rest.length !== 1 || rest[0].startsWith('-')) throw new Error(usage);
    return { name, url: rest[0] };
  }
  const env = {};
  for (let i = 0; i < stdioAt; i++) {
    const flag = rest[i];
    if (flag !== '-e' && flag !== '--env') throw new Error(`unexpected ${flag} before --stdio. ${usage}`);
    const pair = rest[i + 1];
    const eq = typeof pair === 'string' && i + 1 < stdioAt ? pair.indexOf('=') : -1;
    if (eq < 1) throw new Error(`${flag} needs KEY=VALUE. ${usage}`);
    env[pair.slice(0, eq)] = pair.slice(eq + 1);
    i++;
  }
  const command = rest[stdioAt + 1];
  if (!command) throw new Error(`--stdio needs the command to run. ${usage}`);
  return {
    name,
    command,
    args: rest.slice(stdioAt + 2),
    ...(Object.keys(env).length ? { env } : {}),
  };
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
 * The default view: what is actually switched on. Everything any client has registered,
 * plus anything added here by hand, and nothing else.
 *
 * Suggestions used to be mixed in, which made the list read as a set of things already in
 * use when most of it was advertising. Suggestions now live on the browse screen under
 * their own filter, and this list answers one question only: what is turned on.
 *
 * A server a client has that Switchboard has never heard of still belongs here, because
 * it is running. Its name and address are taken from the client's own config, so it can
 * be shown honestly and removed again even though no catalogue entry describes it.
 */
export function activeServers(registry = loadServers(), clientIds = Object.keys(CLIENTS), read = registeredServers) {
  const known = [...FEATURED, ...catalogServers()];
  const found = [];
  for (const id of clientIds) {
    for (const entry of read(id)) {
      // A catalogue entry describes the service properly, so prefer it over the bare
      // name and url a client config carries.
      const described = known.find((k) => k.name === entry.name || sameEndpoint(k.url, entry.url));
      found.push(described ? { ...described } : { ...entry, discovered: true });
    }
  }
  // A server switched off from here is in no client config any more, so without this it
  // would disappear from the only list that can switch it back on. Where the same name
  // turns up twice, the switched-off description wins: it is the thing the row most needs
  // to say, and its address comes from the copy that was taken before anything moved.
  const off = disabledServers(registry);
  const byName = new Map(off.map((s) => [s.name, s]));
  // By name, because the order clients happen to list their servers in is arbitrary and
  // changes as they are edited. A list someone reads should not reshuffle itself.
  return dedupeServers([...(registry.servers ?? []), ...found, ...off])
    .map((s) => (byName.has(s.name) ? { ...s, ...byName.get(s.name) } : s))
    .sort((a, b) => displayName(a).localeCompare(displayName(b), undefined, { sensitivity: 'base' }));
}

/** What a row is called on screen: the curated label first, then the catalogue title. */
export function displayName(server) {
  return String(server?.label ?? server?.title ?? server?.name ?? '');
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
    for (const key of ['description', 'category', 'tags', 'title', 'transport', 'featured']) {
      if (existing[key] === undefined && s[key] !== undefined) existing[key] = s[key];
    }
  }
  return out;
}

/**
 * Everything, for the browse screen. Local entries are merged first so that a server
 * someone added by hand keeps its own address, then the suggestions are lifted to the top
 * of the finished list: they are the recommended starting point, so they are what the
 * screen opens on.
 */
export function browseServers(registry = loadServers()) {
  const all = dedupeServers([...(registry.servers ?? []), ...FEATURED, ...catalogServers()]);
  // Sorting is stable, so everything below the suggestions keeps catalogue order.
  return all.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)));
}

/**
 * A local server found in a client's config is listed by name and command only (see
 * parseJsonServerEntries), but copying it into another client needs its arguments and
 * environment too, or the copy cannot start. They are read from the client's own entry
 * at the moment of copying, checked like anything typed in, and never kept here.
 */
function enrichDiscoveredStdioServer(server, clientIds, capture) {
  if (!server || !server.command || server.url) return server;
  if (server.args !== undefined || server.env !== undefined) return server;
  for (const id of clientIds) {
    if (!CLIENTS[id]) continue;
    try {
      const stash = capture(id, server.name);
      if (!stash) continue;
      if (stash.format === 'json' && stash.entry && typeof stash.entry === 'object') {
        const enriched = { ...server };
        if (Array.isArray(stash.entry.args) && isValidStdioArgs(stash.entry.args)) enriched.args = [...stash.entry.args];
        if (stash.entry.env && typeof stash.entry.env === 'object' && isValidStdioEnv(stash.entry.env)) enriched.env = { ...stash.entry.env };
        return enriched;
      }
      if (stash.format === 'toml' && typeof stash.block === 'string') {
        const details = parseCodexStdioDetails(stash.block, server.name);
        const enriched = { ...server };
        if (details.args && isValidStdioArgs(details.args)) enriched.args = details.args;
        if (details.env && isValidStdioEnv(details.env)) enriched.env = details.env;
        return enriched;
      }
    } catch { /* that client's config cannot be read: try the next one */ }
  }
  return server;
}

/**
 * The definition behind a name: from the catalogue, from what was added by hand, or from
 * a client's own config. Registering and removing send a name and nothing else, so this
 * is the single place a name turns back into an address.
 *
 * The catalogue has to be part of that, and once was not: every browse row outside the
 * six suggestions failed with "no such server" the moment its button was clicked.
 */
export function resolveServerByName(name, registry = loadServers(), clientIds = Object.keys(CLIENTS), read = registeredServers, capture = captureClientEntry) {
  const found = browseServers(registry).find((s) => s.name === name)
    ?? activeServers(registry, clientIds, read).find((s) => s.name === name);
  if (!found) throw new Error(`no such server: ${name}`);
  return enrichDiscoveredStdioServer(found, clientIds, capture);
}

function client(clientId) {
  const c = CLIENTS[clientId];
  if (!c) throw new Error(`unknown client: ${clientId}`);
  return c;
}

const execOpts = { windowsHide: true, timeout: 60000 };

function runMcpCli(bin, rawArgs) {
  if (process.platform === 'win32') {
    const quoted = quoteWinShellArgs([bin, ...rawArgs], 'win32').join(' ');
    return run('cmd.exe', ['/d', '/s', '/v:off', '/c', `"${quoted}"`], {
      ...execOpts,
      shell: false,
      windowsVerbatimArguments: true,
    });
  }
  return run(bin, rawArgs, { ...execOpts, shell: false });
}

/**
 * Arguments as cmd.exe must see them. With `shell` set, Node joins the arguments with
 * spaces and quotes nothing, so a path with a space in it arrives as two arguments.
 * Wrapping a value that has whitespace keeps it whole. Nothing that reaches here can hold
 * a quote of its own (the checks above refuse one), so the wrapping cannot be closed
 * early. A trailing backslash is doubled, because the program on the other end would
 * otherwise read `\"` as a literal quote and run the next argument into this one.
 */
export function quoteWinShellArgs(args, platform = process.platform) {
  if (platform !== 'win32') return args;
  return args.map((a) => (typeof a === 'string' && /\s/.test(a) ? `"${a.replace(/(\\+)$/, '$1$1')}"` : a));
}

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
    await run(finder, [c.bin], { windowsHide: true, timeout: 4000 });
    return true;
  } catch {
    return false;
  }
}

/** Whether this definition is one Switchboard could register, without throwing to ask. */
export function canRegister(server) {
  try {
    assertValidServer(server);
    return true;
  } catch {
    return false;
  }
}

/** Whether a server can work in a given client at all. No `only` list means anywhere. */
export function supportsClient(server, clientId) {
  const only = server?.only;
  return !Array.isArray(only) || only.includes(clientId);
}

/**
 * Trim a CLI failure down to the part a person can act on.
 *
 * Raw, these arrive as the whole invocation followed by the tool's own stack of prefixes:
 * "Command failed: codex mcp add slack --url https://... Error: Registration failed:
 * Dynamic registration failed: Registration failed: Dynamic client registration not
 * supported". Echoing the command back says nothing the button did not, and the repeated
 * prefixes bury the one clause that matters.
 */
export function cleanCliError(text) {
  let s = String(text ?? '').replace(/\r/g, ' ').replace(/\n+/g, ' ').trim();
  s = s.replace(/^Command failed:\s*\S+(?:\s+\S+)*?(?=\s+Error:)/i, '').trim();
  s = s.replace(/^(?:Error:\s*)+/i, '').trim();
  // The tools stack their own prefixes; the last clause is the actual reason.
  const parts = s.split(/:\s+/).map((p) => p.trim()).filter(Boolean);
  const seen = new Set();
  const kept = parts.filter((p) => (seen.has(p.toLowerCase()) ? false : seen.add(p.toLowerCase())));
  const out = (kept.length ? kept[kept.length - 1] : s).trim();
  return out || 'the command failed without saying why';
}

/**
 * Read one JSON config for copying servers into it. The result says either what is in it
 * or why it must be left alone. A file that is missing is not reported: there is nothing
 * there to share with, and creating a client's whole state file just to hold a server
 * list is not this module's place. A file that cannot be read, is empty, will not parse,
 * or holds something other than a server map under the root key is reported and never
 * written, because rewriting a file nobody could read is how a client loses everything
 * in it. An empty file is most likely one its own client is part way through writing.
 */
function readServerMap(file, rootKey) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { skip: e?.code === 'ENOENT' ? null : 'it could not be read' };
  }
  if (!text.trim()) return { skip: 'it is empty' };
  let doc;
  try {
    doc = parseJsonObject(text);
  } catch (e) {
    return { skip: e.message };
  }
  const map = doc[rootKey];
  if (map !== undefined && (!map || typeof map !== 'object' || Array.isArray(map))) {
    return { skip: `its ${rootKey} is not a list of servers` };
  }
  return { doc, map: map ?? {} };
}

/**
 * Antigravity's two readers each look for a different key (see CLIENTS), so an entry
 * carrying only one of them is given the other, with the same address. Anything else is
 * returned exactly as it was.
 */
function withBothAddresses(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  if (typeof entry.serverUrl === 'string' && entry.serverUrl && entry.url === undefined) return { ...entry, url: entry.serverUrl };
  if (typeof entry.url === 'string' && entry.url && entry.serverUrl === undefined) return { ...entry, serverUrl: entry.url };
  return entry;
}

/**
 * Give every file in a set each server that any of them has.
 *
 * Only ever adds. An entry already in a file is never replaced, even where another file
 * describes the same name differently: the one already there may have been edited by
 * hand, and it is the one that file's sessions have been running. The single change made
 * to an existing entry is the Antigravity address key above, which adds a key with the
 * entry's own value and changes nothing it already says.
 */
function shareAcross(clientId, files, skipNames, summary) {
  const c = CLIENTS[clientId];
  const read = files.map((file) => ({ file, ...readServerMap(file, c.rootKey) }));
  const merged = new Map();
  for (const r of read) {
    if (!r.map) continue;
    for (const [name, entry] of Object.entries(r.map)) {
      if (skipNames.has(name) || merged.has(name)) continue;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
      merged.set(name, clientId === 'antigravity' ? withBothAddresses(entry) : entry);
    }
  }
  for (const r of read) {
    if (r.skip) summary.skipped.push({ file: r.file, reason: r.skip });
    if (!r.map) continue;
    const next = { ...r.map };
    let changed = false;
    for (const [name, entry] of merged) {
      if (!Object.hasOwn(next, name)) {
        next[name] = entry;
        changed = true;
      } else if (clientId === 'antigravity') {
        const filled = withBothAddresses(next[name]);
        if (filled !== next[name]) {
          next[name] = filled;
          changed = true;
        }
      }
    }
    if (!changed) continue;
    try {
      writeConfig(r.file, JSON.stringify({ ...r.doc, [c.rootKey]: next }, null, 2) + '\n');
      summary[clientId].push(r.file);
    } catch (e) {
      summary.skipped.push({ file: r.file, reason: `it could not be written: ${e?.message ?? e}` });
    }
  }
}

/**
 * Share MCP servers across every Claude Code account and every Antigravity home.
 *
 * Claude Code and Antigravity each keep several lists on one machine (see
 * claudeAllConfigFiles and antigravityAllConfigFiles), and each session reads exactly one
 * of them, so a server registered while one account was active was missing the moment
 * another was. This puts every server any list has into every other list of the same
 * client, backing each file up before it is changed. It runs whenever the MCP tab opens
 * and on `switchboard mcp`, so a server added outside Switchboard is shared too.
 *
 * A server switched off here is left out, or the next sync would quietly switch it back
 * on from whichever list still had a copy. The lists to work on can be handed in, which
 * is how the tests keep away from the real ones.
 */
export function syncClientAccountMirrors(registry = loadServers(), {
  claudeFiles = claudeAllConfigFiles(),
  antigravityFiles = antigravityAllConfigFiles(),
} = {}) {
  const skipNames = new Set((registry.disabled ?? []).map((d) => d.name));
  const summary = { claude: [], antigravity: [], skipped: [] };
  shareAcross('claude', claudeFiles, skipNames, summary);
  shareAcross('antigravity', antigravityFiles, skipNames, summary);
  return summary;
}

/**
 * After a client's own CLI has added a server, put the same entry in that client's other
 * lists, so it is there whichever account or home starts next. Additive like the sync:
 * a list that already has the name keeps its own entry, a list that does not exist yet is
 * not created, and one that cannot be parsed is left alone. The lists can be handed in,
 * which is how the tests keep away from the real ones.
 */
function addToClientMirrorFiles(clientId, name, entry, files = clientConfigFiles(clientId)) {
  const c = client(clientId);
  if (c.format !== 'json' || (clientId !== 'claude' && clientId !== 'antigravity')) return;
  for (const file of files) {
    const r = readServerMap(file, c.rootKey);
    if (!r.map || Object.hasOwn(r.map, name)) continue;
    try {
      writeConfig(file, JSON.stringify({ ...r.doc, [c.rootKey]: { ...r.map, [name]: entry } }, null, 2) + '\n');
    } catch { /* best effort: the client's own list already has it, and the next sync retries */ }
  }
}

/**
 * Take a server out of every list a multi-home client keeps. Without this, removing it
 * from the active account would last only until the next sync copied it back in from
 * another account's list.
 */
function removeFromClientMirrorFiles(clientId, name, files = clientConfigFiles(clientId)) {
  const c = client(clientId);
  if (c.format !== 'json' || (clientId !== 'claude' && clientId !== 'antigravity')) return;
  for (const file of files) {
    try {
      if (!fs.existsSync(file)) continue;
      const { changed, out } = deleteJsonServer(readIfPresent(file), c.rootKey, name);
      if (changed) writeConfig(file, out);
    } catch { /* a file that will not parse is left exactly as it is */ }
  }
}

/**
 * Register one server with one client. Sign-in is the client's own business and may
 * open a browser; that is the vendor's flow and Switchboard neither drives nor sees it.
 */
export async function registerServer(clientId, server) {
  const c = client(clientId);
  assertValidServer(server);
  if (!supportsClient(server, c.id)) {
    throw new Error(`${server.label ?? server.name} cannot be used from ${c.name}.`);
  }
  if (c.via === 'file') {
    const file = c.configFile();
    const out = upsertJsonServer(readIfPresent(file), c.rootKey, server.name, c.entry(server));
    writeConfig(file, out);
    return { ok: true, client: c.id, server: server.name, output: `Wrote ${server.name} to ${file}` };
  }

  // Some CLIs write the entry and then fail signing in, leaving a server the client lists
  // but cannot use. Left alone it reads as registered, which is the opposite of the truth,
  // so anything this call created is taken back out before the error is reported.
  const wasThere = registeredNames(c.id).includes(server.name);
  try {
    const { stdout, stderr } = await runMcpCli(c.bin, c.addArgs(server));
    if (c.entry) addToClientMirrorFiles(c.id, server.name, c.entry(server));
    return { ok: true, client: c.id, server: server.name, output: `${stdout ?? ''}${stderr ?? ''}`.trim() };
  } catch (e) {
    if (!wasThere && registeredNames(c.id).includes(server.name) && c.removeArgs) {
      try {
        await runMcpCli(c.bin, c.removeArgs(server));
      } catch { /* best effort: the reported failure matters more than a tidy rollback */ }
    }
    const err = new Error(`${c.name} could not add ${server.name}: ${cleanCliError(e?.stderr || e?.message || e)}`);
    err.rolledBack = !wasThere;
    throw err;
  }
}

/**
 * Take one server out of one client, and out of every list that client keeps.
 *
 * `run` and `files` exist for the tests: the client's CLI and the lists it reads can be
 * replaced, so a test can switch a server off across scratch copies of every account
 * without reaching a real CLI or a real config.
 */
export async function unregisterServer(clientId, server, { run = runMcpCli, files } = {}) {
  const c = client(clientId);
  // Deliberately not assertValidServer: that demands an address, and removing needs no
  // address at all. Requiring one refused to remove servers Switchboard could not describe.
  if (!isRemovableServerName(server?.name)) {
    throw new Error(`invalid server name: ${server?.name}`);
  }
  const lists = files ?? clientConfigFiles(c.id);
  if (c.via === 'file') {
    const file = files ? files[0] : c.configFile();
    const { changed, out } = deleteJsonServer(readIfPresent(file), c.rootKey, server.name);
    if (!changed) return { ok: true, client: c.id, server: server.name, output: 'Nothing to remove.' };
    writeConfig(file, out);
    return { ok: true, client: c.id, server: server.name, output: `Removed ${server.name} from ${file}` };
  }
  if (!c.removeArgs) throw new Error(`${c.name} has no remove command.`);
  let cliOut = '';
  try {
    const { stdout, stderr } = await run(c.bin, c.removeArgs(server));
    cliOut = `${stdout ?? ''}${stderr ?? ''}`.trim();
  } catch (e) {
    // The CLI only sees the active account's list, and fails when the server lives in
    // another one. The lists are removed from directly below either way, so for a client
    // that keeps several, that failure is not the answer.
    if (c.id !== 'claude' && c.id !== 'antigravity') throw e;
  }
  removeFromClientMirrorFiles(c.id, server.name, lists);
  if (registeredNames(c.id, lists).includes(server.name)) {
    throw new Error(`${c.name} could not remove ${server.name}: it is still listed in one of its config files`);
  }
  return { ok: true, client: c.id, server: server.name, output: cliOut || `Removed ${server.name}` };
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

/**
 * The write itself goes to a temporary file that is then renamed over the original, so a
 * client reading its config at the same moment (Claude Code reads `.claude.json`
 * constantly) sees the old file or the new one, never half of one.
 */
function writeConfig(file, text, keep = BACKUPS_KEPT) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    pruneBackups(file, keep);
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
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
 * What a client already has, read straight from its config files.
 *
 * Note the deliberate asymmetry: registering goes through the vendor's CLI because the
 * dialects are destructive to write by hand, but reading a file is harmless and instant.
 * Asking each CLI instead would mean running `mcp list`, and at least one of them health
 * checks every server first, which takes tens of seconds and would make the panel crawl.
 *
 * For a client that keeps several lists, a server in any of them counts: the sync makes
 * them agree, and until it has, the server is still one a session of that client can use.
 */
export function registeredServers(clientId, files = clientConfigFiles(clientId)) {
  const c = client(clientId);
  if (c.format === 'toml') {
    try {
      return parseCodexServerEntries(fs.readFileSync(files[0], 'utf8'));
    } catch {
      return []; // no config yet, or unreadable: nothing is registered as far as we can tell
    }
  }
  const byName = new Map();
  for (const file of files) {
    try {
      for (const entry of parseJsonServerEntries(fs.readFileSync(file, 'utf8'), c.rootKey)) {
        if (!byName.has(entry.name)) byName.set(entry.name, entry);
      }
    } catch { /* no config there yet */ }
  }
  return [...byName.values()];
}

/** Just the names, for the callers that only need to know whether a server is there. */
export function registeredNames(clientId, files) {
  return registeredServers(clientId, files).map((s) => s.name);
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
 * Classify how a server runs so the UI can distinguish zero-daemon remote or stdio
 * servers from Docker-backed servers that require Docker Desktop to be running.
 */
export function serverRuntime(server) {
  if (server?.runtime) return server.runtime;
  if (server?.url) return 'remote';
  const cmd = String(server?.command ?? '').trim().toLowerCase();
  if (cmd === 'docker' || cmd.endsWith('/docker') || cmd.endsWith('\\docker.exe') || cmd === 'docker.exe') {
    return 'docker';
  }
  if (cmd) return 'stdio';
  return 'unknown';
}

/**
 * Fast, zero-process check for whether the local Docker daemon socket or named pipe is
 * present. Used to warn when a Docker-tier MCP server is selected while Docker is stopped.
 */
export function isDockerAvailable({ platform = process.platform, home = os.homedir(), fsImpl = fs } = {}) {
  try {
    if (platform === 'win32') return Boolean(fsImpl.existsSync('\\\\.\\pipe\\docker_engine'));
    return Boolean(
      fsImpl.existsSync('/var/run/docker.sock')
      || fsImpl.existsSync(path.join(home, '.docker', 'run', 'docker.sock')),
    );
  } catch {
    return false;
  }
}

let serverToolsCache = { home: '', at: 0, map: null };
const SERVER_TOOLS_CACHE_TTL_MS = 30_000;

function getServerToolsIndex(home) {
  const now = Date.now();
  if (serverToolsCache.map && serverToolsCache.home === home && now - serverToolsCache.at < SERVER_TOOLS_CACHE_TTL_MS) {
    return serverToolsCache.map;
  }
  const index = new Map();
  const recordDir = (serverName, dirPath) => {
    if (!serverName) return;
    if (!index.has(serverName)) index.set(serverName, []);
    index.get(serverName).push(dirPath);
  };

  const geminiMcpRoot = path.join(home, '.gemini', 'antigravity', 'mcp');
  try {
    for (const d of fs.readdirSync(geminiMcpRoot, { withFileTypes: true })) {
      if (d.isDirectory()) recordDir(d.name, path.join(geminiMcpRoot, d.name));
    }
  } catch { /* no gemini mcp cache */ }

  const t3Root = path.join(home, '.t3', 'userdata', 'providers', 'antigravity');
  try {
    for (const prof of fs.readdirSync(t3Root, { withFileTypes: true })) {
      if (!prof.isDirectory()) continue;
      const brainRoot = path.join(t3Root, prof.name, 'antigravity-acp', 'brain');
      if (!fs.existsSync(brainRoot)) continue;
      for (const b of fs.readdirSync(brainRoot, { withFileTypes: true })) {
        if (!b.isDirectory()) continue;
        const mcpRoot = path.join(brainRoot, b.name, 'mcp');
        if (!fs.existsSync(mcpRoot)) continue;
        for (const s of fs.readdirSync(mcpRoot, { withFileTypes: true })) {
          if (s.isDirectory()) recordDir(s.name, path.join(mcpRoot, s.name));
        }
      }
    }
  } catch { /* no T3 brain directories */ }

  const parsedByServer = new Map();
  for (const [sName, dirs] of index.entries()) {
    const byName = new Map();
    for (const dir of dirs) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const fallbackName = entry.name.slice(0, -5);
        if (byName.has(fallbackName)) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
          const toolName = typeof raw?.name === 'string' && raw.name ? raw.name : fallbackName;
          const desc = typeof raw?.description === 'string'
            ? raw.description.trim().split(/\r?\n/)[0].slice(0, 180)
            : '';
          byName.set(toolName, { name: toolName, description: desc });
        } catch {
          byName.set(fallbackName, { name: fallbackName, description: '' });
        }
      }
      if (byName.size > 0) break;
    }
    const tools = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    parsedByServer.set(sName, { count: tools.length, tools });
  }

  if (home === os.homedir()) {
    serverToolsCache = { home, at: now, map: parsedByServer };
  }
  return parsedByServer;
}

/**
 * Inspect cached tool schemas for an MCP server on disk (written by Antigravity or ACP
 * brain sessions) so Switchboard can show tool counts and tool descriptions without
 * spawning the server itself.
 */
export function listServerTools(serverName, { home = os.homedir() } = {}) {
  if (!serverName || typeof serverName !== 'string') return { count: 0, tools: [] };
  const idx = getServerToolsIndex(home);
  return idx.get(serverName) ?? { count: 0, tools: [] };
}

/**
 * State for every known server against every client, in one pass. Each cell is one of:
 *   'off'        not registered
 *   'on'         registered, and this client cannot report whether it is signed in
 *   'ready'      registered and signed in
 *   'needs-auth' registered, and this client says it has no session for it
 *   'on-despite-disabled'
 *                registered, though the server is switched off here
 *
 * The last one exists because a server switched off here can come back into a client by
 * a route Switchboard never sees: someone adds it by hand, or another tool writes it.
 * Reporting that as a plain 'on' beside a row marked off says two contradictory things at
 * once, and the panel and the terminal need to be able to point at the mismatch instead.
 */
export function registrationMatrix(servers, clientIds = Object.keys(CLIENTS), read = {}) {
  const readNames = read.names ?? registeredNames;
  const readAuth = read.auth ?? authorizedUrls;
  const readTools = read.tools ?? ((name) => listServerTools(name).count);
  const names = {};
  const auth = {};
  for (const id of clientIds) {
    names[id] = new Set(readNames(id));
    const urls = readAuth(id);
    auth[id] = urls === null ? null : new Set(urls);
  }
  return servers.map((s) => ({
    ...s,
    runtime: serverRuntime(s),
    toolCount: s.toolCount ?? readTools(s.name),
    // Whether Switchboard could put this server into another client: a remote https
    // address, or a local command that passes the same checks as one typed in. A loopback
    // http address is shown where it is and offered nowhere else.
    addable: canRegister(s),
    state: Object.fromEntries(clientIds.map((id) => {
      if (!names[id].has(s.name)) return [id, 'off'];
      if (s.disabled) return [id, 'on-despite-disabled'];
      // Sign-in only applies to remote https servers. One the client starts itself, or a
      // loopback address, has nothing to sign in to, so reporting it as awaiting sign-in
      // would be a warning about nothing.
      if (auth[id] === null || !isValidHttpUrl(s.url)) return [id, 'on'];
      return [id, auth[id].has(s.url) ? 'ready' : 'needs-auth'];
    })),
  }));
}

/** Raw `mcp list` output, for the panel to show what a client currently believes. */
export async function listRegistered(clientId) {
  const c = client(clientId);
  if (!c.listArgs) return { client: c.id, supported: false, output: '' };
  try {
    const { stdout, stderr } = await runMcpCli(c.bin, c.listArgs());
    return { client: c.id, supported: true, output: `${stdout ?? ''}${stderr ?? ''}`.trim() };
  } catch (e) {
    return { client: c.id, supported: true, output: '', error: String(e?.message ?? e) };
  }
}

/**
 * Switching a whole server off, and back on again.
 *
 * Unchecking a server client by client works, but it is not the same job: someone who
 * wants Docker's gateway quiet wants it quiet everywhere, and for the servers most likely
 * to need that, taking them out is a one-way door. A server with a loopback address, or
 * a local one whose entry carries anything Switchboard would not write itself, can be
 * removed here but could never be put back from a definition.
 *
 * So switching off is a move, not a delete. Each client's own entry is copied out
 * verbatim first and kept in Switchboard's registry, then the client is told to remove
 * it; switching back on writes each copy where it came from. That is what makes the
 * greyed-out rows toggleable at all, and it is why the copy is taken before anything is
 * removed rather than reconstructed afterwards from a catalogue that never described it.
 *
 * The copy is the client's entry as written, arguments and environment included, because
 * a partial copy could not be put back. It lives beside the other app data, is never
 * shown in the panel, and is never written into an exported config.
 */

/**
 * One client's own entry for a server, taken verbatim. Null when that client has none.
 * For a client that keeps several lists, the first list that has it supplies the copy.
 */
export function captureClientEntry(clientId, name, file) {
  const c = client(clientId);
  const explicitFile = file !== undefined;
  for (const candidate of explicitFile ? [file] : clientConfigFiles(clientId)) {
    const text = readIfPresent(candidate);
    if (!text.trim()) continue;
    if (c.format === 'toml') {
      const block = extractCodexServerBlock(text, name);
      return block ? { format: 'toml', block } : null;
    }
    // parseJsonObject throws on a file that will not parse, and that is the right answer:
    // a config nobody can read is one nothing should be removed from either.
    const map = parseJsonObject(text)[c.rootKey];
    const entry = map && typeof map === 'object' && !Array.isArray(map) ? map[name] : undefined;
    if (entry && typeof entry === 'object') return { format: 'json', entry };
  }
  return null;
}

/**
 * The entry a multi-home client is running for a server right now, from the first of its
 * lists that has one, or null when none does.
 */
function liveJsonEntry(clientId, name, files) {
  const c = client(clientId);
  for (const file of files) {
    const r = readServerMap(file, c.rootKey);
    const entry = r.map?.[name];
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) return entry;
  }
  return null;
}

/**
 * Put one captured entry back where it came from, and into every other list the same
 * client keeps.
 *
 * A list that has the server again already is left alone rather than written twice:
 * someone may have put it back by hand between the two clicks, and theirs is the newer
 * entry. For the same reason, when any of a multi-home client's lists already has it, that
 * entry is the one the other lists are given, not the older copy. Stopping at the first
 * list that had it, as this once did, left the rest of that client's accounts without the
 * server and never told anyone.
 *
 * `mirrors` is the client's other lists, handed in beside an explicit `file` so a test can
 * keep to scratch copies. Without a file, every list on the machine is used.
 */
export function restoreClientEntry(clientId, name, stash, file, mirrors) {
  const c = client(clientId);
  const explicitFile = file !== undefined;
  const target = explicitFile ? file : c.configFile();
  const lists = explicitFile ? (mirrors ?? []) : clientConfigFiles(clientId);
  const usable = stash && (stash.format === 'toml' ? typeof stash.block === 'string' : Boolean(stash.entry));
  if (!usable) throw new Error(`nothing was kept for ${name} in ${c.name}`);
  const text = readIfPresent(target);
  // Read from the same text that is about to be rewritten, rather than asking what the
  // client has: the two could be different files if this one was handed in.
  const present = c.format === 'toml'
    ? parseCodexServerNames(text).includes(name)
    : parseJsonServerNames(text, c.rootKey).includes(name);
  const entry = stash.format === 'json' ? (liveJsonEntry(clientId, name, [target, ...lists]) ?? stash.entry) : null;
  if (!present) {
    const out = stash.format === 'toml'
      ? appendCodexServerBlock(text, stash.block)
      : upsertJsonServer(text, c.rootKey, name, entry);
    writeConfig(target, out);
  }
  if (stash.format === 'json') addToClientMirrorFiles(clientId, name, entry, lists);
  return { ok: true, client: c.id, server: name, output: present ? `${name} is already in ${target}` : `Put ${name} back into ${target}` };
}

/**
 * One server's tables lifted out of a Codex config, as text.
 *
 * Text rather than a parsed shape, because putting it back has to reproduce it exactly,
 * environment variables and all, and this module deliberately never reads those. The
 * server's sub-tables travel with it; a differently named server does not, even where
 * the two names share a prefix.
 */
export function extractCodexServerBlock(toml, name) {
  const lines = String(toml ?? '').split(/\r?\n/);
  const block = [];
  let mine = false;
  for (const line of lines) {
    const header = line.match(/^\s*\[(.+)\]\s*$/);
    if (header) {
      const table = header[1].trim().match(/^mcp_servers\.(.+)$/);
      mine = Boolean(table) && firstTomlKey(table[1].trim()) === name;
    }
    if (mine) block.push(line);
  }
  if (!block.length) return null;
  while (block.length && !block[block.length - 1].trim()) block.pop();
  return block.join('\n') + '\n';
}

/**
 * Add a captured server back to a Codex config, at the end.
 *
 * The end is always safe: every line after a table header belongs to that table, so a
 * complete block appended last cannot swallow anything that came before it.
 */
export function appendCodexServerBlock(toml, block) {
  const body = String(toml ?? '').replace(/\s+$/, '');
  // Blank lines in front go, indentation does not: Codex writes its own tables indented,
  // and putting a server back should put back what was there, to the space.
  const add = String(block ?? '').replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
  if (!add.trim()) return String(toml ?? '');
  return (body ? body + '\n\n' : '') + add + '\n';
}

/** Whatever address a captured entry carries, for a row that has to describe itself. */
export function describeStash(stash) {
  const out = {};
  if (!stash) return out;
  if (stash.format === 'toml') {
    const [found] = parseCodexServerEntries(stash.block);
    if (found?.url) out.url = found.url;
    if (found?.command) out.command = found.command;
    return out;
  }
  if (typeof stash.entry?.url === 'string') out.url = stash.entry.url;
  else if (typeof stash.entry?.serverUrl === 'string') out.url = stash.entry.serverUrl;
  if (typeof stash.entry?.command === 'string') out.command = stash.entry.command;
  return out;
}

/**
 * Switch one server off in every client that has it.
 *
 * A client whose entry cannot be read, or whose removal fails, is reported and left
 * exactly as it was. A half-done job is worth saying out loud, and the clients that did
 * work can still be switched back on.
 */
export async function disableServer(name, {
  registry = loadServers(),
  clientIds = Object.keys(CLIENTS),
  file = mcpFile(),
  read = registeredNames,
  capture = captureClientEntry,
  remove = unregisterServer,
} = {}) {
  if (!isRemovableServerName(name)) throw new Error(`invalid server name: ${name}`);
  const kept = {};
  const failed = [];
  for (const id of clientIds) {
    if (!CLIENTS[id] || !read(id).includes(name)) continue;
    let stash = null;
    try {
      stash = capture(id, name);
    } catch (e) {
      failed.push(`${CLIENTS[id].name}: ${e.message}`);
      continue;
    }
    if (!stash) {
      failed.push(`${CLIENTS[id].name}: its entry could not be read, so it was left alone`);
      continue;
    }
    try {
      await remove(id, { name });
      kept[id] = stash;
    } catch (e) {
      failed.push(`${CLIENTS[id].name}: ${cleanCliError(e?.stderr || e?.message || e)}`);
    }
  }
  if (!Object.keys(kept).length) {
    throw new Error(failed.length ? failed.join('; ') : `${name} is not registered with any client`);
  }
  const previous = (registry.disabled ?? []).find((d) => d.name === name);
  registry.disabled = [...(registry.disabled ?? []).filter((d) => d.name !== name), {
    name,
    at: new Date().toISOString(),
    // Anything already held for a client this run did not touch is kept, so switching a
    // server off twice in a row cannot strand the first half.
    clients: { ...(previous?.clients ?? {}), ...kept },
  }];
  saveServers(registry, file);
  return { ok: true, name, clients: Object.keys(kept), failed };
}

/** Switch one server back on, putting each client's own entry back where it came from. */
export function enableServer(name, { registry = loadServers(), file = mcpFile(), restore = restoreClientEntry } = {}) {
  const held = (registry.disabled ?? []).find((d) => d.name === name);
  if (!held) throw new Error(`${name} is not switched off`);
  const restored = [];
  const failed = [];
  const remaining = {};
  for (const [id, stash] of Object.entries(held.clients ?? {})) {
    if (!CLIENTS[id]) continue;
    try {
      restore(id, name, stash);
      restored.push(id);
    } catch (e) {
      failed.push(`${CLIENTS[id].name}: ${e.message}`);
      remaining[id] = stash;
    }
  }
  if (!restored.length) throw new Error(failed.length ? failed.join('; ') : `nothing was kept for ${name}`);
  // A client that refused keeps its copy, so the button can be pressed again. Throwing
  // away the only copy of an entry because one write failed is not a trade worth making.
  registry.disabled = (registry.disabled ?? [])
    .filter((d) => d.name !== name)
    .concat(Object.keys(remaining).length ? [{ ...held, clients: remaining }] : []);
  saveServers(registry, file);
  return { ok: true, name, clients: restored, failed };
}

/**
 * Servers switched off, described well enough to show a row for. They are in no client
 * config any more, so this is the only thing that can put them back on screen, and a row
 * nobody can see is a server nobody can switch back on.
 */
export function disabledServers(registry = loadServers()) {
  const known = [...FEATURED, ...catalogServers()];
  return (registry.disabled ?? []).map((held) => {
    const address = describeStash(Object.values(held.clients ?? {})[0]);
    const described = known.find((k) => k.name === held.name || sameEndpoint(k.url, address.url));
    return {
      ...(described ?? {}),
      ...address,
      name: held.name,
      disabled: true,
      disabledAt: held.at ?? null,
      disabledClients: Object.keys(held.clients ?? {}),
    };
  });
}
