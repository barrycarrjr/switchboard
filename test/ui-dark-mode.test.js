import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'), 'utf8');

// Light surface colours that only make sense on the light theme. A control or highlight painted
// with one of these stays bright in dark mode, which is how the gateway scope dropdown ended up
// as a white box with unreadable text.
const LIGHT_SURFACES = ['#fff', '#ffffff', 'white', '#f0f4f8', '#f8fafc', '#f3f3f3'];

test('no background is painted with a fixed light colour, so dark mode cannot show a white box', () => {
  const offenders = [];
  HTML.split('\n').forEach((line, i) => {
    // The light theme's own token definitions are the one place these values belong.
    if (/^\s*--[a-z-]+\s*:/.test(line)) return;
    for (const m of line.matchAll(/background(?:-color)?\s*[:=]\s*['"]?\s*(#[0-9a-fA-F]{3,6}|white)\b/g)) {
      if (LIGHT_SURFACES.includes(m[1].toLowerCase())) offenders.push(`line ${i + 1}: ${line.trim()}`);
    }
  });
  assert.deepEqual(offenders, []);
});

test('every colour variable the page uses is defined, so nothing silently falls back to transparent', () => {
  const used = new Set([...HTML.matchAll(/var\((--[a-z0-9-]+)/g)].map((m) => m[1]));
  const defined = new Set([...HTML.matchAll(/(?:^|[;{\s])(--[a-z0-9-]+)\s*:/gm)].map((m) => m[1]));
  // Set per element from script, with setProperty, rather than in the stylesheet.
  for (const m of HTML.matchAll(/setProperty\('(--[a-z0-9-]+)'/g)) defined.add(m[1]);
  const missing = [...used].filter((name) => !defined.has(name));
  assert.deepEqual(missing, []);
});
