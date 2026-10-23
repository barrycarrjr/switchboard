import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath } from './paths.js';
import { normalizeColor } from './accounts.js';

/**
 * Account colors that T3 Code already has, so the two apps can show an account the same way.
 *
 * T3 Code keeps one "provider instance" per account, each with a config folder and an
 * optional accent color. Switchboard keeps one account per config folder. The folder is
 * the only thing the two have in common, so it is the only thing matched on: a display
 * name is free text in both apps and the same account is often named differently.
 *
 * Only T3 drivers that move a whole sign-in by folder are mapped. An instance with no
 * folder set is skipped rather than assumed to be the vendor default, because T3 then
 * inherits whatever CLAUDE_CONFIG_DIR it was started with, which may be another account.
 */
const T3_DRIVERS = { claudeAgent: 'claude', codex: 'codex' };

export function t3SettingsFile(homeDir = os.homedir()) {
  return path.join(homeDir, '.t3', 'userdata', 'settings.json');
}

/** Every T3 instance that names both a folder and a usable color. Unreadable means none. */
export function readT3Instances(file = t3SettingsFile()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const instances = parsed && typeof parsed.providerInstances === 'object' ? parsed.providerInstances : {};
  const found = [];
  for (const instance of Object.values(instances ?? {})) {
    const provider = T3_DRIVERS[instance?.driver];
    const home = instance?.config?.homePath;
    if (!provider || typeof home !== 'string' || !home.trim()) continue;
    let color;
    try {
      color = normalizeColor(instance.accentColor);
    } catch {
      continue; // a color T3 accepts but hex cannot express is left alone, not guessed at
    }
    if (color) found.push({ provider, home, color, name: instance.displayName ?? null });
  }
  return found;
}

/** The T3 color for each registered account T3 also knows, keyed by account id. */
export function matchT3Colors(registry, instances) {
  const colors = {};
  for (const account of registry.accounts) {
    const match = instances.find((i) => i.provider === account.provider && samePath(i.home, account.home));
    if (match) colors[account.id] = match.color;
  }
  return colors;
}
