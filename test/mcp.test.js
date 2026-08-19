import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FEATURED,
  CLIENTS,
  isValidServerName,
  isValidHttpUrl,
  assertValidServer,
  loadServers,
  saveServers,
  addServer,
  removeServer,
  allServers,
  browseServers,
  sameEndpoint,
  supportsClient,
  cleanCliError,
  registerServer,
  dedupeServers,
  yourServers,
  parseCodexServerNames,
  parseJsonServerNames,
  upsertJsonServer,
  deleteJsonServer,
  pruneBackups,
  parseClaudeAuthorizedUrls,
  authorizedUrls,
  claudeUserConfigFile,
  registrationMatrix,
  searchCatalog,
  categoriesOf,
  catalogServers,
} from '../core/mcp.js';

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sb-mcp-test-'));
}

test('server registry roundtrip through a file', () => {
  const dir = tmp();
  const file = path.join(dir, 'mcp.json');
  const reg = loadServers(file);
  assert.deepEqual(reg.servers, []);
  addServer(reg, { name: 'example', url: 'https://mcp.example.com/mcp', label: 'Example' });
  saveServers(reg, file);
  const back = loadServers(file);
  assert.equal(back.servers.length, 1);
  assert.equal(back.servers[0].name, 'example');
  assert.equal(back.servers[0].label, 'Example');
});

test('a corrupt registry file loads as empty, never throws', () => {
  const dir = tmp();
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{not json');
  assert.deepEqual(loadServers(file).servers, []);
});

test('saveServers writes atomically: no temp files left behind', () => {
  const dir = tmp();
  const file = path.join(dir, 'mcp.json');
  const reg = { servers: [] };
  addServer(reg, { name: 'example', url: 'https://mcp.example.com/mcp' });
  saveServers(reg, file);
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.includes('.tmp')), []);
});

test('duplicate server names are rejected', () => {
  const reg = { servers: [] };
  addServer(reg, { name: 'example', url: 'https://mcp.example.com/mcp' });
  assert.throws(() => addServer(reg, { name: 'example', url: 'https://other.example.com/mcp' }), /already registered/);
});

test('removing an unknown server throws rather than silently doing nothing', () => {
  const reg = { servers: [] };
  assert.throws(() => removeServer(reg, 'nope'), /no such server/);
});

test('names are restricted to lowercase, digits and hyphens', () => {
  assert.ok(isValidServerName('atlassian'));
  assert.ok(isValidServerName('slack-second-workspace'));
  assert.ok(isValidServerName('a1'));
  assert.ok(!isValidServerName('Atlassian'), 'uppercase rejected');
  assert.ok(!isValidServerName('two words'), 'spaces rejected');
  assert.ok(!isValidServerName('-leading'), 'leading hyphen rejected');
  assert.ok(!isValidServerName(''), 'empty rejected');
  assert.ok(!isValidServerName('a'.repeat(65)), 'over-long rejected');
  assert.ok(!isValidServerName(undefined), 'missing rejected');
});

// A url is passed to a shell on Windows, so the guard matters beyond tidiness.
test('only plain https urls are accepted', () => {
  assert.ok(isValidHttpUrl('https://mcp.example.com/mcp'));
  assert.ok(!isValidHttpUrl('http://mcp.example.com/mcp'), 'plain http rejected');
  assert.ok(!isValidHttpUrl('file:///etc/passwd'), 'file scheme rejected');
  assert.ok(!isValidHttpUrl('not a url'), 'nonsense rejected');
  assert.ok(!isValidHttpUrl(''), 'empty rejected');
  assert.ok(!isValidHttpUrl(undefined), 'missing rejected');
});

test('shell metacharacters in a url are refused', () => {
  for (const bad of [
    'https://example.com/mcp && calc',
    'https://example.com/mcp; whoami',
    'https://example.com/mcp | more',
    'https://example.com/$(whoami)',
    'https://example.com/`whoami`',
    'https://example.com/mcp with space',
    'https://example.com/"quoted"',
  ]) {
    assert.ok(!isValidHttpUrl(bad), `should reject: ${bad}`);
  }
});

