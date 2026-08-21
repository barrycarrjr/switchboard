import path from 'node:path';
import { PROVIDERS } from './accounts.js';
import { WATCH_MODES } from './settings.js';
import { assertValidServer } from './mcp.js';

export const CONFIG_FORMAT = 'switchboard-config';
export const CONFIG_VERSION = 1;

const MAX_ACCOUNTS = 500;
const MAX_CUSTOM_APPS = 500;
const MAX_MCP_SERVERS = 500;

function object(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(message);
  return value;
}

function text(value, field, max = 1024) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  if (value.length > max || /[\0\r\n]/.test(value)) throw new Error(`${field} is invalid`);
  return value;
}

function absolutePath(value, field) {
  const clean = text(value, field, 32767);
  if (!path.win32.isAbsolute(clean) && !path.posix.isAbsolute(clean)) {
    throw new Error(`${field} must be an absolute path`);
  }
  return clean;
}

function uniqueStrings(value, field, max = 1000) {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${field} must be a list`);
  const result = value.map((item, i) => text(item, `${field}[${i}]`));
  if (new Set(result).size !== result.length) throw new Error(`${field} contains duplicates`);
  return result;
}

function normalizeAccounts(value) {
  if (!Array.isArray(value) || value.length > MAX_ACCOUNTS) throw new Error('accounts must be a list');
  const ids = new Set();
  const homes = new Set();
  return value.map((raw, i) => {
    const account = object(raw, `accounts[${i}] must be an object`);
    const id = text(account.id, `accounts[${i}].id`, 128);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`accounts[${i}].id is invalid`);
    if (ids.has(id)) throw new Error(`duplicate account id: ${id}`);
    ids.add(id);
    const provider = text(account.provider, `accounts[${i}].provider`, 64);
    if (!PROVIDERS[provider]) throw new Error(`unknown account provider: ${provider}`);
    const label = text(account.label, `accounts[${i}].label`, 200).trim();
    const home = absolutePath(account.home, `accounts[${i}].home`);
    const homeKey = `${provider}:${path.win32.normalize(home).toLowerCase()}`;
    if (homes.has(homeKey)) throw new Error(`duplicate ${provider} account folder: ${home}`);
    homes.add(homeKey);
    return { id, provider, label, home };
  });
}

function normalizeActiveAccounts(value, accounts) {
  const raw = value == null ? {} : object(value, 'activeAccounts must be an object');
  const result = {};
  for (const [provider, id] of Object.entries(raw)) {
    if (!PROVIDERS[provider]) throw new Error(`unknown active account provider: ${provider}`);
    const cleanId = text(id, `activeAccounts.${provider}`, 128);
    if (!accounts.some((a) => a.id === cleanId && a.provider === provider)) {
      throw new Error(`activeAccounts.${provider} does not name an imported ${provider} account`);
    }
    result[provider] = cleanId;
  }
  return result;
}

function normalizePreferences(value, accounts) {
  const raw = object(value, 'preferences must be an object');
  const quotaWatch = WATCH_MODES.includes(raw.quotaWatch) ? raw.quotaWatch : null;
  if (!quotaWatch) throw new Error('preferences.quotaWatch is invalid');

  const sources = object(raw.usageSources, 'preferences.usageSources must be an object');
  const usageSources = {};
  for (const [id, folder] of Object.entries(sources)) {
    if (!accounts.some((a) => a.id === id && a.provider === 'claude')) {
      throw new Error(`usage source refers to an unknown Claude account: ${id}`);
    }
    usageSources[id] = absolutePath(folder, `preferences.usageSources.${id}`);
  }

  if (!Array.isArray(raw.customApps) || raw.customApps.length > MAX_CUSTOM_APPS) {
    throw new Error('preferences.customApps must be a list');
  }
  const customApps = raw.customApps.map((entry, i) => {
    const app = object(entry, `preferences.customApps[${i}] must be an object`);
    return {
      label: text(app.label, `preferences.customApps[${i}].label`, 200).trim(),
      appId: text(app.appId, `preferences.customApps[${i}].appId`, 1024),
    };
  });
  if (new Set(customApps.map((app) => app.appId)).size !== customApps.length) {
    throw new Error('preferences.customApps contains duplicate app ids');
  }

  const appOrder = uniqueStrings(raw.appOrder, 'preferences.appOrder', 1000);

  // Folders added by hand for an app to open on. The app id is checked for shape but
  // not for membership: a file exported by a later version may name an app this one
  // has never heard of, and refusing the whole import over that would be unhelpful.
  const rawProfileDirs = raw.appProfileDirs == null
    ? {}
    : object(raw.appProfileDirs, 'preferences.appProfileDirs must be an object');
  const appProfileDirs = {};
  for (const [appId, dirs] of Object.entries(rawProfileDirs)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(appId)) throw new Error(`preferences.appProfileDirs has an invalid app id: ${appId}`);
    appProfileDirs[appId] = uniqueStrings(dirs, `preferences.appProfileDirs.${appId}`, MAX_CUSTOM_APPS)
      .map((dir, i) => absolutePath(dir, `preferences.appProfileDirs.${appId}[${i}]`));
  }

  const updateRepo = raw.updateRepo == null ? null : text(raw.updateRepo, 'preferences.updateRepo', 200);
  if (updateRepo !== null && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(updateRepo)) {
    throw new Error('preferences.updateRepo must use the owner/name form');
  }
  return { quotaWatch, usageSources, customApps, appOrder, appProfileDirs, updateRepo };
}

function normalizeServers(value) {
  if (!Array.isArray(value) || value.length > MAX_MCP_SERVERS) throw new Error('mcpServers must be a list');
  const names = new Set();
  return value.map((raw, i) => {
    const server = object(raw, `mcpServers[${i}] must be an object`);
    const clean = {
      name: text(server.name, `mcpServers[${i}].name`, 64),
      url: text(server.url, `mcpServers[${i}].url`, 2048),
      label: text(server.label ?? server.name, `mcpServers[${i}].label`, 200).trim(),
    };
    assertValidServer(clean);
    if (names.has(clean.name)) throw new Error(`duplicate MCP server name: ${clean.name}`);
    names.add(clean.name);
    return clean;
  });
}

/** Validate and copy an imported config, discarding fields Switchboard does not own. */
export function normalizeSwitchboardConfig(value) {
  const raw = object(value, 'the selected file is not a Switchboard config');
  if (raw.format !== CONFIG_FORMAT) throw new Error('the selected file is not a Switchboard config');
  if (raw.version !== CONFIG_VERSION) {
    throw new Error(`unsupported Switchboard config version: ${raw.version ?? 'missing'}`);
  }
  const accounts = normalizeAccounts(raw.accounts);
  const exportedAt = text(raw.exportedAt, 'exportedAt', 64);
  if (!Number.isFinite(Date.parse(exportedAt))) throw new Error('exportedAt is not a valid date');
  return {
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt,
    accounts,
    activeAccounts: normalizeActiveAccounts(raw.activeAccounts, accounts),
    preferences: normalizePreferences(raw.preferences, accounts),
    mcpServers: normalizeServers(raw.mcpServers),
  };
}

export function parseSwitchboardConfig(source) {
  let value;
  try {
    value = JSON.parse(String(source).replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('the selected file is not valid JSON');
  }
  return normalizeSwitchboardConfig(value);
}

export function createSwitchboardConfig({ registry, settings, mcp, activeAccounts = {}, now = new Date() }) {
  // An account can be removed after a Desktop usage source was selected. The stale
  // preference is harmless in normal use and should not make a later export fail.
  const accountIds = new Set(registry.accounts.filter((a) => a.provider === 'claude').map((a) => a.id));
  const usageSources = Object.fromEntries(
    Object.entries(settings.usageSources).filter(([id]) => accountIds.has(id)),
  );
  return normalizeSwitchboardConfig({
    format: CONFIG_FORMAT,
    version: CONFIG_VERSION,
    exportedAt: now.toISOString(),
    accounts: registry.accounts,
    activeAccounts,
    preferences: {
      quotaWatch: settings.quotaWatch,
      usageSources,
      customApps: settings.customApps,
      appOrder: settings.appOrder,
      appProfileDirs: settings.appProfileDirs ?? {},
      updateRepo: settings.updateRepo,
    },
    mcpServers: mcp.servers,
  });
}

/** Preserve local window placement; imported files contain only portable preferences. */
export function settingsFromConfig(config, current = {}) {
  const clean = normalizeSwitchboardConfig(config);
  return {
    ...current,
    ...clean.preferences,
    lastAutoSwitchAt: 0,
  };
}

export function configSummary(config) {
  const clean = normalizeSwitchboardConfig(config);
  return {
    accounts: clean.accounts.length,
    customApps: clean.preferences.customApps.length,
    mcpServers: clean.mcpServers.length,
  };
}
