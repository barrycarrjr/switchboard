import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, parseStartApps, detectApps, orderApps } from '../core/apps.js';

test('orderApps applies the saved order and appends unknown apps in default order', () => {
  const apps = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }];
  assert.deepEqual(orderApps(apps, []).map((x) => x.id), ['a', 'b', 'c', 'd']);
  assert.deepEqual(orderApps(apps, ['c', 'a']).map((x) => x.id), ['c', 'a', 'b', 'd']);
  assert.deepEqual(orderApps(apps, ['d', 'ghost', 'b']).map((x) => x.id), ['d', 'b', 'a', 'c']);
});

test('app table invariants: unique ids, detectability, vendor installs or links', () => {
  const ids = APPS.map((a) => a.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const a of APPS) {
    assert.ok(a.name, `${a.id} has a name`);
    assert.ok(a.startAppsMatch instanceof RegExp || a.exePaths, `${a.id} is detectable`);
    assert.match(a.url, /^https:\/\//, `${a.id} has a vendor site`);
    if (a.install.via === 'manual') assert.match(a.install.url, /^https:\/\//);
    else assert.match(a.install.cmd, /^winget /, `${a.id} installs via winget`);
  }
});

test('parseStartApps splits Name|AppID lines and tolerates junk', () => {
  const entries = parseStartApps('Claude|Pkg_abc!Claude\r\nnot a line\r\nT3 Code (Alpha)|com.example.t3\r\n');
  assert.deepEqual(entries, [
    { name: 'Claude', appId: 'Pkg_abc!Claude' },
    { name: 'T3 Code (Alpha)', appId: 'com.example.t3' },
  ]);
  assert.deepEqual(parseStartApps(''), []);
});

test('detectApps matches by Start menu name and reports the rest as not installed', () => {
  const detected = detectApps([
    { name: 'Claude', appId: 'Pkg!Claude' },
    { name: 'T3 Code (Alpha)', appId: 'com.t3' },
    { name: 'Antigravity', appId: 'Google.Antigravity' },
  ]);
  const byId = Object.fromEntries(detected.map((d) => [d.id, d]));
  assert.equal(byId['claude-desktop'].installed, true);
  assert.equal(byId['claude-desktop'].appId, 'Pkg!Claude');
  assert.equal(byId.t3code.installed, true);
  assert.equal(byId.antigravity.installed, true);
  assert.equal(byId.chatgpt.installed, false);
});