test('assertValidServer explains what is wrong', () => {
  assert.throws(() => assertValidServer({ name: 'Bad Name', url: 'https://example.com/mcp' }), /invalid server name/);
  assert.throws(() => assertValidServer({ name: 'ok', url: 'http://example.com/mcp' }), /invalid server url/);
  assert.throws(() => assertValidServer(null), /needs a name and a url/);
});

test('every catalogue entry is valid and would be accepted by the same guard', () => {
  for (const entry of FEATURED) {
    assert.doesNotThrow(() => assertValidServer(entry), `catalogue entry ${entry.name} is invalid`);
    assert.ok(entry.label, `catalogue entry ${entry.name} needs a label`);
  }
  const names = FEATURED.map((e) => e.name);
  assert.equal(new Set(names).size, names.length, 'catalogue names must be unique');
});

test('a locally added server overrides a catalogue entry of the same name', () => {
  const reg = { servers: [{ name: 'atlassian', url: 'https://mcp.example.com/private', label: 'Mine' }] };
  const all = allServers(reg);
  const hits = all.filter((s) => s.name === 'atlassian');
  assert.equal(hits.length, 1, 'no duplicate entries');
  assert.equal(hits[0].url, 'https://mcp.example.com/private');
});

test('allServers is the featured list when nothing is added locally', () => {
  const all = allServers({ servers: [] });
  assert.equal(all.length, FEATURED.length);
});

// ---- The two views ----

test('the featured list stays short; the catalogue is the long tail', () => {
  const cat = catalogServers();
  assert.ok(cat.length > 20, `catalogue should be substantial, got ${cat.length}`);
  assert.ok(FEATURED.length < 12, 'featured is a starting point, not a directory');
  for (const e of cat) {
    assert.ok(e.name && e.title && e.url, `catalogue entry is incomplete: ${JSON.stringify(e).slice(0, 80)}`);
    assert.ok(/^https:\/\//.test(e.url), `catalogue url must be https: ${e.url}`);
  }
});

test('browse shows featured and catalogue together with no duplicates', () => {
  const rows = browseServers({ servers: [] });
  const names = rows.map((r) => r.name);
  assert.equal(new Set(names).size, names.length, 'no duplicate names across the two sources');
  assert.ok(rows.length >= catalogServers().length, 'the catalogue is included');
});

test('a locally added server wins over both featured and catalogue in browse', () => {
  const rows = browseServers({ servers: [{ name: 'atlassian', url: 'https://mine.example.com/mcp' }] });
  const hits = rows.filter((r) => r.name === 'atlassian');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].url, 'https://mine.example.com/mcp');
});

// The featured list calls it `atlassian`, the catalogue calls it `atlassian-remote`, and
// both are the same endpoint. Showing it twice meant the copy someone found by searching
// was the one their clients were not registered against.
test('the same endpoint under two names appears once', () => {
  const rows = browseServers({ servers: [] });
  const atlassians = rows.filter((r) => sameEndpoint(r.url, 'https://mcp.atlassian.com/v1/mcp'));
  assert.equal(atlassians.length, 1, 'one Atlassian, not two');
  assert.equal(atlassians[0].name, 'atlassian', 'the featured entry is the one kept');
});

test('no two browse rows share an endpoint', () => {
  const rows = browseServers({ servers: [] });
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      assert.ok(!sameEndpoint(rows[i].url, rows[j].url), `duplicate endpoint: ${rows[i].name} and ${rows[j].name}`);
    }
  }
});

