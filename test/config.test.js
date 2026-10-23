import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FORMAT,
  CONFIG_VERSION,
  configSummary,
  createSwitchboardConfig,
  parseSwitchboardConfig,
  settingsFromConfig,
} from '../core/config.js';

function fixture() {
  return createSwitchboardConfig({
    registry: { accounts: [
      { id: 'claude-work', provider: 'claude', label: 'Work', home: 'X:\\profiles\\person\\.claude-work' },
      { id: 'codex-personal', provider: 'codex', label: 'Personal', home: 'X:\\profiles\\person\\.codex-personal' },
    ] },
    settings: {
      quotaWatch: 'notify',
      usageSources: { 'claude-work': 'X:\\profiles\\person\\Claude' },
      customApps: [{ label: 'My AI app', appId: 'Vendor.App_abc!App' }],
      appOrder: ['t3code', 'custom:Vendor.App_abc!App'],
      updateRepo: 'owner/switchboard',
      windowBounds: { x: 1, y: 2, width: 600, height: 800 },
      lastAutoSwitchAt: 123,
    },
    mcp: { servers: [{ name: 'internal-docs', url: 'https://mcp.example.test', label: 'Docs' }] },
    activeAccounts: { claude: 'claude-work', codex: 'codex-personal' },
    now: new Date('2026-08-19T12:00:00.000Z'),
  });
}

test('config export is versioned and contains Switchboard data without runtime window state', () => {
  const config = fixture();
  assert.equal(config.format, CONFIG_FORMAT);
  assert.equal(config.version, CONFIG_VERSION);
  assert.equal(config.exportedAt, '2026-08-19T12:00:00.000Z');
  assert.deepEqual(configSummary(config), { accounts: 2, customApps: 1, mcpServers: 1 });
  assert.equal('windowBounds' in config.preferences, false);
  assert.equal('lastAutoSwitchAt' in config.preferences, false);
});

test('an exported config survives a JSON round trip', () => {
  const config = fixture();
  assert.deepEqual(parseSwitchboardConfig(JSON.stringify(config)), config);
});

test('a settings export never contains a lane token', () => {
  // Assembled at runtime so the fixture is a realistic secret without the source-tree
  // ratchet (generic.test.js) seeing the credential prefix in this file.
  const secret = ['sk', 'ant', 'oat01', 'SECRET'].join('-');
  const config = createSwitchboardConfig({
    registry: { accounts: [
      { id: 'claude-work', provider: 'claude', label: 'Work', home: 'X:\\profiles\\person\\.claude-work' },
    ] },
    settings: {
      quotaWatch: 'off',
      usageSources: {},
      customApps: [],
      appOrder: [],
      updateRepo: null,
      lanes: [{ id: 'lane-1', harness: 'claude', provider: 'anthropic', accountId: 'claude-work', billing: 'subscription', capabilities: ['chat'] }],
      laneTokens: { 'lane-1': { token: secret, accountId: 'claude-work', mintedAt: 1 } },
    },
    mcp: { servers: [] },
  });
  const serialized = JSON.stringify(config);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('laneTokens'), false);
});

test('export drops a stale usage source left behind by a removed account', () => {
  const config = createSwitchboardConfig({
    registry: { accounts: [] },
    settings: { quotaWatch: 'off', usageSources: { 'claude-old': 'X:\\profiles\\person\\Claude' }, customApps: [], appOrder: [], updateRepo: null },
    mcp: { servers: [] },
  });
  assert.deepEqual(config.preferences.usageSources, {});
});

test('import settings preserve this machine window placement and reset the watch cooldown', () => {
  const imported = settingsFromConfig(fixture(), {
    windowBounds: { width: 900, height: 700 },
    lastAutoSwitchAt: 999,
    futureSetting: true,
  });
  assert.deepEqual(imported.windowBounds, { width: 900, height: 700 });
  assert.equal(imported.lastAutoSwitchAt, 0);
  assert.equal(imported.futureSetting, true);
  assert.equal(imported.quotaWatch, 'notify');
});

