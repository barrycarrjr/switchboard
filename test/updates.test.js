import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseWingetUpgrade, isNewerVersion } from '../core/providers.js';

test('parseWingetUpgrade: no applicable upgrade reads as up to date', () => {
  assert.deepEqual(parseWingetUpgrade('No applicable upgrade found.', 'Vendor.Tool'), { updateAvailable: false, latest: null });
  assert.deepEqual(parseWingetUpgrade('No installed package found matching input criteria.', 'Vendor.Tool'), { updateAvailable: false, latest: null });
});

test('parseWingetUpgrade: a listed row means an upgrade, with the Available version', () => {
  const stdout = [
    'Name        Id           Version  Available  Source',
    '---------------------------------------------------',
    'Some Tool   Vendor.Tool  2.1.230  2.1.240    winget',
  ].join('\n');
  assert.deepEqual(parseWingetUpgrade(stdout, 'Vendor.Tool'), { updateAvailable: true, latest: '2.1.240' });
});

test('parseWingetUpgrade: unparseable output claims nothing', () => {
  assert.deepEqual(parseWingetUpgrade('something unexpected', 'Vendor.Tool'), { updateAvailable: null, latest: null });
});

test('isNewerVersion compares embedded versions and stays honest about unknowns', () => {
  assert.equal(isNewerVersion('2.2.0', 'tool v2.1.9 (build 7)'), true);
  assert.equal(isNewerVersion('2.1.9', '2.1.9'), false);
  assert.equal(isNewerVersion('2.1.9', '2.2.0'), false);
  assert.equal(isNewerVersion('2.10.0', 'v2.9.1'), true);
  assert.equal(isNewerVersion('latest', 'v2.9.1'), null);
  assert.equal(isNewerVersion('1.0.0', 'no version here'), null);
});
