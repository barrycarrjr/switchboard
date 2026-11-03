import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Customizations tab's one line about skills from the shared AI folder, lifted out of the page.
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
const skillsSyncSummary = new Function(`${lift('skillsSyncSummary')}; return skillsSyncSummary;`)();

test('with no shared skills folder the line says the feature is off and why', () => {
  const t = skillsSyncSummary({ off: 'there is no skills folder in the shared AI folder (x)', skills: [], targets: [] });
  assert.equal(t.tone, 'info');
  assert.match(t.text, /^Off: there is no skills folder/);
});

test('copies to update and hand-kept copies to set aside make a warning that counts them', () => {
  const t = skillsSyncSummary({
    skills: ['a', 'b'],
    targets: [{ action: 'same' }, { action: 'create' }, { action: 'write', keepAs: 'k' }, { action: 'skip' }],
  });
  assert.equal(t.tone, 'warn');
  assert.match(t.text, /2 shared skills/);
  assert.match(t.text, /2 copies to update/);
  assert.match(t.text, /1 hand-kept copy to set aside first/);
});

test('every copy in step is good, a skill also in the own store is a warning, and a failure is bad', () => {
  assert.equal(skillsSyncSummary({ skills: ['a'], targets: [{ action: 'same' }] }).tone, 'ok');
  const both = skillsSyncSummary({ skills: ['a'], targets: [{ action: 'same' }], overridesCentral: ['a'] });
  assert.equal(both.tone, 'warn');
  assert.match(both.text, /shared copy wins/);
  assert.equal(skillsSyncSummary({ skills: ['a'], targets: [{ action: 'failed' }] }).tone, 'bad');
  assert.equal(skillsSyncSummary({ error: 'boom' }).text, 'boom');
});
