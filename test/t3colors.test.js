import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { matchT3Colors, readT3Instances, t3SettingsFile } from '../core/t3colors.js';

/**
 * T3 Code and Switchboard both keep one entry per account folder, so the folder is what
 * lets an account look the same in both. These pin which T3 entries count and how a
 * match is made, using a settings file shaped like the one T3 writes.
 */
function t3File(providerInstances) {
  const file = path.join(tempDir('sb-test-'), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ providerInstances }));
  return file;
}

test('the settings file is looked for under the home folder, where T3 keeps it', () => {
  assert.equal(t3SettingsFile('X:\\home'), path.join('X:\\home', '.t3', 'userdata', 'settings.json'));
});

test('a Claude or Codex instance with a folder and a color is read', () => {
  const file = t3File({
    claudeAgent: { driver: 'claudeAgent', displayName: 'Work', accentColor: '#2563EB', config: { homePath: 'X:\\home\\.claude' } },
    codex: { driver: 'codex', accentColor: '#16a34a', config: { homePath: 'X:\\home\\.codex' } },
  });
  assert.deepEqual(readT3Instances(file), [
    { provider: 'claude', home: 'X:\\home\\.claude', color: '#2563eb', name: 'Work' },
    { provider: 'codex', home: 'X:\\home\\.codex', color: '#16a34a', name: null },
  ]);
});

test('an instance that cannot be tied to one folder and one color is left out', () => {
  const file = t3File({
    blank: { driver: 'claudeAgent', accentColor: '#2563eb', config: { homePath: '' } },
    noColor: { driver: 'claudeAgent', config: { homePath: 'X:\\home\\.claude-two' } },
    named: { driver: 'claudeAgent', accentColor: 'rebeccapurple', config: { homePath: 'X:\\home\\.claude-three' } },
    grok: { driver: 'grok', accentColor: '#000000', config: { homePath: 'X:\\home\\.grok' } },
  });
  assert.deepEqual(readT3Instances(file), [], 'a blank folder is not assumed to be the default one');
});

test('no T3 settings, or ones that do not parse, simply means no colors', () => {
  assert.deepEqual(readT3Instances(path.join(tempDir('sb-test-'), 'missing.json')), []);
  const broken = path.join(tempDir('sb-test-'), 'settings.json');
  fs.writeFileSync(broken, '{ not json');
  assert.deepEqual(readT3Instances(broken), []);
});

test('an account takes the color of the T3 instance on the same folder and tool', () => {
  const registry = { accounts: [
    { id: 'claude-main', provider: 'claude', label: 'Main', home: 'X:\\Home\\.claude' },
    { id: 'claude-two', provider: 'claude', label: 'Two', home: 'X:\\home\\.claude-account-2' },
    { id: 'codex-main', provider: 'codex', label: 'Main', home: 'X:\\home\\.claude' },
  ] };
  const instances = [
    { provider: 'claude', home: 'x:\\home\\.claude\\', color: '#2563eb' },
    { provider: 'claude', home: 'X:\\home\\.claude-other', color: '#b225eb' },
  ];
  assert.deepEqual(matchT3Colors(registry, instances), { 'claude-main': '#2563eb' },
    'folder case and a trailing slash do not matter, but the tool does');
});
