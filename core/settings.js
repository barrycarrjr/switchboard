import fs from 'node:fs';
import path from 'node:path';
import { dataDir, writeJsonAtomic } from './paths.js';

export const WATCH_MODES = ['off', 'notify', 'auto'];

const DEFAULTS = {
  quotaWatch: 'off',          // off | notify | auto
  usageSources: {},           // accountId -> Claude Desktop profile folder
  lastAutoSwitchAt: 0,
  customApps: [],             // [{label, appId}] user-added launchers from the Start menu
  updateRepo: null,           // "owner/name" GitHub slug for self-update; local-only by design
};

export function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

export function loadSettings(file = settingsFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = { ...DEFAULTS, ...parsed };
    if (!WATCH_MODES.includes(merged.quotaWatch)) merged.quotaWatch = 'off';
    if (typeof merged.usageSources !== 'object' || merged.usageSources === null) merged.usageSources = {};
    if (!Array.isArray(merged.customApps)) merged.customApps = [];
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings, file = settingsFile()) {
  writeJsonAtomic(file, settings);
}