// Deduping must not lose the catalogue's description: it is what makes a featured entry
// findable. Searching "jira" returned nothing once, because the kept entry had no text.
test('the kept entry gains the duplicate\'s description, category and tags', () => {
  const merged = dedupeServers([
    { name: 'atlassian', label: 'Atlassian (Jira, Confluence)', url: 'https://mcp.atlassian.com/v1/mcp', note: 'Needs no secret.' },
    { name: 'atlassian-remote', title: 'Atlassian', description: 'Work with Jira and Confluence', category: 'productivity', tags: ['docs'], url: 'https://mcp.atlassian.com/v1/mcp' },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].name, 'atlassian', 'identity comes from the curated entry');
  assert.equal(merged[0].label, 'Atlassian (Jira, Confluence)', 'curated wording is kept');
  assert.equal(merged[0].note, 'Needs no secret.', 'curated note is kept');
  assert.equal(merged[0].description, 'Work with Jira and Confluence', 'description is gained');
  assert.equal(merged[0].category, 'productivity');
  assert.deepEqual(merged[0].tags, ['docs']);
});

test('merging does not mutate the source lists', () => {
  const featured = [{ name: 'a', url: 'https://x.example.com/mcp' }];
  dedupeServers([...featured, { name: 'a-remote', url: 'https://x.example.com/mcp', description: 'added' }]);
  assert.equal(featured[0].description, undefined, 'FEATURED must not be polluted between calls');
});

test('a featured server is findable by text that only the catalogue carries', () => {
  const rows = searchCatalog(browseServers({ servers: [] }), { query: 'jira' });
  assert.ok(rows.length >= 1, 'searching "jira" must find something');
  assert.ok(rows.some((r) => sameEndpoint(r.url, 'https://mcp.atlassian.com/v1/mcp')), 'and it must be Atlassian');
});

test('endpoint comparison ignores trailing slashes and case', () => {
  assert.ok(sameEndpoint('https://mcp.example.com/mcp', 'https://MCP.example.com/mcp/'));
  assert.ok(!sameEndpoint('https://a.example.com/mcp', 'https://b.example.com/mcp'));
  assert.ok(!sameEndpoint('', ''), 'two blanks are not a match');
  assert.ok(!sameEndpoint(undefined, undefined));
});

test('search matches title, description and tags, not just the name', () => {
  const servers = [
    { name: 'atlassian', title: 'Atlassian', description: 'Work with Jira and Confluence', tags: ['project-management'], category: 'productivity' },
    { name: 'sentry', title: 'Sentry', description: 'Error tracking', tags: ['monitoring'], category: 'monitoring' },
  ];
  assert.deepEqual(searchCatalog(servers, { query: 'jira' }).map((s) => s.name), ['atlassian'], 'found via description');
  assert.deepEqual(searchCatalog(servers, { query: 'project-management' }).map((s) => s.name), ['atlassian'], 'found via tag');
  assert.deepEqual(searchCatalog(servers, { query: 'SENTRY' }).map((s) => s.name), ['sentry'], 'case-insensitive');
  assert.equal(searchCatalog(servers, { query: '' }).length, 2, 'empty query matches everything');
  assert.equal(searchCatalog(servers, { query: 'nothing-here' }).length, 0);
});

test('category filter and query combine', () => {
  const servers = [
    { name: 'a', title: 'Alpha', category: 'productivity', tags: [] },
    { name: 'b', title: 'Beta', category: 'monitoring', tags: [] },
    { name: 'c', title: 'Alpha Two', category: 'monitoring', tags: [] },
  ];
  assert.deepEqual(searchCatalog(servers, { category: 'monitoring' }).map((s) => s.name), ['b', 'c']);
  assert.deepEqual(searchCatalog(servers, { category: 'monitoring', query: 'alpha' }).map((s) => s.name), ['c']);
});

test('categories are counted and ordered by size', () => {
  const cats = categoriesOf([
    { category: 'devops' }, { category: 'devops' }, { category: 'ai' }, { category: undefined },
  ]);
  assert.deepEqual(cats[0], { name: 'devops', count: 2 });
  assert.ok(cats.some((c) => c.name === 'other'), 'a missing category is bucketed, not dropped');
});

// The dialects conflict in ways that are destructive to get wrong, so the command
// each client receives is asserted here rather than trusted.
test('claude is registered at user scope over http', () => {
  const args = CLIENTS.claude.addArgs({ name: 'example', url: 'https://mcp.example.com/mcp' });
  assert.deepEqual(args, ['mcp', 'add', '-t', 'http', '-s', 'user', 'example', 'https://mcp.example.com/mcp']);
});

