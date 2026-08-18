import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalRows, terminalChips } from '../core/terminals.js';

const tools = [
  { id: 'claude', name: 'Claude Code', bin: 'claude', installed: true },
  { id: 'codex', name: 'Codex', bin: 'codex', installed: true },
  { id: 'gemini', name: 'Gemini CLI', bin: 'gemini', installed: false },
  { id: 'copilot', name: 'Copilot CLI', bin: 'copilot', installed: true },
];

const accounts = [
  { id: 'claude-default', provider: 'claude', label: 'Primary', home: 'D:\\homes\\dev\\.claude' },
  { id: 'claude-account-2', provider: 'claude', label: 'account-2', home: 'D:\\homes\\dev\\.claude-account-2' },
  { id: 'codex-default', provider: 'codex', label: 'Default', home: 'D:\\homes\\dev\\.codex' },
];

const activeHomes = { claude: 'D:\\homes\\dev\\.claude-account-2', codex: 'D:\\homes\\dev\\.codex' };

test('every registered account of an installed CLI gets its own row', () => {
  const rows = terminalRows({ tools, accounts, activeHomes });
  const claude = rows.filter((r) => r.toolId === 'claude');
  assert.deepEqual(claude.map((r) => r.accountLabel), ['Primary', 'account-2']);
  assert.deepEqual(claude.map((r) => r.key), ['claude:claude-default', 'claude:claude-account-2']);
  assert.deepEqual(claude.map((r) => r.home), accounts.slice(0, 2).map((a) => a.home));
  assert.ok(claude.every((r) => r.bin === 'claude' && r.switchable));
});

test('the row matching the active home is the one flagged as default', () => {
  const rows = terminalRows({ tools, accounts, activeHomes });
  const flagged = rows.filter((r) => r.isDefault).map((r) => r.key);
  assert.deepEqual(flagged, ['claude:claude-account-2', 'codex:codex-default', 'copilot']);
});

test('a different separator or case still counts as the same folder', () => {
  const rows = terminalRows({
    tools,
    accounts,
    activeHomes: { claude: 'd:/homes/dev/.claude/', codex: 'D:\\homes\\dev\\.codex' },
  });
  assert.equal(rows.find((r) => r.accountId === 'claude-default').isDefault, true);
  assert.equal(rows.find((r) => r.accountId === 'claude-account-2').isDefault, false);
});

test('a CLI that holds one sign-in per machine gets a single row, marked as such', () => {
  const rows = terminalRows({ tools, accounts, activeHomes });
  const copilot = rows.filter((r) => r.toolId === 'copilot');
  assert.equal(copilot.length, 1);
  assert.deepEqual(copilot[0], { key: 'copilot', toolId: 'copilot', bin: 'copilot', name: 'Copilot CLI', accountId: null, accountLabel: null, home: null, isDefault: true, switchable: false });
});

test('a switchable CLI with nothing registered yet still gets a row on the current default', () => {
  const rows = terminalRows({ tools, accounts: [], activeHomes });
  const claude = rows.filter((r) => r.toolId === 'claude');
  assert.equal(claude.length, 1);
  assert.equal(claude[0].accountId, null);
  assert.equal(claude[0].switchable, true, 'the panel can say an account is worth registering');
});

test('CLIs that are not installed, and tools with no binary, are left out', () => {
  const rows = terminalRows({ tools: [...tools, { id: 'ollama', name: 'Ollama', bin: null, installed: true }], accounts, activeHomes });
  assert.equal(rows.some((r) => r.toolId === 'gemini'), false, 'not installed');
  assert.equal(rows.some((r) => r.toolId === 'ollama'), false, 'nothing to run');
  assert.deepEqual(terminalRows({}), []);
});

test('rows keep the tool table order, so the panel is stable between renders', () => {
  const rows = terminalRows({ tools, accounts, activeHomes });
  assert.deepEqual(rows.map((r) => r.key), [
    'claude:claude-default',
    'claude:claude-account-2',
    'codex:codex-default',
    'copilot',
  ]);
});

test('chips fold every account of a CLI into one button', () => {
  const chips = terminalChips(terminalRows({ tools, accounts, activeHomes }));
  assert.deepEqual(chips.map((c) => c.toolId), ['claude', 'codex', 'copilot']);
  const claude = chips[0];
  assert.deepEqual(claude.accounts.map((a) => a.label), ['Primary', 'account-2']);
  assert.equal(claude.openAccountId, 'claude-account-2', 'the button opens the machine default');
  assert.equal(claude.openLabel, 'account-2');
  assert.equal(claude.bin, 'claude');
});

test('a CLI with one sign-in per machine has no accounts to choose between', () => {
  const chips = terminalChips(terminalRows({ tools, accounts, activeHomes }));
  const copilot = chips.find((c) => c.toolId === 'copilot');
  assert.deepEqual(copilot.accounts, []);
  assert.equal(copilot.openAccountId, null, 'nothing to pass: the terminal inherits the machine sign-in');
  assert.equal(copilot.switchable, false);
});

test('when no account matches the active folder, the button still opens a real one', () => {
  const chips = terminalChips(terminalRows({ tools, accounts, activeHomes: { claude: 'D:\\homes\\dev\\.claude-elsewhere' } }));
  const claude = chips.find((c) => c.toolId === 'claude');
  assert.equal(claude.accounts.some((a) => a.isDefault), false);
  assert.equal(claude.openAccountId, 'claude-default', 'falls back to the first registered account');
});

test('chips of an empty list are an empty list', () => {
  assert.deepEqual(terminalChips([]), []);
  assert.deepEqual(terminalChips(), []);
});
