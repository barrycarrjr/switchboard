import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  accountsFile,
  customizationsDir,
  customizationsFile,
  ensureDir,
  samePath,
  writeJsonAtomic,
} from './paths.js';
import { readUserEnv } from './env.js';
import { TOOLS } from './providers.js';
import { PROVIDERS } from './accounts.js';
import {
  BACKUPS_KEPT,
  CLIENTS as MCP_CLIENTS,
  browseServers,
  isDockerAvailable,
  listServerTools,
  loadServers,
  pruneBackups,
  serverRuntime,
} from './mcp.js';

/**
 * Customizations control plane: unifies Plugins, Skills & Rules, Custom Agents, and
 * MCP Servers across every AI provider on the machine.
 *
 * Design principles:
 * 1. Dynamic provider eligibility: any tool defined in core/providers.js (claude, codex,
 *    antigravity, gemini, copilot, junie, qwen, amp, opencode, grok, cursor, aider, etc.)
 *    automatically becomes an eligible customization target as soon as it is installed,
 *    has a config folder, or has a registered account in Switchboard.
 * 2. Multi-account fan-out: writing a skill, rule, or custom agent to a provider fans out
 *    across its default home and every registered account home in accounts.json.
 * 3. Trusted, self-updating Marketplace: reads local vendor marketplace caches dropped by
 *    Google Antigravity, Anthropic Claude Code, and OpenAI Codex alongside Switchboard's
 *    MCP registry and a curated seed list so the catalog stays populated with zero manual
 *    maintenance.
 */

export const CUSTOMIZATION_KINDS = [
  'all',
  'plugin',
  'skill',
  'agent',
  'mcp-remote',
  'mcp-stdio',
  'mcp-docker',
];

export const MARKETPLACE_SOURCES = [
  { id: 'all', label: 'All Trusted Sources' },
  { id: 'google', label: 'Google Antigravity' },
  { id: 'anthropic', label: 'Anthropic Claude' },
  { id: 'openai', label: 'OpenAI Codex' },
  { id: 'mcp-registry', label: 'Official MCP Registry' },
];

/**
 * Curated seed items from official vendor catalogs (Google Antigravity, Anthropic Claude
 * Code, OpenAI Codex) so a fresh install with empty local caches still presents a rich,
 * trusted Marketplace immediately. When local vendor caches exist on disk, their live
 * entries merge over these seeds automatically.
 */
export const TRUSTED_SEED_ITEMS = [
  {
    name: 'modern-web-guidance-plugin',
    title: 'Modern Web Guidance',
    kind: 'plugin',
    runtime: 'skill-bundle',
    category: 'development',
    featured: true,
    author: 'Google Antigravity Team',
    description: 'Baseline modern web design and engineering standards (2025-2026) with responsive grid, baseline CSS, and theme tokens.',
    sources: ['google'],
    skills: ['modern-web-guidance'],
    suggestedPrompts: [
      'Build a responsive dashboard using modern baseline CSS features',
      'Audit this page for dark/light theme token compliance',
    ],
  },
  {
    name: 'chrome-devtools-plugin',
    title: 'Chrome DevTools',
    kind: 'plugin',
    runtime: 'stdio',
    category: 'browser',
    featured: true,
    author: 'Google Chrome DevTools Team',
    description: 'Control and inspect a live Chrome browser with performance traces, DOM snapshots, network inspection, and console debugging.',
    sources: ['google', 'anthropic'],
    skills: ['chrome-devtools', 'chrome-devtools-cli'],
    repository: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
  {
    name: 'frontend-design',
    title: 'Frontend Design Skill',
    kind: 'skill',
    runtime: 'skill',
    category: 'design',
    featured: true,
    author: 'Anthropic',
    description: 'Create distinctive, production-grade frontend interfaces with strong typography, layout choreography, and visual polish.',
    sources: ['anthropic'],
    skills: ['frontend-design'],
  },
  {
    name: 'context7-plugin',
    title: 'Context7 Live Docs',
    kind: 'plugin',
    runtime: 'remote',
    category: 'documentation',
    featured: true,
    author: 'Upstash',
    description: 'Up-to-date, version-specific documentation and code examples for libraries and frameworks fetched directly into agent context.',
    sources: ['google', 'anthropic', 'mcp-registry'],
    repository: 'https://github.com/upstash/context7',
  },
  {
    name: 'security-guidance',
    title: 'Security Guidance',
    kind: 'plugin',
    runtime: 'skill-bundle',
    category: 'security',
    featured: true,
    author: 'Anthropic',
    description: 'Security auditing workflow and guardrails for command injection, XSS, auth boundaries, and unsafe deserialization.',
    sources: ['anthropic'],
    skills: ['security-guidance'],
  },
  {
    name: 'code-review',
    title: 'PR Code Review Suite',
    kind: 'plugin',
    runtime: 'skill-bundle',
    category: 'developer-tools',
    featured: true,
    author: 'Anthropic',
    description: 'Automated pull request review workflow using specialized confidence-scored review passes.',
    sources: ['anthropic', 'openai'],
    skills: ['code-review'],
  },
  {
    name: 'playwright-automation',
    title: 'Playwright Browser Automation',
    kind: 'plugin',
    runtime: 'stdio',
    category: 'testing',
    featured: true,
    author: 'Microsoft',
    description: 'Browser automation and end-to-end test generation powered by Playwright accessibility snapshots.',
    sources: ['anthropic', 'google', 'mcp-registry'],
    repository: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    name: 'supabase-plugin',
    title: 'Supabase Full-Stack Toolkit',
    kind: 'plugin',
    runtime: 'remote',
    category: 'database',
    featured: true,
    author: 'Supabase',
    description: 'Manage Supabase projects, Postgres schemas, Edge Functions, and RLS policies with built-in Postgres best practices.',
    sources: ['google', 'anthropic', 'mcp-registry'],
    skills: ['supabase-postgres-best-practices'],
  },
  {
    name: 'stripe-plugin',
    title: 'Stripe Payments & Billing',
    kind: 'plugin',
    runtime: 'remote',
    category: 'payments',
    featured: false,
    author: 'Stripe',
    description: 'Integrate Stripe Checkout, Billing subscriptions, webhooks, and payment intents with official Stripe best-practice skills.',
    sources: ['google', 'anthropic', 'mcp-registry'],
    skills: ['stripe-best-practices'],
  },
];

/** Rule filename conventions per provider. */
const PROVIDER_RULE_FILE = {
  claude: 'CLAUDE.md',
  antigravity: 'GEMINI.md',
  gemini: 'GEMINI.md',
  codex: 'AGENTS.md',
  copilot: 'AGENTS.md',
  junie: 'AGENTS.md',
  qwen: 'AGENTS.md',
  amp: 'AGENTS.md',
  opencode: 'AGENTS.md',
  grok: 'AGENTS.md',
  cursor: 'AGENTS.md',
  aider: 'AGENTS.md',
  muse: 'AGENTS.md',
};

/** Default home folder for any tool ID, honoring environment overrides when present. */
export function defaultProviderHome(id, { home = os.homedir(), envReader = readUserEnv } = {}) {
  if (id === 'antigravity') {
    return envReader('GEMINI_HOME') || path.join(home, '.gemini');
  }
  if (PROVIDERS[id]) {
    const def = PROVIDERS[id];
    const fromEnv = def.envVar ? envReader(def.envVar) : null;
    if (fromEnv) return def.envShape === 'parent' ? path.join(fromEnv, def.dirName) : fromEnv;
    return path.join(home, def.dirName);
  }
  return path.join(home, `.${id}`);
}

function uniquePaths(paths) {
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    if (!out.some((existing) => samePath(existing, p))) out.push(p);
  }
  return out;
}

