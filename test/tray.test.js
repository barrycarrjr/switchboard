import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trayModel, trayTooltip, accountNote, whenBack, WATCH_MODES, TOOLTIP_LIMIT } from '../core/tray.js';

/**
 * The tray menu is the part of Switchboard most people see most days, and until the rows
 * were separated from the Electron wiring it was also the only part with nothing behind
 * it that could be checked. It had been changed once since the app was written: one line,
 * adding an About entry, while lanes, MCP, per-account terminals and the apps list all
 * shipped without it noticing.
 */

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);

const FMT = { locale: 'en-GB', timeZone: 'UTC' };

const PROVIDERS = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }];
const ACCOUNTS = [
  { id: 'claude-default', provider: 'claude', label: 'Main Account' },
  { id: 'claude-account-2', provider: 'claude', label: 'Secondary' },
  { id: 'codex-default', provider: 'codex', label: 'Default' },
];

const model = (over = {}) => trayModel({
  providers: PROVIDERS,
  accounts: ACCOUNTS,
  activeIds: { claude: 'claude-account-2', codex: 'codex-default' },
  watchMode: 'auto',
  now: NOW,

  ...over,
});

const labels = (rows) => rows.filter((r) => r.kind !== 'separator').map((r) => r.label);
const kinds = (rows, kind) => rows.filter((r) => r.kind === kind);

test('every registered account gets a row, under its own tool', () => {
  const rows = model();
  const headings = kinds(rows, 'heading').map((r) => r.label);
  assert.ok(headings.includes('Claude Code') && headings.includes('Codex'));
  assert.deepEqual(kinds(rows, 'account').map((r) => r.accountId), ['claude-default', 'claude-account-2', 'codex-default']);
});

test('the account in use is the one ticked, per tool', () => {
  const ticked = kinds(model(), 'account').filter((r) => r.checked).map((r) => r.accountId);
  assert.deepEqual(ticked, ['claude-account-2', 'codex-default'], 'one per tool, and only the active one');
});

test('a tool with no accounts of its own is left out', () => {
  const rows = model({ accounts: ACCOUNTS.filter((a) => a.provider === 'claude') });
  assert.ok(!kinds(rows, 'heading').some((r) => r.label === 'Codex'), 'the window is where you add one');
});

// The complaint that started this: the Accounts window shows six accounts on this
// machine and the tray showed three. The three it dropped hold one sign-in each, so
// there is nothing to switch between, but they are still accounts you have.
test('tools with a single sign-in are listed, as lines rather than choices', () => {
  const rows = model({
    alsoSignedIn: [
      { name: 'Antigravity', who: 'a google account, Google AI Pro', signedIn: true },
      { name: 'Copilot CLI', who: 'someone', signedIn: true },
      { name: 'Junie', who: null, signedIn: true },
      { name: 'Gemini CLI', who: null, signedIn: false },
    ],
  });
  const shown = kinds(rows, 'status').map((r) => r.label);
  assert.deepEqual(shown, [
    'Antigravity, a google account, Google AI Pro',
    'Copilot CLI, someone',
    'Junie, signed in',
    'Gemini CLI, not signed in',
  ]);
  assert.ok(kinds(rows, 'heading').some((r) => r.label === 'Also signed in'));
  assert.ok(shown.every((label) => !kinds(rows, 'account').some((a) => a.label === label)), 'never clickable');
});

test('nothing is said about single-sign-in tools when there are none', () => {
  assert.equal(kinds(model(), 'status').length, 0);
  assert.ok(!kinds(model(), 'heading').some((r) => r.label === 'Also signed in'));
});

// ---- The state word on a row ----

test('an account that is simply ready says nothing extra', () => {
  const fine = { windows: [{ key: 'session', usedPercent: 10 }, { key: 'week', usedPercent: 20 }] };
  assert.equal(accountNote({ signedIn: true }, fine, NOW), null);
  const rows = model({ notes: { 'claude-default': null } });
  assert.ok(kinds(rows, 'account').some((r) => r.label === 'Main Account'), 'the bare label, as before');
});

test('an account that cannot be clicked usefully says why', () => {
  assert.equal(accountNote({ signedIn: false }, null, NOW), 'signed out');
  assert.equal(accountNote({ signedIn: true }, { error: 'rate-limited' }, NOW), 'usage unknown');
  assert.equal(
    accountNote({ signedIn: true }, { windows: [{ key: 'week', usedPercent: 100, resetsAt: NOW + 3 * DAY }] }, NOW, FMT),
    'out until Monday',
  );
  assert.equal(
    accountNote({ signedIn: true }, { windows: [{ key: 'session', usedPercent: 100, resetsAt: NOW + 2 * HOUR }] }, NOW, FMT),
    'out until 14:00',
  );
});