test('claude scope is user, never the default local scope', () => {
  const args = CLIENTS.claude.addArgs({ name: 'example', url: 'https://mcp.example.com/mcp' });
  const scope = args[args.indexOf('-s') + 1];
  assert.equal(scope, 'user', 'local scope would tie the server to one folder');
});

test('codex is registered with --url, not as a command', () => {
  const args = CLIENTS.codex.addArgs({ name: 'example', url: 'https://mcp.example.com/mcp' });
  assert.deepEqual(args, ['mcp', 'add', 'example', '--url', 'https://mcp.example.com/mcp']);
});

// VS Code goes through its own config file, not `code --add-mcp`: that command can add
// but never list or remove, and its JSON argument does not survive the shell these entry
// points need on Windows.
test('vscode is edited through its config file, not its CLI', () => {
  assert.equal(CLIENTS.vscode.via, 'file');
  assert.equal(CLIENTS.vscode.rootKey, 'servers', 'VS Code calls the map `servers`');
  assert.equal(CLIENTS.vscode.addArgs, undefined, 'no CLI path exists for it');
  assert.deepEqual(CLIENTS.vscode.entry({ name: 'x', url: 'https://mcp.example.com/mcp' }), {
    type: 'http',
    url: 'https://mcp.example.com/mcp',
  });
});

test('every client can both add and undo, one way or the other', () => {
  for (const [id, c] of Object.entries(CLIENTS)) {
    const cliCapable = typeof c.addArgs === 'function' && typeof c.removeArgs === 'function';
    const fileCapable = c.via === 'file' && typeof c.configFile === 'function' && typeof c.entry === 'function';
    assert.ok(cliCapable || fileCapable, `${id} must be able to both add and remove`);
  }
});

// ---- Editing a JSON config safely ----

test('upsert adds a server and leaves everything else alone', () => {
  const before = '{"servers":{"existing":{"type":"stdio","command":"x"}},"other":42}';
  const after = JSON.parse(upsertJsonServer(before, 'servers', 'added', { type: 'http', url: 'https://mcp.example.com/mcp' }));
  assert.deepEqual(Object.keys(after.servers).sort(), ['added', 'existing']);
  assert.equal(after.other, 42, 'unrelated keys survive');
  assert.equal(after.servers.existing.command, 'x', 'existing servers survive untouched');
});

test('upsert on an empty or missing file creates the structure', () => {
  assert.deepEqual(JSON.parse(upsertJsonServer('', 'servers', 'a', { url: 'u' })), { servers: { a: { url: 'u' } } });
  assert.deepEqual(JSON.parse(upsertJsonServer('{}', 'servers', 'a', { url: 'u' })), { servers: { a: { url: 'u' } } });
});

test('upsert replaces an entry of the same name rather than duplicating it', () => {
  const out = upsertJsonServer('{"servers":{"a":{"url":"old"}}}', 'servers', 'a', { url: 'new' });
  assert.deepEqual(JSON.parse(out).servers, { a: { url: 'new' } });
});

// Silently rewriting a config nobody can parse is how a client loses its whole server
// list. Refusing is the only safe answer.
test('a malformed config is refused, never rewritten', () => {
  assert.throws(() => upsertJsonServer('{not json', 'servers', 'a', {}), /not valid JSON/);
  assert.throws(() => upsertJsonServer('[1,2,3]', 'servers', 'a', {}), /not a JSON object/);
  assert.throws(() => deleteJsonServer('{not json', 'servers', 'a'), /not valid JSON/);
});

test('delete removes only the named server', () => {
  const { changed, out } = deleteJsonServer('{"servers":{"a":{},"b":{}},"keep":1}', 'servers', 'a');
  assert.equal(changed, true);
  const doc = JSON.parse(out);
  assert.deepEqual(Object.keys(doc.servers), ['b']);
  assert.equal(doc.keep, 1);
});

