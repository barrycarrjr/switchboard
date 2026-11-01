import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  customizationClients,
  customizationsSnapshot,
  installFromGitHub,
  installMarketplaceItem,
  listCustomAgents,
  listGlobalRules,
  listInstalledPlugins,
  listInstalledSkills,
  loadMarketplaceCatalog,
  parseGitHubSourceSpec,
  parseMarkdownFrontmatter,
  saveCustomAgent,
  saveCustomSkill,
  searchMarketplace,
  setAgentClientState,
  setSkillClientState,
  syncGlobalInstructionToClients,
} from '../core/customizations.js';
import {
  isDockerAvailable,
  listServerTools,
  registrationMatrix,
  serverRuntime,
} from '../core/mcp.js';

function makeTempEnv() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cust-test-'));
  const home = path.join(root, 'home');
  const cDir = path.join(root, 'appdata', 'Switchboard', 'customizations');
  const cFile = path.join(root, 'appdata', 'Switchboard', 'customizations.json');
  const accountsPath = path.join(root, 'appdata', 'Switchboard', 'accounts.json');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.dirname(accountsPath), { recursive: true });
  const envReader = () => null;
  const cleanup = () => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  };
  return { root, home, cDir, cFile, accountsPath, envReader, cleanup };
}

test('dynamic provider eligibility: grok and new providers appear automatically when installed or configured', () => {
  const env = makeTempEnv();
  try {
    // Initially nothing is installed and no folders exist.
    const initial = customizationClients({
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      installedToolIds: ['claude', 'codex'],
    });
    const claude0 = initial.find((c) => c.id === 'claude');
    const grok0 = initial.find((c) => c.id === 'grok');
    assert.equal(claude0.available, true);
    assert.equal(grok0.available, false, 'grok is not marked available before the user installs or configures it');

    // Simulate the user starting to use Grok next week (either binary detected or ~/.grok folder created).
    fs.mkdirSync(path.join(env.home, '.grok'), { recursive: true });
    const afterGrokFolder = customizationClients({
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      installedToolIds: ['claude', 'codex'],
    });
    const grok1 = afterGrokFolder.find((c) => c.id === 'grok');
    assert.equal(grok1.available, true, 'grok automatically becomes eligible as soon as ~/.grok exists');
    assert.equal(grok1.ruleFile, 'AGENTS.md');
  } finally {
    env.cleanup();
  }
});