test('an account with no reset time still says it is out', () => {
  const noReset = { sampledAt: NOW - HOUR, stale: true, windows: [{ key: 'week', usedPercent: 100, resetsAt: null }] };
  assert.equal(accountNote({ signedIn: true }, noReset, NOW), 'out of quota');
});

test('the state word is appended to the label, because Windows has no second line', () => {
  const rows = model({ notes: { 'claude-default': 'out until Monday' } });
  const row = kinds(rows, 'account').find((r) => r.accountId === 'claude-default');
  assert.equal(row.label, 'Main Account, out until Monday');
});

test('a reset is named by clock, weekday or date depending on how far off it is', () => {
  assert.equal(whenBack(NOW + 2 * HOUR, NOW, FMT), '14:00');
  assert.equal(whenBack(NOW + 3 * DAY, NOW, FMT), 'Monday');
  assert.match(whenBack(NOW + 30 * DAY, NOW, FMT), /\d/, 'a date, once a weekday would be ambiguous');
});

// ---- Warnings the app knew and the tray used to keep to itself ----

test('a machine with nothing wrong shows no warnings at all', () => {
  assert.equal(kinds(model(), 'warning').length, 0);
});

test('each thing that is wrong gets one row that leads to the right place', () => {
  const rows = model({
    accounts: [],
    overrideBlocking: true,
    strandedProviders: ['Claude Code'],
    update: 'v0.10.4',
  });
  assert.deepEqual(kinds(rows, 'warning').map((r) => [r.label, r.action]), [
    ['No accounts set up yet, open Switchboard', 'open:accounts'],
    ['A sign-in override is blocking switching, open Health', 'open:health'],
    ['Claude Code is pointed at a folder that is not registered', 'open:accounts'],
    ['Update available: v0.10.4', 'open:about'],
  ]);
});

test('warnings come first, so they are read before anything is clicked', () => {
  const rows = model({ update: 'v0.10.4' });
  assert.equal(rows[0].kind, 'warning');
  assert.equal(rows[1].kind, 'separator');
});

// ---- Opening a terminal ----

// This shipped in v0.6.12 and never had a tray entry. It is the only thing here that
// changes nothing machine-wide: the terminal gets the account through its own
// environment, so it is a click rather than a decision.
test('every installed CLI can be opened on each of its accounts', () => {
  const rows = model({
    terminals: [
      { name: 'Claude Code', bin: 'claude', accounts: [{ id: 'claude-default', label: 'Main Account' }, { id: 'claude-account-2', label: 'Secondary' }] },
      { name: 'Codex', bin: 'codex', accounts: [{ id: 'codex-default', label: 'Default' }] },
    ],
  });
  const submenu = kinds(rows, 'submenu')[0];
  assert.equal(submenu.label, 'Open a terminal');
  assert.deepEqual(submenu.items.map((i) => i.label), [
    'Claude Code on Main Account',
    'Claude Code on Secondary',
    'Codex on Default',
  ]);
  assert.deepEqual(submenu.items[0], { kind: 'terminal', label: 'Claude Code on Main Account', bin: 'claude', accountId: 'claude-default' });
});

test('a CLI with no accounts of its own opens on whatever is current', () => {
  const rows = model({ terminals: [{ name: 'Gemini CLI', bin: 'gemini', accounts: [] }] });
  assert.deepEqual(kinds(rows, 'submenu')[0].items, [{ kind: 'terminal', label: 'Gemini CLI', bin: 'gemini', accountId: null }]);
});

test('no installed CLI means no terminal entry rather than an empty one', () => {
  assert.equal(kinds(model({ terminals: [] }), 'submenu').length, 0);
  assert.equal(kinds(model({ terminals: [{ name: 'Ghost', bin: null, accounts: [] }] }), 'submenu').length, 0);
});

// ---- The watch, in the words it uses now ----

test('the current mode is on the parent, so it reads without opening', () => {
  assert.equal(kinds(model({ watchMode: 'auto' }), 'watch')[0].label, 'When an account runs out: Switch automatically');
  assert.equal(kinds(model({ watchMode: 'notify' }), 'watch')[0].label, 'When an account runs out: Tell me');
  assert.equal(kinds(model({ watchMode: 'off' }), 'watch')[0].label, 'When an account runs out: Do nothing');
});

test('the three modes are the three the app already had', () => {
  assert.deepEqual(WATCH_MODES.map(([id]) => id), ['off', 'notify', 'auto'], 'wording changed, behaviour did not');
  const watch = kinds(model({ watchMode: 'notify' }), 'watch')[0];
  assert.deepEqual(watch.modes.filter((m) => m.checked).map((m) => m.id), ['notify']);
});

