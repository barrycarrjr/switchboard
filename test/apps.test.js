import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APPS, parseStartApps, detectApps, orderApps, parseAntigravityAuth, cmdkeyHasCredential } from '../core/apps.js';

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

test('the Codex app is detected under either name the vendor has used', () => {
  const codex = APPS.find((a) => a.id === 'chatgpt');
  assert.equal(codex.name, 'Codex');
  for (const startMenuName of ['Codex', 'ChatGPT']) {
    const detected = detectApps([{ name: startMenuName, appId: 'OpenAI.Codex_2p2nqsd0c76g0!App' }]);
    const hit = detected.find((d) => d.id === 'chatgpt');
    assert.equal(hit.installed, true, `Start menu entry "${startMenuName}"`);
    assert.equal(hit.appId, 'OpenAI.Codex_2p2nqsd0c76g0!App');
  }
  assert.equal(codex.startAppsMatch.test('ChatGPT Helper'), false, 'a longer name is a different app');
});

test('every app the panel offers a menu for can actually be uninstalled', async () => {
  const { uninstallCmdFor } = await import('../core/providers.js');
  for (const a of APPS.filter((x) => x.install.via === 'winget')) {
    const cmd = uninstallCmdFor(a);
    assert.match(cmd, /^winget uninstall --id \S+$/, `${a.id} has a real uninstall command`);
  }
});

test('parseAntigravityAuth pulls name, email, and plan but never the token', () => {
  const proto = Buffer.from('\x10\x01\x1a\x0bAlex Person:\x12alex@example.test\x12\x03Pro\x18\x01', 'latin1').toString('base64');
  const blob = 'sqlitejunk\x00\x01antigravityAuthStatus{"name":"Alex Person","apiKey":"ya29.SECRET-TOKEN","email":"alex@example.test","userStatusProtoBinaryBase64":"' + proto + '"}\x00workbench.panel.size';
  const id = parseAntigravityAuth(blob);
  assert.equal(id.who, 'alex@example.test');
  assert.equal(id.name, 'Alex Person');
  assert.equal(id.plan, 'Pro');
  assert.ok(!JSON.stringify(id).includes('SECRET'), 'the OAuth token must never be extracted');
});

test('parseAntigravityAuth is honest about missing pieces', () => {
  assert.deepEqual(parseAntigravityAuth(''), { who: null, name: null, plan: null });
  assert.deepEqual(parseAntigravityAuth('no auth record here'), { who: null, name: null, plan: null });
  // A record with no readable plan word in the proto still yields the email.
  const noPlan = 'antigravityAuthStatus{"name":"A","apiKey":"x","email":"a@b.c","userStatusProtoBinaryBase64":"AAAA"}';
  assert.deepEqual(parseAntigravityAuth(noPlan), { who: 'a@b.c', name: 'A', plan: null });
});

test('parseAntigravityAuth never mistakes a person or their email for the plan tier', () => {
  // Printable proto strings that merely CONTAIN a tier word must not match.
  const proto = Buffer.from('\x1a\x08Pro Nine:\x0epro@ultra.test\x12\x05Ultra', 'latin1').toString('base64');
  const blob = 'antigravityAuthStatus{"name":"Pro Nine","apiKey":"x","email":"pro@ultra.test","userStatusProtoBinaryBase64":"' + proto + '"}';
  assert.equal(parseAntigravityAuth(blob).plan, 'Ultra');
});

test('cmdkeyHasCredential separates a real Target line from * NONE *', () => {
  const hit = 'Currently stored credentials for gemini:antigravity:\r\n\r\n    Target: LegacyGeneric:target=gemini:antigravity\r\n    Type: Generic\r\n    User: antigravity\r\n';
  const miss = 'Currently stored credentials for gemini:antigravity:\r\n\r\n* NONE *\r\n';
  assert.equal(cmdkeyHasCredential(hit, 'gemini:antigravity'), true);
  assert.equal(cmdkeyHasCredential(miss, 'gemini:antigravity'), false);
  assert.equal(cmdkeyHasCredential('', 'gemini:antigravity'), false);
  // The header names the target too; only a Target line may count.
  assert.equal(cmdkeyHasCredential('Currently stored credentials for gemini:antigravity:\r\n* NONE *\r\n', 'gemini:antigravity'), false);
});

test('parseAntigravityAuth skips key occurrences with no record attached (SQLite index pages)', () => {
  const proto = Buffer.from('\x12\x03Pro', 'latin1').toString('base64');
  const blob = 'page1\x00antigravityAuthStatus\x00page2filler\x00' +
    'antigravityAuthStatus{"name":"Alex Person","apiKey":"x","email":"alex@example.test","userStatusProtoBinaryBase64":"' + proto + '"}';
  const id = parseAntigravityAuth(blob);
  assert.equal(id.who, 'alex@example.test');
  assert.equal(id.plan, 'Pro');
});
