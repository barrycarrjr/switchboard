import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Customizations tab's one line about rules from one source, lifted out of the page.
const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'), 'utf8');

function lift(name) {
  const lines = HTML.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `found ${name} in index.html`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.ok(end > start, `found the end of ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

// eslint-disable-next-line no-new-func
const rulesSourceSummary = new Function(`${lift('rulesSourceSummary')}; return rulesSourceSummary;`)();

test('with no sources the line says the feature is off and how to turn it on', () => {
  const t = rulesSourceSummary({ sources: [], targets: [] });
  assert.equal(t.tone, 'info');
  assert.match(t.text, /^Off\./);
  assert.match(t.text, /switchboard rules sources/);
});

test('a file out of step is a warning that says how many of how many', () => {
  const t = rulesSourceSummary({
    sources: ['a', 'b'],
    targets: [{ action: 'same' }, { action: 'write' }, { action: 'create' }, { action: 'skip' }],
  });
  assert.equal(t.tone, 'warn');
  assert.match(t.text, /2 source files/);
  assert.match(t.text, /2 of 3 rules files out of step/);
  assert.match(t.text, /1 Claude account reads the sources directly/);
});

test('every written file matching is shown as good, and a refused sync shows its reason', () => {
  assert.equal(rulesSourceSummary({ sources: ['a'], targets: [{ action: 'same' }] }).tone, 'ok');
  const bad = rulesSourceSummary({ error: 'cannot read rule source: x.md', sources: ['x.md'], targets: [] });
  assert.equal(bad.tone, 'bad');
  assert.equal(bad.text, 'cannot read rule source: x.md');
});

test('sources outside the shared AI folder still sync but turn the line into a warning that counts them', () => {
  const t = rulesSourceSummary({ sources: ['a', 'b'], targets: [{ action: 'same' }], outsideSharedFolder: ['b'] });
  assert.equal(t.tone, 'warn');
  assert.match(t.text, /1 outside the shared AI folder/);
});