test('import refuses invalid JSON and unrelated files', () => {
  assert.throws(() => parseSwitchboardConfig('{nope'), /not valid JSON/);
  assert.throws(() => parseSwitchboardConfig('{}'), /not a Switchboard config/);
});

test('import refuses unsupported versions', () => {
  const config = fixture();
  config.version = 99;
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(config)), /unsupported Switchboard config version/);
});

test('import validates every account before any caller can save it', () => {
  const config = fixture();
  config.accounts[0].provider = 'unknown';
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(config)), /unknown account provider/);

  const duplicate = fixture();
  duplicate.accounts[1].id = duplicate.accounts[0].id;
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(duplicate)), /duplicate account id/);
});

test('active account and usage-source references must resolve inside the import', () => {
  const active = fixture();
  active.activeAccounts.claude = 'missing';
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(active)), /does not name an imported claude account/);

  const source = fixture();
  source.preferences.usageSources.missing = 'C:\\somewhere';
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(source)), /unknown Claude account/);
});

test('MCP endpoints retain the same safe validation used by the MCP editor', () => {
  const config = fixture();
  config.mcpServers[0].url = 'http://insecure.example.test';
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(config)), /plain https address/);
});

test('the Electron bridge and About panel expose import and export', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const preload = fs.readFileSync(path.join(root, 'src', 'preload.cjs'), 'utf8');
  const ui = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
  assert.match(preload, /configExport:.*sb:configExport/);
  assert.match(preload, /configImport:.*sb:configImport/);
  assert.match(ui, /Backup and restore/);
  assert.match(ui, /sb\.configExport\(\)/);
  assert.match(ui, /sb\.configImport\(\)/);
});

test('the updater writes a recovery config before launching setup', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const updater = main.indexOf("ipcMain.handle('sb:updateRun'");
  const backup = main.indexOf("saveRecoveryConfig('before-upgrade')", updater);
  const launch = main.indexOf("spawn(exe, []", updater);
  assert.ok(backup >= 0, 'the updater creates its recovery backup');
  assert.ok(launch > backup, 'setup launches only after the backup is written');
  assert.match(main.slice(updater, launch), /const backupPath = saveRecoveryConfig\('before-upgrade'\)/);
  const quit = main.indexOf('app.quit()', launch);
  assert.ok(quit > launch, 'app quits after spawning installer so files are unlocked');
});

test('an account color travels with an export and back', () => {
  const config = fixture();
  config.accounts[0].color = '#2563EB';
  const parsed = parseSwitchboardConfig(JSON.stringify(config));
  assert.equal(parsed.accounts[0].color, '#2563eb');
  assert.equal('color' in parsed.accounts[1], false, 'an account without one gains nothing');
});

test('an import with a color that is not hex is refused, like any other bad field', () => {
  const config = fixture();
  config.accounts[0].color = 'url(javascript:alert(1))';
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(config)), /accounts\[0\]\.color/);
});

test('a hand-edited color that does not parse never stops an export, it is just left out', () => {
  const config = createSwitchboardConfig({
    registry: { accounts: [
      { id: 'claude-work', provider: 'claude', label: 'Work', home: 'X:\\profiles\\person\\.claude-work', color: 'red' },
      { id: 'claude-two', provider: 'claude', label: 'Two', home: 'X:\\profiles\\person\\.claude-two', color: '#B225EB' },
    ] },
    settings: { quotaWatch: 'off', usageSources: {}, customApps: [], appOrder: [] },
    mcp: { servers: [] },
  });
  assert.equal('color' in config.accounts[0], false);
  assert.equal(config.accounts[1].color, '#b225eb');
});

test('an imported color that is a number is refused, not read as digits', () => {
  const config = fixture();
  config.accounts[0].color = 123;
  assert.throws(() => parseSwitchboardConfig(JSON.stringify(config)), /accounts\[0\]\.color/);
});