test('deleting something absent changes nothing and says so', () => {
  const original = '{"servers":{"a":{}}}';
  const { changed, out } = deleteJsonServer(original, 'servers', 'nope');
  assert.equal(changed, false);
  assert.equal(out, original, 'the file is returned untouched');
});

test('written json is readable by the same parser that reports state', () => {
  const out = upsertJsonServer('', 'servers', 'roundtrip', { type: 'http', url: 'https://mcp.example.com/mcp' });
  assert.deepEqual(parseJsonServerNames(out, 'servers'), ['roundtrip']);
});

// Servers get added and removed often, so backups must not pile up the way a one-off
// health fix's would.
test('only the newest few backups survive a prune', () => {
  const dir = tmp();
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{}');
  for (const stamp of ['2026-01-01T00-00-00-000Z', '2026-02-01T00-00-00-000Z', '2026-03-01T00-00-00-000Z', '2026-04-01T00-00-00-000Z', '2026-05-01T00-00-00-000Z']) {
    fs.writeFileSync(`${file}.bak-${stamp}`, '{}');
  }
  const removed = pruneBackups(file, 3);
  assert.equal(removed.length, 2, 'the two oldest go');
  const left = fs.readdirSync(dir).filter((n) => n.includes('.bak-')).sort();
  assert.deepEqual(left, [
    'mcp.json.bak-2026-03-01T00-00-00-000Z',
    'mcp.json.bak-2026-04-01T00-00-00-000Z',
    'mcp.json.bak-2026-05-01T00-00-00-000Z',
  ]);
  assert.ok(fs.existsSync(file), 'the config itself is never pruned');
});

test('pruning leaves unrelated files and other configs alone', () => {
  const dir = tmp();
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(dir, 'other.json.bak-2026-01-01T00-00-00-000Z'), '{}');
  for (const s of ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']) {
    fs.writeFileSync(`${file}.bak-${s}T00-00-00-000Z`, '{}');
  }
  pruneBackups(file, 3);
  const left = fs.readdirSync(dir).sort();
  assert.ok(left.includes('settings.json'), 'unrelated file survives');
  assert.ok(left.includes('other.json.bak-2026-01-01T00-00-00-000Z'), "another config's backup survives");
  assert.equal(left.filter((n) => n.startsWith('mcp.json.bak-')).length, 3);
});

test('pruning a directory that does not exist is not an error', () => {
  assert.deepEqual(pruneBackups(path.join(tmp(), 'nope', 'mcp.json'), 3), []);
});

test('fewer backups than the limit means nothing is removed', () => {
  const dir = tmp();
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, '{}');
  fs.writeFileSync(`${file}.bak-2026-01-01T00-00-00-000Z`, '{}');
  assert.deepEqual(pruneBackups(file, 3), []);
});

test('claude desktop is not a supported client', () => {
  // Writing a url into its config file makes the application delete its whole
  // server list, so it must never appear in this table.
  assert.equal(CLIENTS['claude-desktop'], undefined);
  for (const id of Object.keys(CLIENTS)) {
    assert.ok(!/desktop/i.test(id), `${id} must not target Claude Desktop`);
  }
});

test('every client says who it is, how to find it, and where its config lives', () => {
  for (const [id, c] of Object.entries(CLIENTS)) {
    assert.equal(c.id, id, 'id matches its key');
    assert.ok(c.name, `${id} needs a display name`);
    // A command on PATH, or its own presence check for plugin-style clients like Junie.
    assert.ok(c.bin || typeof c.detect === 'function', `${id} needs a binary or a detect()`);
    assert.ok(typeof c.addArgs === 'function' || c.via === 'file', `${id} needs a way to add`);
    assert.equal(typeof c.configFile, 'function', `${id} needs to say where its config lives`);
  }
});

test('the CLI-driven clients can remove what they added', () => {
  assert.equal(typeof CLIENTS.claude.removeArgs, 'function');
  assert.equal(typeof CLIENTS.codex.removeArgs, 'function');
});

// ---- Reading what a client already has ----