test('multi-account fan-out: skills and rules fan out across all registered account homes for a provider', () => {
  const env = makeTempEnv();
  try {
    const claudeAcct1 = path.join(env.home, '.claude-acct1');
    const claudeAcct2 = path.join(env.home, '.claude-acct2');
    const grokHome = path.join(env.home, '.grok');
    fs.mkdirSync(claudeAcct1, { recursive: true });
    fs.mkdirSync(claudeAcct2, { recursive: true });
    fs.mkdirSync(grokHome, { recursive: true });

    fs.writeFileSync(env.accountsPath, JSON.stringify({
      accounts: [
        { id: 'claude-1', provider: 'claude', label: 'Primary', home: claudeAcct1 },
        { id: 'claude-2', provider: 'claude', label: 'Secondary', home: claudeAcct2 },
      ],
    }), 'utf8');

    saveCustomSkill({
      name: 'deploy-check',
      title: 'Deploy Check',
      description: 'Verify production readiness before shipping.',
      body: '# Deploy Check\nRun preflight checks.',
      clients: ['claude', 'grok'],
    }, {
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      installedToolIds: ['claude', 'grok'],
    });

    // Verify fan-out to default claude home, both registered claude accounts, and grok home.
    assert.ok(fs.existsSync(path.join(env.home, '.claude', 'skills', 'deploy-check', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(claudeAcct1, 'skills', 'deploy-check', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(claudeAcct2, 'skills', 'deploy-check', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(grokHome, 'skills', 'deploy-check', 'SKILL.md')));

    const skills = listInstalledSkills({
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      installedToolIds: ['claude', 'grok', 'codex'],
    });
    const found = skills.find((s) => s.name === 'deploy-check');
    assert.ok(found);
    assert.equal(found.state.claude, 'on');
    assert.equal(found.state.grok, 'on');
    assert.equal(found.state.codex, 'off');

    // Disabling for claude removes it from all claude account homes while keeping the central copy and grok copy.
    setSkillClientState('deploy-check', 'claude', false, {
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      installedToolIds: ['claude', 'grok'],
    });
    assert.equal(fs.existsSync(path.join(claudeAcct1, 'skills', 'deploy-check', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(claudeAcct2, 'skills', 'deploy-check', 'SKILL.md')), false);
    assert.equal(fs.existsSync(path.join(grokHome, 'skills', 'deploy-check', 'SKILL.md')), true);
    assert.equal(fs.existsSync(path.join(env.cDir, 'skills', 'deploy-check', 'SKILL.md')), true, 'central store keeps copy');
  } finally {
    env.cleanup();
  }
});

test('global rules and custom agents: backs up existing files and maps to CLAUDE.md, GEMINI.md, and AGENTS.md', () => {
  const env = makeTempEnv();
  try {
    fs.mkdirSync(path.join(env.home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(env.home, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(env.home, '.grok'), { recursive: true });

    // Write an initial CLAUDE.md so we can verify backup creation on update.
    const claudeRuleFile = path.join(env.home, '.claude', 'CLAUDE.md');
    fs.writeFileSync(claudeRuleFile, '# Old Rule\n', 'utf8');

    syncGlobalInstructionToClients('# Team Standards\nAlways run tests before committing.\n', ['claude', 'antigravity', 'grok'], {
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      installedToolIds: ['claude', 'antigravity', 'grok'],
    });

    assert.match(fs.readFileSync(claudeRuleFile, 'utf8'), /Team Standards/);
    assert.match(fs.readFileSync(path.join(env.home, '.gemini', 'GEMINI.md'), 'utf8'), /Team Standards/);
    assert.match(fs.readFileSync(path.join(env.home, '.grok', 'AGENTS.md'), 'utf8'), /Team Standards/);

    const claudeDirEntries = fs.readdirSync(path.join(env.home, '.claude'));
    assert.ok(claudeDirEntries.some((f) => f.startsWith('CLAUDE.md.bak-')), 'backup created before overwrite');

    const rules = listGlobalRules({
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      installedToolIds: ['claude', 'antigravity', 'grok'],
    });
    assert.equal(rules.instructionFiles.length, 3);

    // Custom agents
    saveCustomAgent({
      name: 'security-reviewer',
      title: 'Security Reviewer',
      description: 'Audits diffs for auth and injection flaws.',
      model: 'inherit',
      body: 'Focus on OWASP Top 10 and credential hygiene.',
      clients: ['claude', 'grok'],
    }, {
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      installedToolIds: ['claude', 'grok'],
    });

    const agents = listCustomAgents({
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      installedToolIds: ['claude', 'grok'],
    });
    assert.equal(agents.length, 1);
    assert.equal(agents[0].name, 'security-reviewer');
    assert.equal(agents[0].state.claude, 'on');
    assert.equal(agents[0].state.grok, 'on');

    setAgentClientState('security-reviewer', 'grok', false, {
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      installedToolIds: ['claude', 'grok'],
    });
    assert.equal(fs.existsSync(path.join(env.home, '.grok', 'agents', 'security-reviewer.md')), false);
  } finally {
    env.cleanup();
  }
});

test('trusted marketplace aggregation: merges Antigravity, Claude Code, Codex caches, and MCP registry without duplicates', () => {
  const env = makeTempEnv();
  try {
    // 1. Mock Antigravity official marketplace cache
    const agyMktDir = path.join(env.home, '.gemini', 'antigravity', 'cache', 'marketplaces', 'antigravity-plugins-official');
    fs.mkdirSync(agyMktDir, { recursive: true });
    fs.writeFileSync(path.join(agyMktDir, 'marketplace.json'), JSON.stringify({
      name: 'antigravity-plugins-official',
      plugins: [
        {
          name: 'chrome-devtools-plugin',
          displayName: 'Chrome DevTools',
          version: '1.2.0',
          description: 'Live Chrome inspection for coding agents.',
          category: 'browser',
          skills: ['./skills/chrome-devtools'],
        },
        {
          name: 'firebase-plugin',
          displayName: 'Firebase Toolkit',
          version: '2.0.0',
          description: 'Deploy and manage Firebase apps.',
          category: 'cloud',
          skills: ['./skills/firebase-basics'],
        },
      ],
    }), 'utf8');

    // 2. Mock Claude Code official marketplace cache
    const claudeMktDir = path.join(env.home, '.claude', 'plugins', 'marketplaces', 'claude-plugins-official', '.claude-plugin');
    fs.mkdirSync(claudeMktDir, { recursive: true });
    fs.writeFileSync(path.join(claudeMktDir, 'marketplace.json'), JSON.stringify({
      name: 'claude-plugins-official',
      plugins: [
        {
          name: 'chrome-devtools-plugin',
          description: 'Chrome DevTools from Claude marketplace.',
          category: 'browser',
        },
      ],
    }), 'utf8');

    const catalog = loadMarketplaceCatalog({
      home: env.home,
      envReader: env.envReader,
      registry: { servers: [] },
    });

    assert.ok(catalog.length > 10, 'marketplace is populated from caches, seeds, and MCP catalog');
    const chrome = catalog.find((i) => i.name === 'chrome-devtools-plugin');
    assert.ok(chrome);
    assert.ok(chrome.sources.includes('google'));
    assert.ok(chrome.sources.includes('anthropic'));

    const googleOnly = searchMarketplace(catalog, { source: 'google', query: 'firebase' });
    assert.equal(googleOnly.length, 1);
    assert.equal(googleOnly[0].name, 'firebase-plugin');

    // Install firebase-plugin from marketplace into claude and grok
    fs.mkdirSync(path.join(env.home, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(env.home, '.grok'), { recursive: true });
    const installed = installMarketplaceItem('firebase-plugin', {
      clients: ['claude', 'grok'],
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      cFile: env.cFile,
      installedToolIds: ['claude', 'grok'],
    });
    assert.equal(installed.ok, true);
    assert.ok(fs.existsSync(path.join(env.home, '.claude', 'skills', 'firebase-basics', 'SKILL.md')));
    assert.ok(fs.existsSync(path.join(env.home, '.grok', 'skills', 'firebase-basics', 'SKILL.md')));

    const plugins = listInstalledPlugins({
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      cFile: env.cFile,
      installedToolIds: ['claude', 'grok'],
    });
    const fb = plugins.find((p) => p.name === 'firebase-plugin');
    assert.ok(fb);
    assert.equal(fb.state.claude, 'on');
    assert.equal(fb.state.grok, 'on');
  } finally {
    env.cleanup();
  }
});

test('installFromGitHub parses owner/repo or URLs and provisions skills across clients', async () => {
  const env = makeTempEnv();
  try {
    const spec1 = parseGitHubSourceSpec('anthropics/skills/frontend-design');
    assert.equal(spec1.owner, 'anthropics');
    assert.equal(spec1.repo, 'skills');
    assert.equal(spec1.subpath, 'frontend-design');
    assert.equal(spec1.slug, 'frontend-design');

    const spec2 = parseGitHubSourceSpec('https://github.com/upstash/context7/tree/main/skills/context7');
    assert.equal(spec2.owner, 'upstash');
    assert.equal(spec2.repo, 'context7');
    assert.equal(spec2.slug, 'context7');

    fs.mkdirSync(path.join(env.home, '.codex'), { recursive: true });
    const mockFetcher = async () => ({
      ok: true,
      text: async () => '---\nname: Custom GitHub Skill\ndescription: Downloaded from GitHub.\n---\n# Instructions\nUse this skill.',
    });

    const res = await installFromGitHub('example-org/awesome-skill', {
      clients: ['codex'],
      home: env.home,
      envReader: env.envReader,
      accountsPath: env.accountsPath,
      cDir: env.cDir,
      installedToolIds: ['codex'],
      fetcher: mockFetcher,
    });
    assert.equal(res.ok, true);
    assert.equal(res.name, 'awesome-skill');
    assert.ok(fs.existsSync(path.join(env.home, '.codex', 'skills', 'awesome-skill', 'SKILL.md')));
  } finally {
    env.cleanup();
  }
});

test('MCP tool schema discovery and runtime tier classification', () => {
  const env = makeTempEnv();
  try {
    const mcpSchemaDir = path.join(env.home, '.gemini', 'antigravity', 'mcp', 'home-assistant');
    fs.mkdirSync(mcpSchemaDir, { recursive: true });
    fs.writeFileSync(path.join(mcpSchemaDir, 'ha_call_service.json'), JSON.stringify({
      name: 'ha_call_service',
      description: 'Call any Home Assistant service.',
    }), 'utf8');
    fs.writeFileSync(path.join(mcpSchemaDir, 'ha_get_state.json'), JSON.stringify({
      name: 'ha_get_state',
      description: 'Inspect entity state.',
    }), 'utf8');

    const discovered = listServerTools('home-assistant', { home: env.home });
    assert.equal(discovered.count, 2);
    assert.deepEqual(discovered.tools.map((t) => t.name), ['ha_call_service', 'ha_get_state']);

    assert.equal(serverRuntime({ name: 'sentry', url: 'https://mcp.sentry.dev/mcp' }), 'remote');
    assert.equal(serverRuntime({ name: 'unifi', command: 'C:\\bin\\unifi.exe' }), 'stdio');
    assert.equal(serverRuntime({ name: 'docker-pg', command: 'docker', args: ['run', '-i', 'mcp/postgres'] }), 'docker');

    assert.equal(isDockerAvailable({ platform: 'win32', fsImpl: { existsSync: () => true } }), true);
    assert.equal(isDockerAvailable({ platform: 'win32', fsImpl: { existsSync: () => false } }), false);

    const matrix = registrationMatrix(
      [{ name: 'home-assistant', url: 'https://ha.example.com/api/mcp' }],
      ['claude'],
      { names: () => ['home-assistant'], auth: () => ['https://ha.example.com/api/mcp'], tools: (n) => listServerTools(n, { home: env.home }).count },
    );
    assert.equal(matrix[0].toolCount, 2);
    assert.equal(matrix[0].runtime, 'remote');
  } finally {
    env.cleanup();
  }
});

test('parseMarkdownFrontmatter handles YAML frontmatter, block scalars (>-), and plain markdown fallbacks', () => {
  const parsed = parseMarkdownFrontmatter('---\nname: My Skill\ndescription: Fast helper\nuser-invocable: true\n---\n# Body\nHello');
  assert.equal(parsed.attributes.name, 'My Skill');
  assert.equal(parsed.attributes.description, 'Fast helper');
  assert.equal(parsed.attributes['user-invocable'], true);
  assert.match(parsed.body, /# Body/);

  const blockScalar = parseMarkdownFrontmatter('---\nname: agy-customizations\ndescription: >-\n  Interactive guide to create and configure\n  Skills, MCP servers, and Custom Agents.\n---\n# Guide');
  assert.equal(blockScalar.attributes.name, 'agy-customizations');
  assert.equal(blockScalar.attributes.description, 'Interactive guide to create and configure Skills, MCP servers, and Custom Agents.');

  const fallback = parseMarkdownFrontmatter('# Plain Heading\n\nFirst paragraph summary.');
  assert.equal(fallback.attributes.title, 'Plain Heading');
  assert.equal(fallback.attributes.description, 'First paragraph summary.');

  const snap = customizationsSnapshot({ home: os.tmpdir(), installedToolIds: ['claude'] });
  assert.ok(Array.isArray(snap.clients));
  assert.ok(snap.marketplaceCount > 0);
});