function readAccountsList(accountsPath = accountsFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(accountsPath, 'utf8'));
    return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

/**
 * Every config root directory for a given provider ID: its default home, plus every
 * registered account home in accounts.json, plus T3 Code profile homes for Antigravity.
 */
export function providerHomes(id, {
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  accountsList = null,
} = {}) {
  const candidates = [defaultProviderHome(id, { home, envReader })];
  const accounts = accountsList ?? readAccountsList(accountsPath);
  for (const acc of accounts) {
    if (acc?.provider === id && typeof acc.home === 'string' && acc.home.trim()) {
      candidates.push(acc.home.trim());
    }
  }
  if (id === 'antigravity') {
    const t3Root = path.join(home, '.t3', 'userdata', 'providers', 'antigravity');
    try {
      for (const d of fs.readdirSync(t3Root, { withFileTypes: true })) {
        if (d.isDirectory()) candidates.push(path.join(t3Root, d.name, 'config'));
      }
    } catch { /* no T3 Code profiles */ }
  }
  return uniquePaths(candidates);
}

/**
 * Dynamically build the list of customization target clients from TOOLS (core/providers.js),
 * PROVIDERS (core/accounts.js), and MCP_CLIENTS (core/mcp.js).
 *
 * When a user installs a new CLI tomorrow (for example, Grok or Qwen) or adds an account
 * for it in Switchboard, it automatically becomes `available: true` here and surfaces in
 * the UI target matrix without any manual code updates.
 */
export function customizationClients({
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  installedToolIds = null,
} = {}) {
  const accounts = readAccountsList(accountsPath);
  const installedSet = installedToolIds ? new Set(installedToolIds) : null;

  // Ordered with primary coding agents first, then every other tool in TOOLS.
  const priorityOrder = ['claude', 'codex', 'antigravity', 'gemini', 'grok', 'qwen', 'cursor', 'copilot', 'opencode', 'amp', 'junie', 'aider'];
  const allToolIds = uniqueStrings([
    ...priorityOrder,
    ...TOOLS.map((t) => t.id),
  ]).filter((id) => id !== 'ollama');

  return allToolIds.map((id) => {
    const toolMeta = TOOLS.find((t) => t.id === id);
    const mcpMeta = MCP_CLIENTS[id];
    const homes = providerHomes(id, { home, envReader, accountsList: accounts });
    const accountMatches = accounts.filter((a) => a?.provider === id);
    const hasExistingHome = homes.some((h) => {
      try { return fs.existsSync(h); } catch { return false; }
    });
    const isInstalled = installedSet ? installedSet.has(id) : false;
    const available = Boolean(isInstalled || accountMatches.length > 0 || hasExistingHome);

    return {
      id,
      name: mcpMeta?.name ?? toolMeta?.name ?? PROVIDERS[id]?.name ?? id,
      vendor: toolMeta?.vendor ?? '',
      category: toolMeta?.category ?? 'cli',
      available,
      accountCount: accountMatches.length,
      homes,
      ruleFile: PROVIDER_RULE_FILE[id] ?? 'AGENTS.md',
      supportsSkills: true,
      supportsRules: true,
      supportsAgents: true,
      supportsPlugins: true,
      supportsMcp: Boolean(mcpMeta),
    };
  });
}

function uniqueStrings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const s = String(item ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * Backup-before-write helper matching core/mcp.js discipline: backs up an existing file
 * with an ISO timestamp, prunes old backups to BACKUPS_KEPT, and writes atomically via a
 * temporary sibling file.
 */
export function writeCustomizationFile(file, text, keep = BACKUPS_KEPT) {
  ensureDir(path.dirname(file));
  if (fs.existsSync(file)) {
    fs.copyFileSync(file, `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    pruneBackups(file, keep);
  }
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
}

/** Parse YAML frontmatter (`--- ... ---`) from a Markdown file (`SKILL.md` or agent `.md`). */
export function parseMarkdownFrontmatter(markdown) {
  const text = String(markdown ?? '');
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    const firstHeading = text.match(/^#\s+(.+)$/m);
    const firstPara = text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#') && !l.startsWith('---'));
    return {
      attributes: {
        ...(firstHeading ? { title: firstHeading[1].trim() } : {}),
        ...(firstPara ? { description: firstPara.slice(0, 200) } : {}),
      },
      body: text,
    };
  }
  const rawYaml = match[1];
  const body = match[2] ?? '';
  const attributes = {};
  const lines = rawYaml.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)\s*$/);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim();
    if (val === '>-' || val === '>' || val === '|-' || val === '|' || val === '') {
      const cont = [];
      while (i + 1 < lines.length && /^[ \t]+\S/.test(lines[i + 1])) {
        i += 1;
        cont.push(lines[i].trim());
      }
      if (cont.length) {
        val = (val.startsWith('|') ? cont.join('\n') : cont.join(' ')).trim();
      } else if (val === '>-' || val === '>' || val === '|-' || val === '|') {
        val = '';
      }
    }
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (val === 'true') attributes[key] = true;
    else if (val === 'false') attributes[key] = false;
    else attributes[key] = val;
  }
  return { attributes, body };
}

/** Build a `SKILL.md` or agent `.md` document with clean YAML frontmatter. */
export function formatMarkdownWithFrontmatter(attributes, body) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(attributes ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    const str = String(v).replace(/\r?\n/g, ' ').trim();
    const needsQuotes = /[:#[\]{}&*!|>'"%@`]/.test(str);
    lines.push(`${k}: ${needsQuotes ? JSON.stringify(str) : str}`);
  }
  lines.push('---', '');
  const cleanBody = String(body ?? '').replace(/^\r?\n+/, '');
  return lines.join('\n') + cleanBody + (cleanBody.endsWith('\n') ? '' : '\n');
}

/** Load Switchboard's local customizations state file (`customizations.json`). */
export function loadCustomizationsState(file = customizationsFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      installedPlugins: Array.isArray(parsed?.installedPlugins) ? parsed.installedPlugins : [],
      disabledSkills: Array.isArray(parsed?.disabledSkills) ? parsed.disabledSkills : [],
      sources: Array.isArray(parsed?.sources) ? parsed.sources : [],
    };
  } catch {
    return { installedPlugins: [], disabledSkills: [], sources: [] };
  }
}

export function saveCustomizationsState(state, file = customizationsFile()) {
  writeJsonAtomic(file, {
    installedPlugins: state?.installedPlugins ?? [],
    disabledSkills: state?.disabledSkills ?? [],
    sources: state?.sources ?? [],
  });
}

/** Candidate skill folders inside a provider's home directory. */
function skillDirsForHome(providerId, homeDir) {
  if (providerId === 'antigravity') {
    if (path.basename(homeDir).toLowerCase() === 'config') {
      return [path.join(homeDir, 'skills')];
    }
    return [
      path.join(homeDir, 'config', 'skills'),
      path.join(homeDir, 'antigravity', 'skills'),
      path.join(homeDir, 'skills'),
    ];
  }
  return [path.join(homeDir, 'skills')];
}