test('codex server names come from table headers', () => {
  const toml = `
model_reasoning_effort = "high"

[mcp_servers.atlassian]
url = "https://mcp.example.com/mcp"

[mcp_servers.other]
command = "npx"
`;
  assert.deepEqual(parseCodexServerNames(toml).sort(), ['atlassian', 'other']);
});

// The real config on a developer machine has these, and counting the sub-table as its
// own server would show a phantom entry named "node_repl.env".
test('a codex sub-table is the same server, not a second one', () => {
  const toml = `
[mcp_servers.node_repl]
command = "node_repl.exe"

[mcp_servers.node_repl.env]
CODEX_HOME = "somewhere"
`;
  assert.deepEqual(parseCodexServerNames(toml), ['node_repl']);
});

test('quoted codex table keys are unwrapped', () => {
  assert.deepEqual(parseCodexServerNames('[mcp_servers."my-server"]'), ['my-server']);
  assert.deepEqual(parseCodexServerNames("[mcp_servers.'my-server'.env]"), ['my-server']);
});

test('codex config with no servers, or unreadable content, reports nothing', () => {
  assert.deepEqual(parseCodexServerNames('model = "x"'), []);
  assert.deepEqual(parseCodexServerNames(''), []);
  assert.deepEqual(parseCodexServerNames(null), []);
  // A similarly named table must not be mistaken for a server.
  assert.deepEqual(parseCodexServerNames('[mcp_servers_backup.foo]'), []);
});

test('json server names come from the client-specific root key', () => {
  const claude = '{"mcpServers":{"a":{},"b":{}},"other":1}';
  assert.deepEqual(parseJsonServerNames(claude, 'mcpServers').sort(), ['a', 'b']);
  // VS Code calls the same thing `servers`; reading the wrong key must find nothing
  // rather than quietly reporting another client's list.
  assert.deepEqual(parseJsonServerNames(claude, 'servers'), []);
  const vscode = '{"servers":{"c":{}}}';
  assert.deepEqual(parseJsonServerNames(vscode, 'servers'), ['c']);
});

test('malformed or empty json reports nothing instead of throwing', () => {
  assert.deepEqual(parseJsonServerNames('{not json', 'mcpServers'), []);
  assert.deepEqual(parseJsonServerNames('', 'mcpServers'), []);
  assert.deepEqual(parseJsonServerNames('{"mcpServers":[]}', 'mcpServers'), [], 'an array is not a server map');
  assert.deepEqual(parseJsonServerNames('{"mcpServers":null}', 'mcpServers'), []);
});

// Reading the wrong file reports servers the client is not actually loading, which is
// worse than reporting none, so the two cases are pinned down by test.
test('claude user config follows CLAUDE_CONFIG_DIR when it is set', () => {
  const file = claudeUserConfigFile(() => path.join('D:', 'somewhere', '.claude'));
  assert.equal(path.basename(file), '.claude.json');
  assert.equal(path.dirname(file), path.join('D:', 'somewhere', '.claude'));
});

test('claude user config falls back to the home directory when it is not set', () => {
  const file = claudeUserConfigFile(() => null);
  assert.equal(file, path.join(os.homedir(), '.claude.json'));
});

test('the matrix marks each server per client without inventing entries', () => {
  const servers = [{ name: 'alpha', url: 'https://a.example.com/mcp' }, { name: 'beta', url: 'https://b.example.com/mcp' }];
  const rows = registrationMatrix(servers, []);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].state, {}, 'no clients asked means no claims made');
  assert.equal(rows[0].name, 'alpha', 'the original fields survive');
  assert.equal(rows[0].url, 'https://a.example.com/mcp');
});

// ---- Sign-in state ----

test('claude authorised urls are read from its credentials file', () => {
  const text = JSON.stringify({
    mcpOAuth: {
      'slack|abc123': { serverName: 'slack', serverUrl: 'https://mcp.slack.com/mcp', accessToken: 'secret' },
      'zapier|def456': { serverName: 'zapier', serverUrl: 'https://mcp.zapier.com/api/v1/connect' },
    },
  });
  assert.deepEqual(parseClaudeAuthorizedUrls(text).sort(), [
    'https://mcp.slack.com/mcp',
    'https://mcp.zapier.com/api/v1/connect',
  ]);
});

