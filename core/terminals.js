import { PROVIDERS } from './accounts.js';
import { samePath } from './paths.js';

/**
 * Every installed CLI, and every account it can open on.
 *
 * The CLIs that keep their sign-in in a config folder (Claude Code, Codex) get one
 * entry per registered account, so a terminal can open on a specific account without
 * changing the machine default for everything else. CLIs that hold a single sign-in
 * per machine get one entry that inherits whatever is current.
 *
 * Pure: hand it detected tools, the account registry, and the active home per
 * provider, and it returns what the panel draws. `terminalChips` folds these into
 * one entry per CLI, which is the shape the panel actually uses.
 */
export function terminalRows({ tools = [], accounts = [], activeHomes = {} } = {}) {
  const rows = [];
  for (const tool of tools) {
    if (!tool.installed || !tool.bin) continue;
    const provider = PROVIDERS[tool.id] ?? null;
    const mine = provider ? accounts.filter((a) => a.provider === provider.id) : [];
    if (!mine.length) {
      rows.push({
        key: tool.id,
        toolId: tool.id,
        bin: tool.bin,
        name: tool.name,
        accountId: null,
        accountLabel: null,
        home: null,
        isDefault: true,
        switchable: provider != null,
      });
      continue;
    }
    for (const account of mine) {
      rows.push({
        key: `${tool.id}:${account.id}`,
        toolId: tool.id,
        bin: tool.bin,
        name: tool.name,
        accountId: account.id,
        accountLabel: account.label,
        home: account.home,
        isDefault: samePath(account.home, activeHomes[provider.id]),
        switchable: true,
      });
    }
  }
  return rows;
}

/**
 * One entry per installed CLI, with its accounts folded in.
 *
 * The panel draws these as small buttons rather than a row each: the button opens the
 * CLI on whichever account is currently the machine default, and the accounts sit
 * behind the arrow next to it. That keeps the section a fixed handful of buttons no
 * matter how many accounts are registered.
 */
export function terminalChips(rows = []) {
  const byTool = new Map();
  for (const row of rows) {
    if (!byTool.has(row.toolId)) {
      byTool.set(row.toolId, {
        toolId: row.toolId,
        bin: row.bin,
        name: row.name,
        switchable: row.switchable,
        accounts: [],
        openAccountId: null,
        openLabel: null,
      });
    }
    const chip = byTool.get(row.toolId);
    if (row.accountId) chip.accounts.push({ id: row.accountId, label: row.accountLabel, home: row.home, isDefault: row.isDefault });
    // The machine default is what the button itself opens; with nothing marked (a
    // provider whose active folder is not registered) the first account stands in.
    if (row.isDefault && chip.openAccountId == null) {
      chip.openAccountId = row.accountId;
      chip.openLabel = row.accountLabel;
    }
  }
  for (const chip of byTool.values()) {
    if (chip.openAccountId == null && chip.accounts.length) {
      chip.openAccountId = chip.accounts[0].id;
      chip.openLabel = chip.accounts[0].label;
    }
  }
  return [...byTool.values()];
}