test('an unrecognised mode falls back to doing nothing', () => {
  assert.equal(kinds(model({ watchMode: 'nonsense' }), 'watch')[0].label, 'When an account runs out: Do nothing');
});

// ---- The rest of the menu ----

test('the menu always ends with the same four entries', () => {
  const rows = model().filter((r) => r.kind !== 'separator');
  assert.deepEqual(labels(rows).slice(-4), ['Run health checks', 'About Switchboard', 'Start with Windows', 'Quit']);
});

test('opening Switchboard lands somewhere predictable', () => {
  const open = model().find((r) => r.label === 'Open Switchboard');
  assert.equal(open.action, 'open:accounts', 'not whichever tab happened to be open last');
});

test('Start with Windows reports the real setting', () => {
  assert.equal(model({ startWithWindows: true }).find((r) => r.kind === 'checkbox').checked, true);
  assert.equal(model({ startWithWindows: false }).find((r) => r.kind === 'checkbox').checked, false);
});

test('no two separators ever sit together, and none opens or closes the menu', () => {
  const rows = model({
    update: 'v0.10.4',
    alsoSignedIn: [{ name: 'Junie', who: null, signedIn: true }],
    terminals: [{ name: 'Codex', bin: 'codex', accounts: [] }],
  });
  assert.notEqual(rows[0].kind, 'separator');
  assert.notEqual(rows[rows.length - 1].kind, 'separator');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(!(rows[i].kind === 'separator' && rows[i - 1].kind === 'separator'), `double separator at ${i}`);
  }
});

test('an empty machine still offers the way out of being empty', () => {
  const rows = model({ accounts: [] });
  assert.equal(kinds(rows, 'account').length, 0);
  assert.equal(kinds(rows, 'heading').length, 0, 'no empty tool headings');
  assert.ok(kinds(rows, 'warning').some((r) => r.action === 'open:accounts'));
  assert.ok(labels(rows).includes('Quit'), 'and the menu still works');
});

// ---- The hover text ----
//
// The complaint that started this: hovering the tray showed which account each tool was
// set to and nothing else, while the menu one click away said one of the Claude accounts
// was out of quota. Two descriptions of the same machine, and the shorter one was the one
// shown without asking.

const tip = (over = {}) => trayTooltip({
  providers: PROVIDERS,
  accounts: ACCOUNTS,
  activeIds: { claude: 'claude-account-2', codex: 'codex-default' },
  ...over,
});

test('the hover names the account each tool is set to', () => {
  assert.equal(tip(), 'Switchboard\nClaude Code: Secondary\nCodex: Default');
});

test('the state of the account in use is said where the account is named', () => {
  const lines = tip({ notes: { 'claude-account-2': 'out until 7:00 PM' } }).split('\n');
  assert.ok(lines.includes('Claude Code: Secondary, out until 7:00 PM'));
});

test('an account you are not on is still mentioned when it needs attention', () => {
  const lines = tip({ notes: { 'claude-default': 'out of quota' } }).split('\n');
  assert.deepEqual(lines, ['Switchboard', 'Claude Code: Secondary', 'Codex: Default', 'Main Account, out of quota']);
});

test('an account that is simply ready adds nothing to the hover', () => {
  assert.equal(tip({ notes: { 'claude-default': null } }), tip());
});

test('what is wrong is said before what is merely worth knowing', () => {
  const lines = tip({ update: 'v0.13.0', notes: { 'claude-default': 'out of quota' } }).split('\n');
  assert.ok(lines.indexOf('Update available: v0.13.0') < lines.indexOf('Main Account, out of quota'));
});

test('the hover never exceeds what Windows will show, and counts what it left out', () => {
  const many = [];
  const providers = [];
  for (let i = 0; i < 8; i++) {
    providers.push({ id: `tool-${i}`, name: `A tool with a long name ${i}` });
    many.push({ id: `acct-${i}`, provider: `tool-${i}`, label: `An account with a long label ${i}` });
  }
  const text = trayTooltip({ providers, accounts: many, activeIds: Object.fromEntries(providers.map((p, i) => [p.id, `acct-${i}`])) });
  assert.ok(text.length <= TOOLTIP_LIMIT, `${text.length} characters is more than Windows shows`);
  assert.match(text.split('\n').at(-1), /^and \d+ more$/);
  // Every line that survived is a whole line: nothing is cut mid-word.
  for (const line of text.split('\n').slice(1, -1)) assert.match(line, /^A tool with a long name \d: An account with a long label \d$/);
});

test('an empty machine says so in the hover too', () => {
  assert.equal(trayTooltip({ providers: PROVIDERS, accounts: [] }), 'Switchboard\nNo accounts set up yet, open Switchboard');
});