// Matching on url, not name: the same service may be registered under a different name.
test('a credentials file with no oauth section, or junk, reports nothing', () => {
  assert.deepEqual(parseClaudeAuthorizedUrls('{"claudeAiOauth":{}}'), []);
  assert.deepEqual(parseClaudeAuthorizedUrls('{not json'), []);
  assert.deepEqual(parseClaudeAuthorizedUrls(''), []);
  assert.deepEqual(parseClaudeAuthorizedUrls('{"mcpOAuth":{"a|1":{"serverName":"a"}}}'), [], 'an entry with no url is skipped');
});

test('junie is present when its config folder is, not via a binary', () => {
  assert.equal(CLIENTS.junie.via, 'file');
  assert.equal(CLIENTS.junie.rootKey, 'mcpServers');
  assert.equal(typeof CLIENTS.junie.detect, 'function');
  assert.equal(CLIENTS.junie.bin, undefined, 'Junie is an IDE plugin, not a command');
  assert.deepEqual(CLIENTS.junie.entry({ name: 'x', url: 'https://mcp.example.com/mcp' }), { url: 'https://mcp.example.com/mcp' });
});

test('a client that cannot report sign-in returns null rather than guessing', () => {
  // Codex keeps MCP tokens in the OS credential store, so there is nothing to read.
  assert.equal(CLIENTS.codex.authFile, undefined);
  assert.equal(authorizedUrls('codex'), null);
});

// ---- A server that cannot work in a client ----
//
// Slack needs a pre-registered confidential client. Codex fails loudly at sign-in, while a
// file-edited client like Junie writes config that simply never works. Naming the clients
// it can use stops the attempt instead of explaining the wreckage afterwards.

test('a server with an only list is restricted to those clients', () => {
  const s = { name: 'slack', only: ['claude'] };
  assert.equal(supportsClient(s, 'claude'), true);
  assert.equal(supportsClient(s, 'codex'), false);
  assert.equal(supportsClient(s, 'junie'), false);
  assert.equal(supportsClient(s, 'vscode'), false);
});

test('a server with no only list works anywhere', () => {
  for (const id of Object.keys(CLIENTS)) {
    assert.equal(supportsClient({ name: 'atlassian' }, id), true);
  }
  assert.equal(supportsClient(undefined, 'claude'), true);
});

test('the shipped Slack entry is restricted to the client that can sign in', () => {
  const slack = FEATURED.find((s) => s.name === 'slack');
  assert.deepEqual(slack.only, ['claude']);
  assert.ok(slack.caveat, 'and says why');
});

test('registering somewhere unsupported is refused before anything is run', async () => {
  await assert.rejects(
    () => registerServer('codex', { name: 'slack', url: 'https://mcp.slack.com/mcp', only: ['claude'] }),
    /cannot be used from Codex/,
  );
});

// ---- Turning a CLI failure into something a person can act on ----

test('the command echo and the stacked prefixes are stripped', () => {
  const raw = 'Command failed: codex mcp add slack --url https://mcp.slack.com/mcp\n'
    + 'Error: Registration failed: Dynamic registration failed: Registration failed: '
    + 'Dynamic client registration not supported';
  const out = cleanCliError(raw);
  assert.equal(out, 'Dynamic client registration not supported');
  assert.ok(!/Command failed/.test(out), 'the invocation says nothing the button did not');
  assert.ok(!/mcp add/.test(out));
});

test('a repeated prefix is not shown twice', () => {
  assert.equal(cleanCliError('Error: Error: Something broke'), 'Something broke');
});

test('a plain message survives intact', () => {
  assert.equal(cleanCliError('the server refused the connection'), 'the server refused the connection');
});

test('an empty failure still says something', () => {
  assert.match(cleanCliError(''), /without saying why/);
  assert.match(cleanCliError(undefined), /without saying why/);
});