/** Primary skill folder where Switchboard writes when syncing a skill to a provider home. */
function targetSkillDirForHome(providerId, homeDir) {
  if (providerId === 'antigravity') {
    if (path.basename(homeDir).toLowerCase() === 'config') {
      return path.join(homeDir, 'skills');
    }
    return path.join(homeDir, 'config', 'skills');
  }
  return path.join(homeDir, 'skills');
}

function readSkillDirectory(skillDir, extra = {}) {
  const skillFile = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillFile)) return null;
  try {
    const raw = fs.readFileSync(skillFile, 'utf8');
    const { attributes, body } = parseMarkdownFrontmatter(raw);
    const folderName = path.basename(skillDir);
    const files = fs.readdirSync(skillDir);
    return {
      name: folderName,
      title: attributes.name || attributes.title || folderName,
      description: attributes.description || '',
      userInvocable: attributes['user-invocable'] !== false,
      fileCount: files.length,
      path: skillDir,
      bodyPreview: body.trim().slice(0, 280),
      ...extra,
    };
  } catch {
    return null;
  }
}

/**
 * Discover all installed Skills across Switchboard's central store, every provider home
 * (including all registered accounts), disabled skill folders, and Antigravity's built-in
 * skills directory.
 */
export function listInstalledSkills({
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  installedToolIds = null,
} = {}) {
  const clients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const byName = new Map();

  const recordSkill = (meta, clientId, status) => {
    if (!meta?.name) return;
    if (!byName.has(meta.name)) {
      byName.set(meta.name, {
        name: meta.name,
        title: meta.title || meta.name,
        description: meta.description || '',
        kind: 'skill',
        slashCommand: `/${meta.name}`,
        userInvocable: meta.userInvocable ?? true,
        fileCount: meta.fileCount ?? 1,
        sourcePath: meta.path,
        bodyPreview: meta.bodyPreview || '',
        builtin: Boolean(meta.builtin),
        disabled: false,
        state: Object.fromEntries(clients.map((c) => [c.id, 'off'])),
      });
    }
    const existing = byName.get(meta.name);
    if (!existing.description && meta.description) existing.description = meta.description;
    if (!existing.sourcePath && meta.path) existing.sourcePath = meta.path;
    if (meta.builtin) existing.builtin = true;
    if (meta.disabled) existing.disabled = true;
    if (clientId && existing.state[clientId] !== undefined) {
      existing.state[clientId] = status;
    }
  };

  // 1. Switchboard central store (<customizationsDir>/skills/<name>/SKILL.md)
  const centralSkillsDir = path.join(cDir, 'skills');
  if (fs.existsSync(centralSkillsDir)) {
    try {
      for (const entry of fs.readdirSync(centralSkillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = readSkillDirectory(path.join(centralSkillsDir, entry.name));
        if (meta) recordSkill(meta, null, 'off');
      }
    } catch { /* ignore unreadable store */ }
  }

  // 2. Every provider's active and disabled skill directories
  for (const client of clients) {
    for (const h of client.homes) {
      for (const sDir of skillDirsForHome(client.id, h)) {
        try {
          if (fs.existsSync(sDir)) {
            for (const entry of fs.readdirSync(sDir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              const meta = readSkillDirectory(path.join(sDir, entry.name));
              if (meta) recordSkill(meta, client.id, 'on');
            }
          }
        } catch { /* unreadable */ }

        const disabledDir = `${sDir}.disabled`;
        try {
          if (fs.existsSync(disabledDir)) {
            for (const entry of fs.readdirSync(disabledDir, { withFileTypes: true })) {
              if (!entry.isDirectory()) continue;
              const meta = readSkillDirectory(path.join(disabledDir, entry.name), { disabled: true });
              if (meta && (!byName.has(meta.name) || byName.get(meta.name).state[client.id] === 'off')) {
                recordSkill(meta, client.id, 'disabled');
              }
            }
          }
        } catch { /* unreadable */ }
      }
    }
  }

  // 3. Antigravity built-in skills (~/.gemini/antigravity/builtin/skills/<name>/SKILL.md)
  const builtinDir = path.join(defaultProviderHome('antigravity', { home, envReader }), 'antigravity', 'builtin', 'skills');
  if (fs.existsSync(builtinDir)) {
    try {
      for (const entry of fs.readdirSync(builtinDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const meta = readSkillDirectory(path.join(builtinDir, entry.name), { builtin: true });
        if (meta) recordSkill(meta, 'antigravity', 'on');
      }
    } catch { /* unreadable */ }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function copyDirectoryRecursive(srcDir, destDir) {
  ensureDir(destDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      const content = fs.readFileSync(srcPath, 'utf8');
      writeCustomizationFile(destPath, content);
    }
  }
}

function removeDirectorySafe(dir) {
  if (!fs.existsSync(dir)) return;
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Enable or disable a Skill for a specific provider client, fanning out across all
 * registered account homes for that provider. Before removing from a provider, a copy is
 * preserved in Switchboard's central `<customizationsDir>/skills/<name>` store so the
 * skill is never lost even if toggled off everywhere.
 */
export function setSkillClientState(skillName, clientId, enabled, {
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  installedToolIds = null,
} = {}) {
  const safeName = sanitizeSlug(skillName);
  if (!safeName) throw new Error(`invalid skill name: ${skillName}`);

  const skills = listInstalledSkills({ home, envReader, accountsPath, cDir, installedToolIds });
  const found = skills.find((s) => s.name === safeName);
  if (!found && enabled) {
    throw new Error(`no such skill: ${safeName}`);
  }

  const clients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const targetClient = clients.find((c) => c.id === clientId);
  if (!targetClient) throw new Error(`unknown client: ${clientId}`);

  // Always preserve a canonical copy in Switchboard's central store first.
  const centralCopy = path.join(cDir, 'skills', safeName);
  if (found?.sourcePath && !samePath(found.sourcePath, centralCopy) && !fs.existsSync(path.join(centralCopy, 'SKILL.md'))) {
    copyDirectoryRecursive(found.sourcePath, centralCopy);
  }

  const sourceDir = fs.existsSync(path.join(centralCopy, 'SKILL.md')) ? centralCopy : found?.sourcePath;
  const touched = [];

  for (const h of targetClient.homes) {
    // Only write into extra homes that exist (or the primary default home).
    const isPrimary = samePath(h, targetClient.homes[0]);
    if (!isPrimary && !fs.existsSync(h)) continue;

    if (enabled) {
      if (!sourceDir || !fs.existsSync(sourceDir)) {
        throw new Error(`source files for skill ${safeName} could not be found`);
      }
      const destSkillDir = path.join(targetSkillDirForHome(clientId, h), safeName);
      copyDirectoryRecursive(sourceDir, destSkillDir);
      // Clean up any `.disabled` copy in the same home so state is unambiguous.
      for (const sDir of skillDirsForHome(clientId, h)) {
        const disabledCopy = path.join(`${sDir}.disabled`, safeName);
        if (fs.existsSync(disabledCopy)) removeDirectorySafe(disabledCopy);
      }
      touched.push(destSkillDir);
    } else {
      for (const sDir of skillDirsForHome(clientId, h)) {
        const activeCopy = path.join(sDir, safeName);
        if (fs.existsSync(activeCopy)) {
          if (!fs.existsSync(path.join(centralCopy, 'SKILL.md'))) {
            copyDirectoryRecursive(activeCopy, centralCopy);
          }
          removeDirectorySafe(activeCopy);
          touched.push(activeCopy);
        }
      }
    }
  }

  return { ok: true, skill: safeName, client: clientId, enabled: Boolean(enabled), paths: touched };
}

/** Create or update a Skill in Switchboard's central store and fan out to selected clients. */
export function saveCustomSkill({
  name,
  title,
  description = '',
  body = '',
  clients: targetClientIds = [],
}, opts = {}) {
  const safeName = sanitizeSlug(name);
  if (!safeName) throw new Error('skill name is required and must use letters, digits, hyphens, or underscores');
  const cDir = opts.cDir ?? customizationsDir();
  const skillDir = path.join(cDir, 'skills', safeName);
  ensureDir(skillDir);
  const content = formatMarkdownWithFrontmatter(
    {
      name: title || safeName,
      description,
      'user-invocable': true,
    },
    body || `# ${title || safeName}\n\n${description}\n`,
  );
  writeCustomizationFile(path.join(skillDir, 'SKILL.md'), content);

  for (const clientId of targetClientIds) {
    setSkillClientState(safeName, clientId, true, opts);
  }
  return { ok: true, name: safeName, path: skillDir };
}

/**
 * Discover global Rules files (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`, and `<home>/rules/*.md`)
 * across all providers.
 */
export function listGlobalRules({
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  installedToolIds = null,
} = {}) {
  const clients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const providerInstructionFiles = [];

  for (const client of clients) {
    const primaryHome = client.homes[0];
    const ruleFile = path.join(primaryHome, client.ruleFile);
    const exists = fs.existsSync(ruleFile);
    if (!exists && !client.available) continue;
    if (providerInstructionFiles.some((existing) => samePath(existing.path, ruleFile))) {
      continue;
    }
    let content = '';
    if (exists) {
      try { content = fs.readFileSync(ruleFile, 'utf8'); } catch { content = ''; }
    }
    providerInstructionFiles.push({
      id: `${client.id}:${client.ruleFile}`,
      clientId: client.id,
      clientName: client.name,
      fileName: client.ruleFile,
      path: ruleFile,
      exists,
      sizeBytes: Buffer.byteLength(content, 'utf8'),
      preview: content.trim().slice(0, 240),
      accountCount: client.accountCount,
    });
  }

  // Also discover named rule snippets in `<cDir>/rules/*.md` or `<home>/rules/*.md`
  const ruleSnippetsByName = new Map();
  const recordSnippet = (name, filePath, clientId) => {
    if (!ruleSnippetsByName.has(name)) {
      let raw = '';
      try { raw = fs.readFileSync(filePath, 'utf8'); } catch { raw = ''; }
      const { attributes, body } = parseMarkdownFrontmatter(raw);
      ruleSnippetsByName.set(name, {
        name,
        title: attributes.name || attributes.title || name,
        description: attributes.description || body.trim().split(/\r?\n/)[0]?.slice(0, 160) || '',
        path: filePath,
        state: Object.fromEntries(clients.map((c) => [c.id, 'off'])),
      });
    }
    if (clientId) {
      ruleSnippetsByName.get(name).state[clientId] = 'on';
    }
  };

  const centralRulesDir = path.join(cDir, 'rules');
  if (fs.existsSync(centralRulesDir)) {
    try {
      for (const f of fs.readdirSync(centralRulesDir)) {
        if (f.endsWith('.md')) recordSnippet(f.slice(0, -3), path.join(centralRulesDir, f), null);
      }
    } catch { /* ignore */ }
  }

  for (const client of clients) {
    for (const h of client.homes) {
      const rDir = path.join(h, 'rules');
      if (!fs.existsSync(rDir)) continue;
      try {
        for (const f of fs.readdirSync(rDir)) {
          if (f.endsWith('.md')) recordSnippet(f.slice(0, -3), path.join(rDir, f), client.id);
        }
      } catch { /* ignore */ }
    }
  }

  return {
    instructionFiles: providerInstructionFiles,
    snippets: [...ruleSnippetsByName.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/**
 * Write global instruction text (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) to one or more
 * providers, fanning out across all registered account homes for each provider with
 * automatic `.bak-<iso>` backups.
 */
export function syncGlobalInstructionToClients(text, targetClientIds, {
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  installedToolIds = null,
} = {}) {
  const clients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const written = [];
  const cleanText = String(text ?? '').replace(/\r\n/g, '\n');

  for (const clientId of targetClientIds) {
    const client = clients.find((c) => c.id === clientId);
    if (!client) throw new Error(`unknown client: ${clientId}`);
    for (const h of client.homes) {
      const isPrimary = samePath(h, client.homes[0]);
      if (!isPrimary && !fs.existsSync(h)) continue;
      const targetFile = path.join(h, client.ruleFile);
      writeCustomizationFile(targetFile, cleanText.endsWith('\n') ? cleanText : `${cleanText}\n`);
      written.push(targetFile);
    }
  }
  return { ok: true, files: written };
}

/**
 * Discover Custom Agents (`<home>/agents/<name>.md`) across Switchboard's central store
 * and all provider homes.
 */
export function listCustomAgents({
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  installedToolIds = null,
} = {}) {
  const clients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const byName = new Map();

  const recordAgent = (name, filePath, clientId) => {
    let raw = '';
    try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return; }
    const { attributes, body } = parseMarkdownFrontmatter(raw);
    if (!byName.has(name)) {
      byName.set(name, {
        name,
        title: attributes.name || attributes.title || name,
        description: attributes.description || '',
        model: attributes.model || 'inherit',
        tools: attributes.tools || '',
        kind: 'agent',
        sourcePath: filePath,
        bodyPreview: body.trim().slice(0, 240),
        state: Object.fromEntries(clients.map((c) => [c.id, 'off'])),
      });
    }
    const entry = byName.get(name);
    if (!entry.description && attributes.description) entry.description = attributes.description;
    if (clientId && entry.state[clientId] !== undefined) {
      entry.state[clientId] = 'on';
    }
  };

  const centralAgentsDir = path.join(cDir, 'agents');
  if (fs.existsSync(centralAgentsDir)) {
    try {
      for (const f of fs.readdirSync(centralAgentsDir)) {
        if (f.endsWith('.md')) recordAgent(f.slice(0, -3), path.join(centralAgentsDir, f), null);
      }
    } catch { /* ignore */ }
  }

  for (const client of clients) {
    for (const h of client.homes) {
      const aDir = path.join(h, 'agents');
      if (!fs.existsSync(aDir)) continue;
      try {
        for (const f of fs.readdirSync(aDir)) {
          if (f.endsWith('.md')) recordAgent(f.slice(0, -3), path.join(aDir, f), client.id);
        }
      } catch { /* ignore */ }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Enable or disable a Custom Agent (`.md`) for a specific provider across all its account homes. */
export function setAgentClientState(agentName, clientId, enabled, {
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  installedToolIds = null,
} = {}) {
  const safeName = sanitizeSlug(agentName);
  if (!safeName) throw new Error(`invalid agent name: ${agentName}`);

  const agents = listCustomAgents({ home, envReader, accountsPath, cDir, installedToolIds });
  const found = agents.find((a) => a.name === safeName);
  if (!found && enabled) throw new Error(`no such custom agent: ${safeName}`);

  const clients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const targetClient = clients.find((c) => c.id === clientId);
  if (!targetClient) throw new Error(`unknown client: ${clientId}`);

  const centralFile = path.join(cDir, 'agents', `${safeName}.md`);
  if (found?.sourcePath && !samePath(found.sourcePath, centralFile) && !fs.existsSync(centralFile)) {
    writeCustomizationFile(centralFile, fs.readFileSync(found.sourcePath, 'utf8'));
  }

  const sourceFile = fs.existsSync(centralFile) ? centralFile : found?.sourcePath;
  const touched = [];

  for (const h of targetClient.homes) {
    const isPrimary = samePath(h, targetClient.homes[0]);
    if (!isPrimary && !fs.existsSync(h)) continue;
    const destFile = path.join(h, 'agents', `${safeName}.md`);
    if (enabled) {
      if (!sourceFile || !fs.existsSync(sourceFile)) {
        throw new Error(`source file for agent ${safeName} could not be found`);
      }
      writeCustomizationFile(destFile, fs.readFileSync(sourceFile, 'utf8'));
      touched.push(destFile);
    } else if (fs.existsSync(destFile)) {
      if (!fs.existsSync(centralFile)) {
        writeCustomizationFile(centralFile, fs.readFileSync(destFile, 'utf8'));
      }
      fs.unlinkSync(destFile);
      touched.push(destFile);
    }
  }

  return { ok: true, agent: safeName, client: clientId, enabled: Boolean(enabled), paths: touched };
}

/** Create or update a Custom Agent and fan out to selected providers. */
export function saveCustomAgent({
  name,
  title,
  description = '',
  model = 'inherit',
  tools = '',
  body = '',
  clients: targetClientIds = [],
}, opts = {}) {
  const safeName = sanitizeSlug(name);
  if (!safeName) throw new Error('agent name is required and must use letters, digits, hyphens, or underscores');
  const cDir = opts.cDir ?? customizationsDir();
  const centralFile = path.join(cDir, 'agents', `${safeName}.md`);
  const content = formatMarkdownWithFrontmatter(
    {
      name: title || safeName,
      description,
      model: model || 'inherit',
      ...(tools ? { tools } : {}),
    },
    body || `You are ${title || safeName}. ${description}\n`,
  );
  writeCustomizationFile(centralFile, content);

  for (const clientId of targetClientIds) {
    setAgentClientState(safeName, clientId, true, opts);
  }
  return { ok: true, name: safeName, path: centralFile };
}

/**
 * Discover installed Plugins across Switchboard's central store, Antigravity's
 * `~/.gemini/config/plugins`, Claude Code's `~/.claude/plugins/installed_plugins.json`,
 * and Codex's plugin cache.
 */
export function listInstalledPlugins({
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  cFile = customizationsFile(),
  installedToolIds = null,
  skills: precomputedSkills = null,
} = {}) {
  const clients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const state = loadCustomizationsState(cFile);
  const byName = new Map();

  const ensurePlugin = (name, meta = {}) => {
    const slug = sanitizeSlug(name) || name;
    if (!byName.has(slug)) {
      byName.set(slug, {
        name: slug,
        title: meta.title || meta.displayName || slug,
        version: meta.version || '1.0.0',
        description: meta.description || '',
        author: typeof meta.author === 'object' ? (meta.author?.name ?? '') : (meta.author ?? ''),
        category: meta.category || 'plugin',
        kind: 'plugin',
        skills: Array.isArray(meta.skills) ? meta.skills : [],
        mcpServers: Array.isArray(meta.mcpServers) ? meta.mcpServers : [],
        path: meta.path || '',
        state: Object.fromEntries(clients.map((c) => [c.id, 'off'])),
      });
    }
    const existing = byName.get(slug);
    if (!existing.description && meta.description) existing.description = meta.description;
    if (!existing.version && meta.version) existing.version = meta.version;
    if (Array.isArray(meta.skills) && meta.skills.length && !existing.skills.length) {
      existing.skills = meta.skills;
    }
    return existing;
  };

  // 1. Antigravity installed plugins (~/.gemini/config/plugins/<name>/)
  const agyPluginsDir = path.join(defaultProviderHome('antigravity', { home, envReader }), 'config', 'plugins');
  if (fs.existsSync(agyPluginsDir)) {
    try {
      for (const entry of fs.readdirSync(agyPluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pDir = path.join(agyPluginsDir, entry.name);
        const manifestFile = [
          path.join(pDir, 'plugin.json'),
          path.join(pDir, '.claude-plugin', 'plugin.json'),
          path.join(pDir, 'gemini-extension.json'),
        ].find((f) => fs.existsSync(f));
        let meta = {};
        if (manifestFile) {
          try { meta = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { meta = {}; }
        }
        const skills = discoverPluginSkillNames(pDir, meta);
        const item = ensurePlugin(entry.name, { ...meta, skills, path: pDir });
        item.state.antigravity = 'on';
      }
    } catch { /* ignore */ }
  }

  // 2. Claude Code installed_plugins.json (~/.claude/plugins/installed_plugins.json)
  const claudeInstalledFile = path.join(defaultProviderHome('claude', { home, envReader }), 'plugins', 'installed_plugins.json');
  if (fs.existsSync(claudeInstalledFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(claudeInstalledFile, 'utf8'));
      const pluginsMap = parsed?.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : {};
      for (const [key, records] of Object.entries(pluginsMap)) {
        const name = key.split('@')[0];
        const rec = Array.isArray(records) ? records[0] : records;
        const item = ensurePlugin(name, {
          version: rec?.version || '1.0.0',
          path: rec?.installPath || '',
        });
        item.state.claude = 'on';
      }
    } catch { /* ignore */ }
  }

  // 3. Switchboard central plugins store (<customizationsDir>/plugins/<name>/)
  const centralPluginsDir = path.join(cDir, 'plugins');
  if (fs.existsSync(centralPluginsDir)) {
    try {
      for (const entry of fs.readdirSync(centralPluginsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pDir = path.join(centralPluginsDir, entry.name);
        const manifestFile = path.join(pDir, 'plugin.json');
        let meta = {};
        if (fs.existsSync(manifestFile)) {
          try { meta = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { meta = {}; }
        }
        const item = ensurePlugin(entry.name, { ...meta, path: pDir });
        for (const clientId of meta.clients ?? []) {
          if (item.state[clientId] !== undefined) item.state[clientId] = 'on';
        }
      }
    } catch { /* ignore */ }
  }

  // 4. Merge recorded state from customizations.json
  for (const saved of state.installedPlugins) {
    if (!saved?.name) continue;
    const item = ensurePlugin(saved.name, saved);
    for (const cId of saved.clients ?? []) {
      if (item.state[cId] !== undefined) item.state[cId] = 'on';
    }
  }

  // 5. If a plugin's bundled skills are active in other providers (e.g. codex, grok, qwen),
  // mark those providers as 'on' for the plugin as well.
  const installedSkills = precomputedSkills ?? listInstalledSkills({ home, envReader, accountsPath, cDir, installedToolIds });
  const skillByName = new Map(installedSkills.map((s) => [s.name, s]));
  for (const plugin of byName.values()) {
    for (const sName of plugin.skills ?? []) {
      const skill = skillByName.get(sName);
      if (!skill) continue;
      for (const [cId, st] of Object.entries(skill.state)) {
        if (st === 'on') plugin.state[cId] = 'on';
      }
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function discoverPluginSkillNames(pluginDir, manifest = {}) {
  const names = [];
  if (Array.isArray(manifest?.skills)) {
    for (const s of manifest.skills) {
      if (typeof s === 'string') names.push(path.basename(s));
      else if (typeof s?.name === 'string') names.push(s.name);
    }
  }
  const skillsSubdir = path.join(pluginDir, 'skills');
  if (fs.existsSync(skillsSubdir)) {
    try {
      for (const d of fs.readdirSync(skillsSubdir, { withFileTypes: true })) {
        if (d.isDirectory()) names.push(d.name);
      }
    } catch { /* ignore */ }
  }
  return uniqueStrings(names);
}

export function sanitizeSlug(input) {
  const s = String(input ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!s || s === '.' || s === '..') return '';
  return s;
}

/** Normalize a plugin or skill name for deduplication across vendor catalogs. */
export function canonicalCatalogKey(item) {
  const raw = String(item?.name ?? '').trim().toLowerCase();
  return raw.replace(/-(plugin|mcp|server|official)$/g, '');
}

/**
 * Read Google Antigravity's local marketplace cache files:
 * `~/.gemini/antigravity/cache/marketplaces/<bucket>/marketplace.json`
 */
export function readAntigravityMarketplaceCache(home = os.homedir(), envReader = readUserEnv) {
  const geminiRoot = defaultProviderHome('antigravity', { home, envReader });
  const marketplacesDir = path.join(geminiRoot, 'antigravity', 'cache', 'marketplaces');
  const out = [];
  if (!fs.existsSync(marketplacesDir)) return out;

  let buckets = [];
  try {
    buckets = fs.readdirSync(marketplacesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }

  for (const bucket of buckets) {
    const file = path.join(marketplacesDir, bucket.name, 'marketplace.json');
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
      for (const p of plugins) {
        if (!p?.name) continue;
        const skillNames = Array.isArray(p.skills)
          ? p.skills.map((s) => (typeof s === 'string' ? path.basename(s) : s?.name)).filter(Boolean)
          : [];
        out.push({
          name: p.name,
          title: p.displayName || p.title || p.name,
          version: p.version || '1.0.0',
          description: p.description || '',
          category: String(p.category || 'development').toLowerCase(),
          author: typeof p.author === 'object' ? (p.author?.name ?? 'Google Antigravity') : (p.author || 'Google Antigravity'),
          kind: 'plugin',
          runtime: skillNames.length ? 'skill-bundle' : 'plugin',
          featured: bucket.name.includes('official'),
          sources: ['google'],
          skills: skillNames,
          suggestedPrompts: Array.isArray(p.suggestedPrompts)
            ? p.suggestedPrompts.map((sp) => (typeof sp === 'string' ? sp : sp?.title || sp?.prompt)).filter(Boolean)
            : [],
          repository: p.repository || p.homepage || '',
          archiveUrl: p.source?.url || '',
        });
      }
    } catch { /* skip malformed file */ }
  }
  return out;
}

/**
 * Read Anthropic Claude Code's local marketplace catalogs:
 * `~/.claude/plugins/marketplaces/<bucket>/.claude-plugin/marketplace.json`
 */
export function readClaudeMarketplaceCache(home = os.homedir(), envReader = readUserEnv) {
  const claudeRoot = defaultProviderHome('claude', { home, envReader });
  const marketplacesDir = path.join(claudeRoot, 'plugins', 'marketplaces');
  const out = [];
  if (!fs.existsSync(marketplacesDir)) return out;

  let buckets = [];
  try {
    buckets = fs.readdirSync(marketplacesDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }

  for (const bucket of buckets) {
    const candidates = [
      path.join(marketplacesDir, bucket.name, '.claude-plugin', 'marketplace.json'),
      path.join(marketplacesDir, bucket.name, 'marketplace.json'),
    ];
    const file = candidates.find((f) => fs.existsSync(f));
    if (!file) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      const plugins = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
      for (const p of plugins) {
        if (!p?.name) continue;
        const localPluginDir = typeof p.source === 'string'
          ? path.resolve(path.dirname(path.dirname(file)), p.source)
          : null;
        const skillNames = localPluginDir && fs.existsSync(localPluginDir)
          ? discoverPluginSkillNames(localPluginDir, p)
          : [];
        out.push({
          name: p.name,
          title: p.displayName || p.title || p.name,
          version: p.version || '1.0.0',
          description: p.description || '',
          category: String(p.category || 'development').toLowerCase(),
          author: typeof p.author === 'object' ? (p.author?.name ?? 'Anthropic') : (p.author || 'Anthropic'),
          kind: 'plugin',
          runtime: skillNames.length ? 'skill-bundle' : 'plugin',
          featured: bucket.name.includes('official'),
          sources: ['anthropic'],
          skills: skillNames,
          localPath: localPluginDir && fs.existsSync(localPluginDir) ? localPluginDir : '',
          repository: typeof p.source === 'object' && p.source?.url ? p.source.url : (p.homepage || ''),
        });
      }
    } catch { /* skip malformed file */ }
  }
  return out;
}

/**
 * Read OpenAI Codex's curated plugin cache:
 * `~/.codex/plugins/cache/<bucket>/<pluginName>`
 */
export function readCodexMarketplaceCache(home = os.homedir(), envReader = readUserEnv) {
  const codexRoot = defaultProviderHome('codex', { home, envReader });
  const cacheDir = path.join(codexRoot, 'plugins', 'cache');
  const out = [];
  if (!fs.existsSync(cacheDir)) return out;

  let buckets = [];
  try {
    buckets = fs.readdirSync(cacheDir, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return out;
  }

  for (const bucket of buckets) {
    const bucketPath = path.join(cacheDir, bucket.name);
    let entries = [];
    try {
      entries = fs.readdirSync(bucketPath, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const entry of entries) {
      const pDir = path.join(bucketPath, entry.name);
      const manifestFile = [
        path.join(pDir, 'plugin.json'),
        path.join(pDir, '.codex-plugin', 'plugin.json'),
      ].find((f) => fs.existsSync(f));
      let meta = {};
      if (manifestFile) {
        try { meta = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { meta = {}; }
      }
      const skills = discoverPluginSkillNames(pDir, meta);
      out.push({
        name: meta.name || entry.name,
        title: meta.displayName || meta.title || entry.name,
        version: meta.version || '1.0.0',
        description: meta.description || `Curated OpenAI Codex plugin (${bucket.name}).`,
        category: String(meta.category || 'development').toLowerCase(),
        author: typeof meta.author === 'object' ? (meta.author?.name ?? 'OpenAI') : (meta.author || 'OpenAI'),
        kind: 'plugin',
        runtime: skills.length ? 'skill-bundle' : 'plugin',
        featured: true,
        sources: ['openai'],
        skills,
        localPath: pDir,
      });
    }
  }
  return out;
}

let marketplaceCache = { home: '', at: 0, items: null };
const MARKETPLACE_CACHE_TTL_MS = 60_000;

/**
 * Aggregate the unified Marketplace catalog across all trusted vendor caches, curated
 * seeds, and Switchboard's MCP server catalog. Deduplicates items that appear in multiple
 * vendor feeds (for example `chrome-devtools-plugin` or `supabase-plugin`) while merging
 * their `sources` badges (`['google', 'anthropic', 'mcp-registry']`).
 */
export function loadMarketplaceCatalog({
  home = os.homedir(),
  envReader = readUserEnv,
  registry = null,
  force = false,
} = {}) {
  const now = Date.now();
  const isDefault = home === os.homedir() && envReader === readUserEnv && registry === null;
  if (!force && isDefault && marketplaceCache.items && marketplaceCache.home === home && now - marketplaceCache.at < MARKETPLACE_CACHE_TTL_MS) {
    return marketplaceCache.items;
  }

  const effectiveRegistry = registry ?? loadServers();
  const agyItems = readAntigravityMarketplaceCache(home, envReader);
  const claudeItems = readClaudeMarketplaceCache(home, envReader);
  const codexItems = readCodexMarketplaceCache(home, envReader);
  const mcpItems = browseServers(effectiveRegistry).map((s) => {
    const rt = serverRuntime(s);
    const kind = rt === 'docker' ? 'mcp-docker' : rt === 'stdio' ? 'mcp-stdio' : 'mcp-remote';
    return {
      ...s,
      title: s.label || s.title || s.name,
      kind,
      runtime: rt,
      category: String(s.category || 'mcp').toLowerCase(),
      sources: ['mcp-registry'],
    };
  });

  const mergedByKey = new Map();
  const allCandidates = [
    ...agyItems,
    ...claudeItems,
    ...codexItems,
    ...TRUSTED_SEED_ITEMS,
    ...mcpItems,
  ];

  for (const item of allCandidates) {
    if (!item?.name) continue;
    const key = canonicalCatalogKey(item);
    if (!mergedByKey.has(key)) {
      mergedByKey.set(key, {
        ...item,
        sources: uniqueStrings(item.sources ?? []),
        skills: uniqueStrings(item.skills ?? []),
      });
      continue;
    }
    const existing = mergedByKey.get(key);
    existing.sources = uniqueStrings([...(existing.sources ?? []), ...(item.sources ?? [])]);
    existing.skills = uniqueStrings([...(existing.skills ?? []), ...(item.skills ?? [])]);
    if (!existing.description && item.description) existing.description = item.description;
    if (!existing.localPath && item.localPath) existing.localPath = item.localPath;
    if (!existing.url && item.url) existing.url = item.url;
    if (!existing.command && item.command) existing.command = item.command;
    if (!existing.repository && item.repository) existing.repository = item.repository;
    if (item.featured) existing.featured = true;
  }

  const sorted = [...mergedByKey.values()].sort((a, b) => {
    if (Boolean(b.featured) !== Boolean(a.featured)) return Number(Boolean(b.featured)) - Number(Boolean(a.featured));
    if (b.sources.length !== a.sources.length) return b.sources.length - a.sources.length;
    return String(a.title ?? a.name).localeCompare(String(b.title ?? b.name), undefined, { sensitivity: 'base' });
  });

  if (isDefault) {
    marketplaceCache = { home, at: now, items: sorted };
  }
  return sorted;
}

/**
 * Filter and search the unified Marketplace catalog by query text, kind (`plugin`,
 * `skill`, `mcp-remote`, `mcp-stdio`, `mcp-docker`), vendor source (`google`, `anthropic`,
 * `openai`, `mcp-registry`), or category.
 */
export function searchMarketplace(items = loadMarketplaceCatalog(), {
  query = '',
  kind = 'all',
  source = 'all',
  category = '',
} = {}) {
  const q = String(query ?? '').trim().toLowerCase();
  const k = String(kind ?? 'all').trim().toLowerCase();
  const src = String(source ?? 'all').trim().toLowerCase();
  const cat = String(category ?? '').trim().toLowerCase();

  return items.filter((item) => {
    if (k && k !== 'all') {
      if (k === 'mcp' && !String(item.kind).startsWith('mcp')) return false;
      else if (k !== 'mcp' && item.kind !== k) return false;
    }
    if (src && src !== 'all' && !(item.sources ?? []).includes(src)) return false;
    if (cat && cat !== 'all') {
      if (cat === 'suggested' || cat === 'featured') {
        if (!item.featured) return false;
      } else if (String(item.category ?? '').toLowerCase() !== cat) {
        return false;
      }
    }
    if (!q) return true;
    const hay = [
      item.name,
      item.title,
      item.label,
      item.description,
      item.author,
      item.category,
      ...(item.skills ?? []),
      ...(item.tags ?? []),
      ...(item.sources ?? []),
    ].join(' ').toLowerCase();
    return hay.includes(q);
  });
}

/**
 * Install a plugin or skill from the aggregated Marketplace into Switchboard's central
 * store and fan out its skills to the chosen target clients (`claude`, `codex`,
 * `antigravity`, `grok`, `qwen`, etc.).
 */
export function installMarketplaceItem(name, {
  clients: targetClientIds = [],
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  cFile = customizationsFile(),
  installedToolIds = null,
} = {}) {
  const catalog = loadMarketplaceCatalog({ home, envReader });
  const item = catalog.find((i) => i.name === name || canonicalCatalogKey(i) === canonicalCatalogKey({ name }));
  if (!item) throw new Error(`no such marketplace item: ${name}`);

  const allClients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const chosenClients = targetClientIds.length
    ? targetClientIds
    : allClients.filter((c) => c.available).map((c) => c.id);

  // If the item is backed by a local vendor cache directory (e.g. Claude or Codex cache),
  // copy its bundled skills into Switchboard's store and sync to chosen clients.
  const installedSkillNames = [];
  if (item.localPath && fs.existsSync(item.localPath)) {
    const skillsSubdir = path.join(item.localPath, 'skills');
    if (fs.existsSync(skillsSubdir)) {
      for (const entry of fs.readdirSync(skillsSubdir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const srcSkill = path.join(skillsSubdir, entry.name);
        if (fs.existsSync(path.join(srcSkill, 'SKILL.md'))) {
          const destSkill = path.join(cDir, 'skills', entry.name);
          copyDirectoryRecursive(srcSkill, destSkill);
          installedSkillNames.push(entry.name);
        }
      }
    } else if (fs.existsSync(path.join(item.localPath, 'SKILL.md'))) {
      const sName = sanitizeSlug(item.name);
      const destSkill = path.join(cDir, 'skills', sName);
      copyDirectoryRecursive(item.localPath, destSkill);
      installedSkillNames.push(sName);
    }
  }

  // If the item had no local skill files on disk yet, synthesize a clean SKILL.md from
  // its marketplace metadata and suggested prompts so every provider can invoke it immediately.
  if (!installedSkillNames.length && (item.kind === 'plugin' || item.kind === 'skill')) {
    const primarySkillName = sanitizeSlug(item.skills?.[0] || item.name.replace(/-plugin$/, ''));
    const promptsBlock = Array.isArray(item.suggestedPrompts) && item.suggestedPrompts.length
      ? `\n## Suggested Workflows\n${item.suggestedPrompts.map((p) => `- ${p}`).join('\n')}\n`
      : '';
    saveCustomSkill({
      name: primarySkillName,
      title: item.title || item.name,
      description: item.description || '',
      body: `# ${item.title || item.name}\n\n${item.description || ''}\n${promptsBlock}`,
      clients: [],
    }, { home, envReader, accountsPath, cDir, installedToolIds });
    installedSkillNames.push(primarySkillName);
  }

  for (const sName of installedSkillNames) {
    for (const cId of chosenClients) {
      try {
        setSkillClientState(sName, cId, true, { home, envReader, accountsPath, cDir, installedToolIds });
      } catch { /* skip unavailable client */ }
    }
  }

  // Record the plugin installation in Switchboard's central store.
  const pluginDir = path.join(cDir, 'plugins', sanitizeSlug(item.name));
  ensureDir(pluginDir);
  writeCustomizationFile(
    path.join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name: item.name,
      title: item.title,
      version: item.version || '1.0.0',
      description: item.description || '',
      author: item.author || '',
      category: item.category || 'development',
      sources: item.sources || [],
      skills: installedSkillNames,
      clients: chosenClients,
      installedAt: new Date().toISOString(),
    }, null, 2) + '\n',
  );

  const state = loadCustomizationsState(cFile);
  state.installedPlugins = [
    ...state.installedPlugins.filter((p) => p.name !== item.name),
    {
      name: item.name,
      title: item.title,
      version: item.version || '1.0.0',
      description: item.description || '',
      skills: installedSkillNames,
      clients: chosenClients,
      installedAt: new Date().toISOString(),
    },
  ];
  saveCustomizationsState(state, cFile);

  return {
    ok: true,
    name: item.name,
    kind: item.kind,
    skills: installedSkillNames,
    clients: chosenClients,
  };
}

/**
 * Parse a GitHub repository specifier (`owner/repo`, `owner/repo/subpath`, or full
 * `https://github.com/owner/repo` URL) so a user can install any community skill or
 * plugin directly from GitHub just like in Claude Code or Antigravity.
 */
export function parseGitHubSourceSpec(spec) {
  const raw = String(spec ?? '').trim();
  if (!raw) throw new Error('GitHub repository or URL is required');
  let cleaned = raw
    .replace(/^https?:\/\/github\.com\//i, '')
    .replace(/\.git$/i, '')
    .replace(/^\/+|\/+$/g, '');
  cleaned = cleaned.replace(/\/tree\/[^/]+\/?/, '/').replace(/\/blob\/[^/]+\/?/, '/');
  const parts = cleaned.split('/').filter(Boolean);
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]) || !/^[A-Za-z0-9_.-]+$/.test(parts[1])) {
    throw new Error(`invalid GitHub repository specifier: ${spec} (expected owner/repo or https://github.com/owner/repo)`);
  }
  const [owner, repo, ...rest] = parts;
  return {
    owner,
    repo,
    subpath: rest.join('/'),
    slug: sanitizeSlug(rest.length ? rest[rest.length - 1] : repo),
  };
}

/**
 * Install a Skill or Plugin directly from a GitHub repository (`owner/repo` or URL),
 * fetching `SKILL.md` or `README.md` via HTTPS and provisioning selected providers.
 */
export async function installFromGitHub(spec, {
  clients: targetClientIds = [],
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  installedToolIds = null,
  fetcher = globalThis.fetch,
} = {}) {
  const parsed = parseGitHubSourceSpec(spec);
  if (typeof fetcher !== 'function') {
    throw new Error('HTTP fetch is unavailable in this environment');
  }

  const prefix = parsed.subpath ? `${parsed.subpath.replace(/\/+$/, '')}/` : '';
  const candidateUrls = [
    `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/main/${prefix}SKILL.md`,
    `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/master/${prefix}SKILL.md`,
    `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/main/${prefix}README.md`,
    `https://raw.githubusercontent.com/${parsed.owner}/${parsed.repo}/master/${prefix}README.md`,
  ];

  let downloadedText = '';
  for (const url of candidateUrls) {
    try {
      const res = await fetcher(url);
      if (res && res.ok) {
        downloadedText = await res.text();
        if (downloadedText.trim()) break;
      }
    } catch { /* try next candidate */ }
  }

  if (!downloadedText.trim()) {
    throw new Error(`could not find SKILL.md or README.md in ${parsed.owner}/${parsed.repo}`);
  }

  const { attributes, body } = parseMarkdownFrontmatter(downloadedText);
  const allClients = customizationClients({ home, envReader, accountsPath, installedToolIds });
  const chosenClients = targetClientIds.length
    ? targetClientIds
    : allClients.filter((c) => c.available).map((c) => c.id);

  saveCustomSkill({
    name: parsed.slug,
    title: attributes.name || attributes.title || parsed.slug,
    description: attributes.description || `Installed from github.com/${parsed.owner}/${parsed.repo}`,
    body: body || downloadedText,
    clients: chosenClients,
  }, { home, envReader, accountsPath, cDir, installedToolIds });

  return {
    ok: true,
    name: parsed.slug,
    repository: `${parsed.owner}/${parsed.repo}`,
    clients: chosenClients,
  };
}

/**
 * Complete snapshot of Customizations state for the UI and CLI in one call:
 * - Dynamic provider client matrix (`clients`)
 * - Installed Plugins (`plugins`)
 * - Installed Skills (`skills`)
 * - Global Rules & instruction files (`rules`)
 * - Custom Agents (`agents`)
 * - Marketplace summary counts and Docker daemon status (`dockerAvailable`)
 */
export function customizationsSnapshot({
  home = os.homedir(),
  envReader = readUserEnv,
  accountsPath = accountsFile(),
  cDir = customizationsDir(),
  cFile = customizationsFile(),
  installedToolIds = null,
} = {}) {
  const envCache = new Map();
  const cachedEnvReader = (key) => {
    if (!envCache.has(key)) envCache.set(key, envReader(key));
    return envCache.get(key);
  };
  const clients = customizationClients({ home, envReader: cachedEnvReader, accountsPath, installedToolIds });
  const skills = listInstalledSkills({ home, envReader: cachedEnvReader, accountsPath, cDir, installedToolIds });
  const plugins = listInstalledPlugins({ home, envReader: cachedEnvReader, accountsPath, cDir, cFile, installedToolIds, skills });
  const rules = listGlobalRules({ home, envReader: cachedEnvReader, accountsPath, cDir, installedToolIds });
  const agents = listCustomAgents({ home, envReader: cachedEnvReader, accountsPath, cDir, installedToolIds });
  const marketplace = loadMarketplaceCatalog({ home, envReader: cachedEnvReader });

  return {
    clients,
    plugins,
    skills,
    rules,
    agents,
    marketplaceCount: marketplace.length,
    dockerAvailable: isDockerAvailable({ home }),
    mcpServerTools: (serverName) => listServerTools(serverName, { home }),
  };
}
