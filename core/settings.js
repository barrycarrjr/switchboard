import fs from 'node:fs';
import path from 'node:path';
import { dataDir, writeJsonAtomic } from './paths.js';
import { protectSecret, unprotectSecret, isEncrypted } from './vault.js';
import { normalizeGatewaySettings } from './gateway-keys.js';
import { DEFAULT_BACKUP_FOLDERS, DEFAULT_SHARED_AI_FOLDER, backupFolderSetting } from './shared-folder.js';

export const WATCH_MODES = ['off', 'notify', 'auto'];
export const THEME_MODES = ['system', 'light', 'dark'];

const DEFAULTS = {
  theme: 'system',            // system | light | dark
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
  // Local pass-through gateway listener settings and issued client keys.
  // Like laneTokens, gatewayKeys[id].token is encrypted at rest with core/vault.js and
  // omitted from exported configs.
  gateway: { enabled: false, port: 8318, scope: 'localhost-wsl' },
  gatewayKeys: {},
  // The last time Switchboard ran `agy update` on Antigravity's behalf, and what it
  // found: { at, alreadyLatest, version, message }. Switchboard does that job because
  // the CLI doing it for itself puts a command window on screen (core/agy-updates.js).
  agyUpdate: null,
  notifyWebhookUrl: null,     // URL to POST notification events to (e.g. Slack webhook)
  notifyCommand: null,        // Shell command to run on notification events
  thresholds: { session: 80, week: 85 }, // windowKey -> percentage
  trayHoverFlyout: false,     // Open Tray Quota Flyout on 600ms dwell hover in addition to left-click
  flyoutBounds: null,         // { x, y, width, height } remembered when the user moves or resizes the Usage Monitor
  flyoutPinned: false,        // Keep the Usage Monitor pinned open across focus changes and restarts
  // The folder of rules and skills shared by every AI tool (core/shared-folder.js). Stored
  // with a leading ~ so it never names one user's profile; '' switches it off.
  sharedAiFolder: DEFAULT_SHARED_AI_FOLDER,
  // Top-level folders inside it that a configuration export carries, by name only.
  sharedAiBackupFolders: DEFAULT_BACKUP_FOLDERS,
};

export function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}

function protectTokenMap(map) {
  const out = {};
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === 'object' && v.unreadable && typeof v.sealed === 'string') {
      // Written back exactly as it was read, so a token this process could not open is
      // never lost by a save. See unprotectSettings.
      const { sealed, unreadable, ...rest } = v;
      out[k] = { ...rest, token: sealed };
    } else if (v && typeof v === 'object' && typeof v.token === 'string' && !isEncrypted(v.token)) {
      out[k] = { ...v, token: protectSecret(v.token) };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function unprotectTokenMap(map) {
  for (const [k, v] of Object.entries(map)) {
    if (v && typeof v === 'object' && typeof v.token === 'string' && isEncrypted(v.token)) {
      const plain = unprotectSecret(v.token);
      if (plain == null) {
        // Encrypted in a way this process cannot open: by another scheme, or under a
        // different user name, computer name or home folder (the key is derived from
        // those). The encrypted text is never passed off as the token, which would hand
        // automation garbage and get a good token marked dead by its first check. It is
        // kept aside so a save writes it back unchanged, and Health says to mint again.
        map[k] = { ...v, token: null, sealed: v.token, unreadable: true };
      } else {
        v.token = plain;
      }
    }
  }
}

export function protectSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  const clone = { ...settings };
  if (clone.laneTokens && typeof clone.laneTokens === 'object' && !Array.isArray(clone.laneTokens)) {
    clone.laneTokens = protectTokenMap(clone.laneTokens);
  }
  if (clone.gatewayKeys && typeof clone.gatewayKeys === 'object' && !Array.isArray(clone.gatewayKeys)) {
    clone.gatewayKeys = protectTokenMap(clone.gatewayKeys);
  }
  return clone;
}

export function unprotectSettings(settings) {
  if (!settings || typeof settings !== 'object') return settings;
  if (settings.laneTokens && typeof settings.laneTokens === 'object' && !Array.isArray(settings.laneTokens)) {
    unprotectTokenMap(settings.laneTokens);
  }
  if (settings.gatewayKeys && typeof settings.gatewayKeys === 'object' && !Array.isArray(settings.gatewayKeys)) {
    unprotectTokenMap(settings.gatewayKeys);
  }
  return settings;
}

export function loadSettings(file = settingsFile()) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const merged = { ...DEFAULTS, ...parsed };
    if (!THEME_MODES.includes(merged.theme)) merged.theme = 'system';
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
    if (typeof merged.laneTokens !== 'object' || merged.laneTokens === null || Array.isArray(merged.laneTokens)) {
      merged.laneTokens = {};
    }
    if (typeof merged.gatewayKeys !== 'object' || merged.gatewayKeys === null || Array.isArray(merged.gatewayKeys)) {
      merged.gatewayKeys = {};
    }
    unprotectSettings(merged);
    merged.gateway = normalizeGatewaySettings(merged.gateway);
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
    // "none" is how a hook is cleared. An older version saved the word itself as the
    // command, which then ran through the shell on every alert, so it reads as no command.
    if (typeof merged.notifyCommand !== 'string' || !merged.notifyCommand.trim() || merged.notifyCommand.trim().toLowerCase() === 'none') {
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
    merged.trayHoverFlyout = Boolean(merged.trayHoverFlyout);
    if (typeof merged.sharedAiFolder !== 'string' || /\0/.test(merged.sharedAiFolder)) merged.sharedAiFolder = DEFAULT_SHARED_AI_FOLDER;
    merged.sharedAiBackupFolders = backupFolderSetting(merged);
    const b = merged.windowBounds;
    if (!b || typeof b.width !== 'number' || typeof b.height !== 'number' || b.width < 380 || b.height < 400) {
      merged.windowBounds = null;
    }
    return merged;
  } catch {
    return {
      ...DEFAULTS,
      gateway: { ...DEFAULTS.gateway },
      gatewayKeys: {},
      laneTokens: {},
      thresholds: { ...DEFAULTS.thresholds },
      sharedAiBackupFolders: [...DEFAULT_BACKUP_FOLDERS],
    };
  }
}

export function saveSettings(settings, file = settingsFile()) {
  writeJsonAtomic(file, protectSettings(settings));
}
