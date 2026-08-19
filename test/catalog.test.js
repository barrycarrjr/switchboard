import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCatalog, toCatalogEntry } from '../scripts/update-catalog.js';
import { offendingPatterns } from '../scripts/forbidden-patterns.js';

// A fixture shaped like Docker's published catalogue, one of each case that matters.
const REGISTRY = {
  atlassian: {
    title: 'Atlassian',
    description: 'Interact with  Jira,\n Confluence, and Compass.',
    remote: { url: 'https://mcp.atlassian.com/v1/mcp', transport_type: 'streamable-http' },
    metadata: { category: 'Productivity', tags: ['productivity', 'remote', 'Docs'] },
  },
  'ais-fleet': {
    title: 'AIS Fleet',
    description: 'Vessel activity.',
    remote: { url: 'https://mcp.aisfleet.com/sse', transport_type: 'sse' },
    metadata: { category: 'boating', tags: ['boating'] },
  },
  context7: {
    title: 'Context7',
    description: 'Docs in your prompt.',
    remote: { url: 'https://mcp.context7.com/mcp', headers: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' } },
    metadata: { category: 'documentation' },
  },
  'declared-secret': {
    title: 'Declared Secret',
    remote: { url: 'https://mcp.example.com/mcp' },
    secrets: [{ name: 'API_TOKEN' }],
  },
  sqlite: {
    title: 'SQLite',
    description: 'A container image, not a remote server.',
    image: 'mcp/sqlite',
    metadata: { category: 'database' },
  },
  'Odd Name!': {
    title: 'Odd',
    remote: { url: 'https://mcp.odd.example.com/mcp' },
    metadata: {},
  },
  'not-https': {
    title: 'Insecure',
    remote: { url: 'http://mcp.insecure.example.com/mcp' },
    metadata: {},
  },
};

test('only remote servers are kept; container images are left out', () => {
  const { servers } = buildCatalog(REGISTRY);
  assert.ok(!servers.some((s) => s.name === 'sqlite'), 'a container image is not a remote server');
});

// Switchboard stores no secrets, so registering the url alone would give a server that
// looks fine and fails on first use. Not listing it is the honest option.
test('servers needing an api key are excluded, by header or by declaration', () => {
  const { servers, counts } = buildCatalog(REGISTRY);
  assert.ok(!servers.some((s) => s.name === 'context7'), 'excluded via remote.headers');
  assert.ok(!servers.some((s) => s.name === 'declared-secret'), 'excluded via secrets[]');
  assert.equal(counts.needsSecret, 2);
});

test('a non-https endpoint is refused', () => {
  const { servers, counts } = buildCatalog(REGISTRY);
  assert.ok(!servers.some((s) => s.name === 'not-https'));
  assert.equal(counts.unusable, 1);
});

test('the counts explain what happened to everything', () => {
  const { servers, counts } = buildCatalog(REGISTRY);
  assert.equal(counts.total, Object.keys(REGISTRY).length);
  assert.equal(counts.remote, 6, 'six have a remote url');
  assert.equal(servers.length, counts.remote - counts.needsSecret - counts.unusable);
});

test('fields are normalised for use as config keys and search text', () => {
  const e = toCatalogEntry('atlassian', REGISTRY.atlassian);
  assert.equal(e.name, 'atlassian');
  assert.equal(e.description, 'Interact with Jira, Confluence, and Compass.', 'whitespace collapsed');
  assert.equal(e.category, 'productivity', 'lowercased');
  assert.deepEqual(e.tags, ['productivity', 'docs'], 'lowercased, and "remote" carries no information');
  assert.equal(e.transport, 'http');
});

test('an sse endpoint keeps its transport', () => {
  assert.equal(toCatalogEntry('ais-fleet', REGISTRY['ais-fleet']).transport, 'sse');
});

test('an awkward source name becomes a usable one', () => {
  assert.equal(toCatalogEntry('Odd Name!', REGISTRY['Odd Name!']).name, 'odd-name');
});

test('results are sorted by title so the file diffs cleanly between runs', () => {
  const { servers } = buildCatalog(REGISTRY);
  const titles = servers.map((s) => s.title);
  assert.deepEqual(titles, [...titles].sort((a, b) => a.localeCompare(b)));
});

test('an empty or missing registry yields nothing rather than throwing', () => {
  assert.deepEqual(buildCatalog({}).servers, []);
  assert.deepEqual(buildCatalog(undefined).servers, []);
});

// The shipped tree must stay generic; a third party writes these descriptions.
//
// The samples are assembled at runtime rather than written out, because this file is
// itself scanned by the ratchet and a literal example would fail the very check it tests.
test('the generic-source guard catches what the build ratchet would', () => {
  const email = 'someone' + '@' + 'example' + '.com';
  const anthropicKey = 'sk-' + 'ant-' + 'abc123';
  const userPath = 'C:' + '\\Users\\' + 'someone';
  assert.deepEqual(offendingPatterns('a wholly ordinary description'), []);
  assert.equal(offendingPatterns('mail me at ' + email).length, 1);
  assert.equal(offendingPatterns('token ' + anthropicKey).length, 1);
  assert.equal(offendingPatterns(userPath + '\\thing').length, 1);
});

test('the shipped catalogue file passes that same guard', async () => {
  const fs = await import('node:fs');
  const text = fs.readFileSync(new URL('../core/catalog-remote.json', import.meta.url), 'utf8');
  assert.deepEqual(offendingPatterns(text), []);
});
