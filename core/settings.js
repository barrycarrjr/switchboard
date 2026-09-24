import fs from 'node:fs';
import path from 'node:path';
import { dataDir, writeJsonAtomic } from './paths.js';

export const WATCH_MODES = ['off', 'notify', 'auto'];

const DEFAULTS = {
  quotaWatch: 'off',          // off | notify | auto
  usageSources: {},           // accountId -> Claude Desktop profile folder
  lastAutoSwitchAt: 0,
  customApps: [],             // [{label, appId}] user-added launchers from the Start menu
  bridges: [],                // [{id, label, match}] background workers watched by command-line text
  updateRepo: null,           // "owner/name" GitHub slug for self-update; local-only by design
  appOrder: [],               // Apps-panel card order, by app id; new apps append until placed
  appProfileDirs: {},         // appId -> extra data folders to offer, beyond the detected ones
  windowBounds: null,         // last window size/position, restored on launch
  lanes: [],                  // ordered pool of lanes [{ id, harness, provider, accountId, billing, capabilities }]
  spendPolicies: {},          // laneId -> { budget }
  cooldowns: {},              // laneId -> epoch ms
  // laneId -> { token, accountId, mintedAt, dead, deadReason, checkedAt }. Deliberately
  // NOT on the lane objects: `switchboard lanes --json` and the tray IPC print
  // settings.lanes verbatim, and a secret filed there would ride along.
  laneTokens: {},
  // The last time Switchboard ran `agy update` on Antigravity's behalf, and what it
  // found: { at, alreadyLatest, version, message }. Switchboard does that job because
  // the CLI doing it for itself puts a command window on screen (core/agy-updates.js).
  agyUpdate: null,
  notifyWebhookUrl: null,     // URL to POST notification events to (e.g. Slack webhook)
  notifyCommand: null,        // Shell command to run on notification events
  thresholds: { session: 80, week: 85 }, // windowKey -> percentage
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
    if (!Array.isArray(merged.bridges)) merged.bridges = [];
    merged.bridges = merged.bridges.filter((b) => b && typeof b.id === 'string' && typeof b.label === 'string' && typeof b.match === 'string');
    if (!Array.isArray(merged.appOrder)) merged.appOrder = [];
    if (typeof merged.appProfileDirs !== 'object' || merged.appProfileDirs === null || Array.isArray(merged.appProfileDirs)) merged.appProfileDirs = {};
    if (!Array.isArray(merged.lanes)) merged.lanes = [];
    if (typeof merged.spendPolicies !== 'object' || merged.spendPolicies === null) merged.spendPolicies = {};
    if (typeof merged.cooldowns !== 'object' || merged.cooldowns === null) merged.cooldowns = {};
    if (typeof merged.laneTokens !== 'object' || merged.laneTokens === null || Array.isArray(merged.laneTokens)) merged.laneTokens = {};
    if (typeof merged.agyUpdate !== 'object' || merged.agyUpdate === null || Array.isArray(merged.agyUpdate)) merged.agyUpdate = null;
    if (typeof merged.notifyWebhookUrl === 'string' && merged.notifyWebhookUrl.trim()) {
      try {
        const u = new URL(merged.notifyWebhookUrl.trim());
        merged.notifyWebhookUrl = (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
      } catch {
        merged.notifyWebhookUrl = null;
      }
    } else {
      merged.notifyWebhookUrl = null;
    }
    if (typeof merged.notifyCommand !== 'string' || !merged.notifyCommand.trim()) {
      merged.notifyCommand = null;
    } else {
      merged.notifyCommand = merged.notifyCommand.trim();
    }
    if (typeof merged.thresholds !== 'object' || merged.thresholds === null || Array.isArray(merged.thresholds)) {
      merged.thresholds = { session: 80, week: 85 };
    } else {
      const clean = {};
      for (const [k, v] of Object.entries(merged.thresholds)) {
        const num = Math.round(Number(v));
        if (!Number.isNaN(num) && num >= 1 && num <= 100) clean[k] = num;
      }
      merged.thresholds = Object.keys(clean).length ? clean : { session: 80, week: 85 };
    }
    const b = merged.windowBounds;
    if (!b || typeof b.width !== 'number' || typeof b.height !== 'number' || b.width < 380 || b.height < 400) {
      merged.windowBounds = null;
    }
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings, file = settingsFile()) {
  writeJsonAtomic(file, settings);
}
