import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The Settings page's shared AI folder card, lifted out of the page by text.
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

function lift(name) {
  const lines = HTML.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `found ${name} in index.html`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.ok(end > start, `found the end of ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

// eslint-disable-next-line no-new-func
const load = (name) => new Function(`${lift(name)}; return ${name};`)();
const moveRuleSource = load('moveRuleSource');
const sharedFolderLine = load('sharedFolderLine');
const toggledBackupFolders = load('toggledBackupFolders');

test('moving a rule file up or down swaps it with its neighbour, and a move past either end changes nothing', () => {
  assert.deepEqual(moveRuleSource(['a', 'b', 'c'], 1, -1), ['b', 'a', 'c']);
  assert.deepEqual(moveRuleSource(['a', 'b', 'c'], 1, 1), ['a', 'c', 'b']);
  assert.deepEqual(moveRuleSource(['a', 'b', 'c'], 0, -1), ['a', 'b', 'c']);
  assert.deepEqual(moveRuleSource(['a', 'b', 'c'], 2, 1), ['a', 'b', 'c']);
});

test('the card says plainly when the folder is off or not there yet, and shows the full path when it is', () => {
  assert.match(sharedFolderLine({ path: null }), /^Off\./);
  assert.match(sharedFolderLine({ path: 'X:\\home\\.ai', exists: false }), /does not exist yet.*does not create it/);
  assert.equal(sharedFolderLine({ path: 'X:\\home\\.ai', exists: true }), 'X:\\home\\.ai');
});

test('unticking a folder keeps the ticks for folders that are not there right now', () => {
  assert.deepEqual(toggledBackupFolders(['rules', 'skills'], 'rules', false), ['skills']);
  assert.deepEqual(toggledBackupFolders(['skills'], 'scripts', true), ['skills', 'scripts']);
  assert.deepEqual(toggledBackupFolders(['Rules'], 'rules', true), ['rules'], 'a tick is one per folder, whatever its case');
});

test('the page reaches the shared folder only through the bridge, and every handler is wired', () => {
  const preload = fs.readFileSync(path.join(root, 'src', 'preload.cjs'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  for (const name of ['sharedFolderState', 'sharedFolderChoose', 'sharedFolderSet', 'sharedFolderSetBackups', 'rulesAddSource']) {
    assert.match(preload, new RegExp(`${name}:.*'sb:${name}'`), `${name} is in the bridge`);
    assert.match(main, new RegExp(`ipcMain\\.handle\\('sb:${name}'`), `${name} has a handler`);
  }
  assert.match(main, /properties: \['openDirectory'\]/, 'the folder is picked with a folder chooser');
});
