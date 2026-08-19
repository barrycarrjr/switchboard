import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// The same list the build ratchet uses, so a description written by a third party cannot
// slip a credential-shaped string into the shipped tree and fail the build later.
import { offendingPatterns } from './forbidden-patterns.js';

/**
 * Regenerates `core/catalog-remote.json`, the browse list of public MCP servers.
 *
 * The source is Docker's published MCP catalogue, fetched over plain HTTPS. Docker itself
 * is not needed: this is a JSON file on a web server, and the result is data we ship, not
 * a dependency we take on. Run it when the list goes stale:
 *
 *   npm run catalog
 *
 * Two filters are applied, and both matter:
 *
 *  - **Remote only.** Switchboard registers an https endpoint with a client. The rest of
 *    the catalogue is container images that need Docker running to do anything, which is
 *    not something this app has any business arranging.
 *  - **No secrets.** An entry that needs an API key in a header cannot work here, because
 *    Switchboard stores no secrets by design. Registering its url alone would produce a
 *    server that looks fine and fails on first use, which is worse than not listing it.
 */

const SOURCE = 'https://desktop.docker.com/mcp/catalog/v3/catalog.json';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'catalog-remote.json');

/** Names become config keys in three different tools, so keep them boring. */
function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
}

function needsSecret(entry) {
  const headers = entry.remote?.headers;
  if (headers && Object.keys(headers).length) return true;
  return Array.isArray(entry.secrets) && entry.secrets.length > 0;
}

export function toCatalogEntry(name, entry) {
  return {
    name: slug(name),
    title: entry.title || name,
    description: String(entry.description || '').trim().replace(/\s+/g, ' '),
    url: entry.remote.url,
    transport: /sse/i.test(entry.remote.transport_type || '') ? 'sse' : 'http',
    category: String(entry.metadata?.category || 'other').toLowerCase(),
    // `remote` is on every entry here by definition, so it carries no information.
    tags: (entry.metadata?.tags || []).map((t) => String(t).toLowerCase()).filter((t) => t !== 'remote'),
  };
}

/** Pure so the filtering can be tested without going near the network. */
export function buildCatalog(registry) {
  const kept = [];
  const counts = { total: 0, remote: 0, needsSecret: 0, unusable: 0 };
  for (const [name, entry] of Object.entries(registry ?? {})) {
    counts.total += 1;
    if (!entry?.remote?.url) continue;
    counts.remote += 1;
    if (needsSecret(entry)) {
      counts.needsSecret += 1;
      continue;
    }
    const built = toCatalogEntry(name, entry);
    if (!built.name || !/^https:\/\//.test(built.url)) {
      counts.unusable += 1;
      continue;
    }
    kept.push(built);
  }
  kept.sort((a, b) => a.title.localeCompare(b.title));
  return { servers: kept, counts };
}

async function main() {
  process.stdout.write(`Fetching ${SOURCE}\n`);
  const res = await fetch(SOURCE, { headers: { 'user-agent': 'switchboard-update-catalog' } });
  if (!res.ok) throw new Error(`catalogue fetch failed: ${res.status} ${res.statusText}`);
  const doc = await res.json();
  const { servers, counts } = buildCatalog(doc.registry);
  if (!servers.length) throw new Error('catalogue came back empty; refusing to overwrite a good file');

  const text = JSON.stringify(servers, null, 2) + '\n';
  const offenders = offendingPatterns(text);
  if (offenders.length) {
    throw new Error(`refusing to write: the catalogue contains ${offenders.join(', ')}`);
  }

  const before = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')).length : 0;
  fs.writeFileSync(OUT, text);

  const categories = new Set(servers.map((s) => s.category));
  process.stdout.write(
    `\n${counts.total} servers in the catalogue\n`
    + `  ${counts.remote} are remote (the rest are container images and need Docker)\n`
    + `  ${counts.needsSecret} of those need an API key, so they cannot work without stored secrets\n`
    + (counts.unusable ? `  ${counts.unusable} skipped as malformed\n` : '')
    + `\nWrote ${servers.length} servers in ${categories.size} categories to core/catalog-remote.json`
    + (before ? ` (was ${before})\n` : '\n'),
  );
}

// Only run when invoked directly, so the pure functions above stay importable by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((e) => {
    process.stderr.write(`\n${e.message}\n`);
    process.exit(1);
  });
}
