import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification, screen, nativeTheme } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRegistry, saveRegistry, addAccount, createAccount, removeAccount, renameAccount, setAccountColor, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, normalizeHome, accountScopedEnv, configuredClaudeCredentialOverrides, PROVIDERS } from '../core/accounts.js';
import { detectAll, detectInstalled, detectToolById, checkAllUpdates, uninstallCmdFor, installCmdFor, toolExecutable, TOOLS } from '../core/providers.js';
import { runChecks, accountLoginState, verifiedAccountLoginState, claudePlanName, readClaudeRateLimitTier } from '../core/doctor.js';
import { DESKTOP_STALE_MS, heldReadingIsNewer, inheritResetTimes, providerQuota, readClaudeAccountIdentity, readDesktopUsage, fetchAntigravityQuota } from '../core/quota.js';
import { lastSharedQuota, readSharedQuota, shareAntigravityQuota, sharedQuotaKey, writeSharedQuota } from '../core/quota-cache.js';
import { fetchAllProviderStatus } from '../core/provider-status.js';
import { applyFix } from '../core/fixes.js';
import { signinTerminal, laneTokenTerminal } from '../core/signin.js';
import { signOutAccount, signoutSupported } from '../core/signout.js';
import { loadSettings, saveSettings, settingsFile, THEME_MODES } from '../core/settings.js';
// import { registerVaultDriver } from '../core/vault.js';
import { validateLaneTokens, mergeLaneTokenResults } from '../core/lane-tokens.js';
import { maybeUpdateAgy } from '../core/agy-updates.js';
import { detectApps, getStartApps, launchApp, orderApps, antigravityPresence, resolvePackagedExe, APPS } from '../core/apps.js';
import { appProfileDef, chooseOpenProfile, describeProfiles, discoverProfileDirs, profileFolderProblem, profileLaunchArgs } from '../core/appprofiles.js';
import { detectPresence } from '../core/presence.js';
import { appRunning, bridgeProblem, bridgeRunning, candidateBridgeProcesses, listProcesses, renameBridgeProblem } from '../core/running.js';
import { terminalRows, terminalChips } from '../core/terminals.js';
import { matchT3Colors, readT3Instances } from '../core/t3colors.js';
import { checkAppUpdate, downloadUpdate, validRepoSlug } from '../core/updatecheck.js';
import { CLIENTS as MCP_CLIENTS, activeServers, browseServers, resolveServerByName, searchCatalog, categoriesOf, loadServers, saveServers, addServer, removeServer, registerServer, unregisterServer, listRegistered, clientAvailable, registrationMatrix, disableServer, enableServer, syncClientAccountMirrors, listServerTools } from '../core/mcp.js';
import {
  MARKETPLACE_SOURCES,
  customizationsSnapshot,
  loadMarketplaceCatalog,
  searchMarketplace,
  installMarketplaceItem,
  installFromGitHub,
  saveCustomSkill,
  setAgentClientState,
  saveCustomAgent,
  syncGlobalInstructionToClients,
} from '../core/customizations.js';
import {
  AUTOMATION_INTERVAL_PRESETS,
  loadAutomations,
  saveAutomations,
  addAutomation,
  removeAutomation,
  toggleAutomation,
  recordAutomationRun,
} from '../core/automations.js';
import { createRequire } from 'node:module';

// CI stamps updateRepo into the packaged package.json (extraMetadata); the committed
// source carries no repository name. Local settings, when set, win over the stamp.
const pkgMeta = createRequire(import.meta.url)('../package.json');
function effectiveUpdateRepo() {
  return loadSettings().updateRepo ?? pkgMeta.updateRepo ?? null;
}
import { freshNotices, planDefaultSwitches } from '../core/watch.js';
import { accountUseOrder, defaultFollowsLanes, followsLanesNote, ranksByReset, tooFullForDefault } from '../core/lanes.js';
import { addLane, removeLane, reorderLanes, setLaneBudget, resolveAllAccounts } from '../core/lane-admin.js';
import { accountNote, colorDotBitmap, loginStatesFrom, trayFlyoutModel, trayModel, trayTooltip } from '../core/tray.js';
import { readUserEnv, readMachineEnv } from '../core/env.js';
import { dataDir, samePath, writeJsonAtomic } from '../core/paths.js';
import { configSummary, createSwitchboardConfig, keepLocalEnv, parseSwitchboardConfig, settingsFromConfig } from '../core/config.js';
import { checkThresholds, dispatchNotification, buildNotificationPayload, formatNotificationText, loadAlertMemory, saveAlertMemory } from '../core/hooks.js';
import { createGatewayServer, provisionLocalAndWslClient, createSettingsWatcher, syncWslLeaseWrapper } from '../core/gateway.js';
import { createRulesWatcher, loadRulesSources, saveRulesSources, sourcesOutsideSharedFolder, syncRules } from '../core/rules-sync.js';
import { createSkillsWatcher, setSkillState, syncSkills } from '../core/skills-sync.js';
import { activeSharedFolder, activeSharedSkillsFolder, sharedFolderState, withBackupFolders, withSharedFolder } from '../core/shared-folder.js';
import { listRuleVersions, restoreRuleVersion } from '../core/rules-history.js';
import { collectFilesSection, describeSkipped, formatBytes, planFilesImport, restoreFilesSection, sharedSettingFor } from '../core/shared-backup.js';
import { runT3Setup, resolveTargets as resolveT3Targets, currentT3Status, currentLeaseSha, refreshStaleT3Environments, withT3Lock, forgetT3, wslDistrosCached } from '../core/t3env-run.js';
import { createGatewayKey, updateGatewayKey, revokeGatewayKey, normalizeGatewayPort, normalizeGatewayScope, normalizeGatewaySettings } from '../core/gateway-keys.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let flyoutWin = null;
let trayHoverTimer = null;
let tray = null;
let quitting = false;
const gatewayServer = createGatewayServer();
let settingsWatcher = null;

/**
 * The gateway as settings.json now says, applied to the running tray. Called when the
 * file changes on disk: `switchboard gateway enable|disable|scope|port` and `gateway
 * provision-client` write it from a terminal, and until this existed the listener only
 * read it at tray launch, so a change from the CLI waited for a restart. start() is a
 * no-op when the port and bind address already match, so the tray's own saves cost nothing.
 */
let lastAppliedGatewayKey = null;
function applyGatewaySettings() {
  const gw = normalizeGatewaySettings(loadSettings().gateway);
  const nextKey = `${Boolean(gw.enabled)}:${gw.port}:${gw.scope}`;
  const running = gatewayServer.isRunning();
  if (nextKey === lastAppliedGatewayKey && running === Boolean(gw.enabled)) return;
  lastAppliedGatewayKey = nextKey;
  const change = gw.enabled ? gatewayServer.start() : running ? gatewayServer.stop() : null;
  if (!change) return;
  change.then(() => refresh()).catch((err) => console.error('gateway settings change', err));
}

// One instance only: a second launch fronts the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.setAppUserModelId('io.switchboard.app');

// Lane tokens are deliberately NOT encrypted with Electron's safeStorage (Windows DPAPI).
// The command line is plain Node and cannot decrypt what safeStorage writes, so once the
// tray had saved settings, `dry-run --with-token` would have handed automation the
// encrypted text and `switchboard watch` would have marked a good token dead. The tray
// and the CLI must read the same file the same way, so both use core/vault.js's own
// scheme. This block never actually ran: it sat above app.whenReady, and on Windows
// safeStorage reports itself unavailable until the app is ready. Kept, disabled, as the
// way back if the CLI ever gains a way to read DPAPI.
// try {
//   if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
//     registerVaultDriver({
//       id: 'dpapi',
//       encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
//       decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64')),
//     });
//   }
// } catch {}

function registry() {
  return loadRegistry();
}

function currentConfig() {
  const reg = registry();
  const activeAccounts = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const active = activeAccount(reg, provider);
    if (active) activeAccounts[provider] = active.id;
  }
  const settings = loadSettings();
  return createSwitchboardConfig({
    registry: reg,
    settings,
    mcp: loadServers(),
    activeAccounts,
    // The shared AI folder's ticked folders and Switchboard's own skills, as text. Built
    // here for the export and for both recovery copies alike, so undoing an import or an
    // upgrade puts the files back too.
    files: collectFilesSection({ settings, rulesSources: loadRulesSources() }),
  });
}

// Claude's own status command is the authority when credential files contain only
// stale metadata. It performs normal CLI bookkeeping, so cache it and invalidate
// immediately when the credential file itself changes.
const AUTH_TTL_MS = 2 * 60 * 1000;
const authCache = new Map(); // accountId -> { at, stamp, result, pending? }
let claudeExecutablePromise = null;

function accountCacheKey(account) {
  return `${account?.provider ?? ''}:${path.resolve(account?.home ?? '').toLowerCase()}`;
}

function quotaAccountCacheKey(account) {
  return `${accountCacheKey(account)}:${credentialStamp(account)}`;
}

function credentialStamp(account) {
  const def = PROVIDERS[account.provider];
  if (!def) return 'unknown';
  try {
    const stat = fs.statSync(path.join(account.home, def.credFile));
    return `${stat.size}:${stat.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function loginIdentitySignature(login) {
  return JSON.stringify([
    login?.signedIn ?? null,
    login?.authMethod ?? null,
    login?.apiProvider ?? null,
    login?.email ?? null,
    login?.organizationUuid ?? null,
  ]);
}

async function cachedLoginState(account, force = false) {
  if (account.provider !== 'claude') return accountLoginState(account);
  const now = Date.now();
  const stamp = credentialStamp(account);
  const key = accountCacheKey(account);
  let hit = authCache.get(account.id);
  if (hit?.key === key && hit.pending && hit.stamp === stamp) return hit.pending;
  if (!force && hit?.key === key && hit.stamp === stamp && now - hit.at < AUTH_TTL_MS) {
    return hit.result;
  }

  if (!claudeExecutablePromise) claudeExecutablePromise = toolExecutable('claude');
  const executable = await claudeExecutablePromise;
  // Resolving the executable yields to the event loop. Another render/watch may have
  // installed a request while we were waiting, so coalesce again before spawning.
  const latest = authCache.get(account.id);
  if (latest?.key === key && latest.pending && latest.stamp === stamp) return latest.pending;
  if (!force && latest?.key === key && latest.stamp === stamp && Date.now() - latest.at < AUTH_TTL_MS) {
    return latest.result;
  }
  if (latest?.key === key) hit = latest;

  let pending;
  pending = verifiedAccountLoginState(account, { executable: executable ?? 'claude' }).then((result) => {
    const currentStamp = credentialStamp(account);
    const stampedResult = { ...result, credentialRevision: currentStamp };
    const loginChanged = hit?.key === key && hit.result && (
      hit.result.credentialRevision !== currentStamp
      || loginIdentitySignature(hit.result) !== loginIdentitySignature(stampedResult)
    );
    if (stampedResult.signedIn === true && loginChanged) {
      quotaCache.delete(account.id);
      quotaInflight.delete(account.id);
    }
    // A credential change can start a newer probe while this one is finishing. Only
    // the request still registered as current may update the cache.
    const current = authCache.get(account.id);
    if (current?.key === key && current.pending === pending) {
      authCache.set(account.id, { key, at: Date.now(), stamp: currentStamp, result: stampedResult });
    }
    return stampedResult;
  });
  authCache.set(account.id, { key, at: now, stamp, pending });
  return pending;
}

function desktopFallbackIsUnambiguous(account, accounts = registry().accounts) {
  if (account.provider !== 'claude') return true;
  const organizationUuid = readClaudeAccountIdentity(account.home)?.organizationUuid;
  if (!organizationUuid) return false;
  const matches = accounts.filter((candidate) => (
    candidate.provider === 'claude'
    && readClaudeAccountIdentity(candidate.home)?.organizationUuid === organizationUuid
  ));
  return matches.length === 1;
}

/** Write an importable snapshot before an operation that can replace app state/code. */
function saveRecoveryConfig(kind) {
  if (!['before-import', 'before-upgrade'].includes(kind)) throw new Error('unknown recovery backup kind');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = path.join(dataDir(), 'backups', `${kind}-${stamp}.json`);
  writeJsonAtomic(backupPath, currentConfig());
  return backupPath;
}

async function stateSnapshot(forceAuthAccountId = null) {
  const reg = registry();
  const settings = loadSettings();
  // Whether each tool is actually on this machine. Through detectInstalled, which only
  // looks for the executable: asking each tool its version is what makes a full detect
  // take seconds, and the Accounts page has no use for the version.
  const installed = new Set((await detectInstalled()).filter((t) => t.installed).map((t) => t.id));
  const providers = {};
  for (const p of Object.values(PROVIDERS)) {
    // Decided in core and sent with its wording, so the page offers a switch exactly
    // when the tray and the switch itself would allow one. See defaultFollowsLanes.
    const followsLanes = defaultFollowsLanes(settings, p.id);
    const byReset = ranksByReset(settings, p.id, reg.accounts);
    providers[p.id] = {
      id: p.id,
      name: p.name,
      envVar: p.envVar,
      installed: installed.has(p.id),
      activeAccountId: activeAccount(reg, p.id)?.id ?? null,
      followsLanes,
      // Whether "soonest weekly reset first" is true of this tool, so the page words it
      // the way the tray does. See ranksByReset.
      ranksByReset: byReset,
      followsLanesNote: followsLanes ? followsLanesNote(p.name, byReset, Boolean(p.quota)) : null,
      // Filled in below, once each account's sign-in has been read.
      accountOrder: null,
      activeHome: activeHome(p.id),
      hasQuota: Boolean(p.quota),
      quotaNote: p.quotaNote ?? null,
      // Whether the vendor publishes a sign-out command of its own. A card only offers
      // the button for a tool that does; see core/signout.js.
      canSignOut: Boolean(p.logout),
      note: p.note ?? null,
      usageUrl: p.usageUrl ?? null,
    };
  }
  const allAccounts = await resolveAllAccounts(reg);
  // Login state travels with each account so the Accounts page can say why its
  // sign-in link is there, rather than offering it identically in every state.
  const accounts = await Promise.all(reg.accounts.map(async (a) => ({
    ...a,
    login: await cachedLoginState(a, a.id === forceAuthAccountId),
  })));
  const laneAccounts = await Promise.all(allAccounts.map(async (a) => {
    const existing = accounts.find((acc) => acc.id === a.id);
    if (existing) return existing;
    return {
      ...a,
      login: a.login || await cachedLoginState(a, a.id === forceAuthAccountId),
    };
  }));
  // A forced or newly refreshed Accounts-page check is newer than the tray's last
  // five-minute pass. Reconcile the one categorical state here so the hover cannot
  // keep saying "signed out" beside a card that Claude has just verified as signed in.
  const notes = { ...trayFacts.notes };
  let notesChanged = false;
  for (const account of accounts) {
    if (!trayFacts.quotas[account.id] && PROVIDERS[account.provider]?.quota) {
      const q = cachedQuotaIfPresent(account);
      if (q) trayFacts.quotas = { ...trayFacts.quotas, [account.id]: q };
    }
    const snap = trayFacts.quotas[account.id] ?? null;
    if (account.login?.signedIn === false) {
      if (notes[account.id] !== 'signed out') {
        notes[account.id] = 'signed out';
        notesChanged = true;
      }
    } else {
      const nextNote = snap ? accountNote(account.login, snap) : (notes[account.id] === 'signed out' ? null : notes[account.id] ?? null);
      if ((notes[account.id] ?? null) !== nextNote) {
        if (nextNote) notes[account.id] = nextNote;
        else delete notes[account.id];
        notesChanged = true;
      }
    }
  }
  const signedIn = Object.fromEntries(accounts.map((account) => [account.id, account.login?.signedIn ?? null]));
  const signedInChanged = JSON.stringify(signedIn) !== JSON.stringify(trayFacts.signedIn);
  trayFacts.notes = notes;
  trayFacts.signedIn = signedIn;
  if (notesChanged || signedInChanged) {
    refreshTray();
  }
  // The order the page lists a tool's accounts in when the watch picks them: the order
  // they would be used, from the same readings and sign-ins the tray menu is built from,
  // so the two list them the same way. Null when a person is choosing.
  const listOrderContext = { now: Date.now(), quotas: trayFacts.quotas, loginStates: loginStatesFrom(signedIn), cooldowns: settings.cooldowns };
  for (const p of Object.values(providers)) {
    if (!p.followsLanes) continue;
    p.accountOrder = accountUseOrder(reg.accounts, settings.lanes, p.id, listOrderContext, p.activeAccountId).map((a) => a.id);
    // The accounts listed lower for being too close to a limit to take the default, so
    // the page can say why, as the tray menu does. An account the tray already has a note
    // for (out until a time, signed out, usage unknown) is not "nearly out": the tray shows
    // its note instead, and an account at its limit badged "nearly out" contradicted both
    // the tray and its own card.
    p.nearlyOutIds = p.accountOrder.filter((id) => !notes[id] && tooFullForDefault(trayFacts.quotas[id], id === p.activeAccountId));
    p.outIds = p.accountOrder.filter((id) => typeof notes[id] === 'string' && notes[id].startsWith('out'));
    // A metered lane is never ranked by reset, so when the default sits on one, lane order
    // put it there and the page summary must not credit a weekly reset for it.
    p.activeOnMetered = Boolean(p.activeAccountId)
      && !(settings.lanes ?? []).some((l) => l?.harness === p.id && l.accountId === p.activeAccountId && l.billing !== 'metered')
      && (settings.lanes ?? []).some((l) => l?.harness === p.id && l.accountId === p.activeAccountId);
  }
  // What T3 Code would color each account, so the page can offer to match it. Read each
  // time because T3 is changed in T3, and the file is a few kilobytes.
  const t3Colors = matchT3Colors(reg, readT3Instances());
  const themeInfo = currentThemeInfo(settings.theme);
  return {
    accounts,
    laneAccounts,
    providers,
    t3Colors,
    watchMode: settings.quotaWatch,
    theme: themeInfo.theme,
    effectiveTheme: themeInfo.effectiveTheme,
    version: app.getVersion(),
  };
}

function applyThemeSetting(mode) {
  const valid = THEME_MODES.includes(mode) ? mode : 'system';
  try {
    if (nativeTheme.themeSource !== valid) {
      nativeTheme.themeSource = valid;
    }
  } catch { /* ignore if called before ready */ }
  return currentThemeInfo(valid);
}

function currentThemeInfo(mode = loadSettings().theme) {
  const valid = THEME_MODES.includes(mode) ? mode : 'system';
  const effectiveTheme = valid === 'dark' ? 'dark'
    : valid === 'light' ? 'light'
    : (nativeTheme?.shouldUseDarkColors ? 'dark' : 'light');
  return { theme: valid, effectiveTheme };
}

function broadcastTheme() {
  const info = currentThemeInfo();
  if (win && !win.isDestroyed()) win.webContents.send('sb:themeChanged', info);
  if (flyoutWin && !flyoutWin.isDestroyed()) flyoutWin.webContents.send('sb:themeChanged', info);
}

function showWindow(hash = '') {
  if (!win) createWindow();
  if (hash) win.webContents.send('sb:navigate', hash);
  win.show();
  win.focus();
}

function restorableBounds() {
  const saved = loadSettings().windowBounds;
  if (!saved) return {};
  // Restore position only when it still lands on a connected display.
  const visible = typeof saved.x === 'number' && typeof saved.y === 'number'
    && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return saved.x < a.x + a.width - 40 && saved.x + saved.width > a.x + 40
        && saved.y < a.y + a.height - 40 && saved.y >= a.y - 10;
    });
  return visible ? saved : { width: saved.width, height: saved.height };
}

let boundsTimer = null;
function rememberBounds() {
  if (!win || win.isMaximized() || win.isMinimized()) return;
  clearTimeout(boundsTimer);
  boundsTimer = setTimeout(() => {
    if (!win) return;
    const settings = loadSettings();
    settings.windowBounds = win.getBounds();
    saveSettings(settings);
  }, 500);
}

function createWindow() {
  win = new BrowserWindow({
    width: 560,
    height: 800,
    ...restorableBounds(),
    minWidth: 420,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    icon: path.join(here, '..', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: true,
    },
  });
  win.loadFile(path.join(here, 'ui', 'index.html'));
  win.on('resize', rememberBounds);
  win.on('move', rememberBounds);
  // Close hides to the tray; Quit lives in the tray menu.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

const DEFAULT_FLYOUT_WIDTH = 480;
const DEFAULT_FLYOUT_HEIGHT = 650;
const MIN_FLYOUT_WIDTH = 360;
const MIN_FLYOUT_HEIGHT = 380;

let flyoutBoundsTimer = null;
let flyoutProgrammaticResize = false;
let liveFlyoutBounds = null;

function restorableFlyoutBounds() {
  const saved = liveFlyoutBounds ?? loadSettings().flyoutBounds;
  if (!saved || typeof saved !== 'object') {
    return { width: DEFAULT_FLYOUT_WIDTH, height: DEFAULT_FLYOUT_HEIGHT, x: null, y: null, userSized: false, userMoved: false };
  }
  const width = Number.isFinite(Number(saved.width)) ? Math.max(MIN_FLYOUT_WIDTH, Math.round(Number(saved.width))) : DEFAULT_FLYOUT_WIDTH;
  const height = Number.isFinite(Number(saved.height)) ? Math.max(MIN_FLYOUT_HEIGHT, Math.round(Number(saved.height))) : DEFAULT_FLYOUT_HEIGHT;
  const hasPos = typeof saved.x === 'number' && typeof saved.y === 'number' && Number.isFinite(saved.x) && Number.isFinite(saved.y);
  const visible = hasPos && screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return saved.x < a.x + a.width - 40 && saved.x + width > a.x + 40
      && saved.y < a.y + a.height - 40 && saved.y >= a.y - 10;
  });
  return {
    width,
    height,
    x: visible ? Math.round(saved.x) : null,
    y: visible ? Math.round(saved.y) : null,
    userSized: Number.isFinite(Number(saved.width)) && Number.isFinite(Number(saved.height)),
    userMoved: Boolean(visible),
  };
}

function rememberFlyoutBounds() {
  if (!flyoutWin || flyoutWin.isDestroyed() || flyoutProgrammaticResize) return;
  if (flyoutWin.isMaximized() || flyoutWin.isMinimized()) return;
  const cur = flyoutWin.getBounds();
  liveFlyoutBounds = { x: cur.x, y: cur.y, width: cur.width, height: cur.height };
  clearTimeout(flyoutBoundsTimer);
  flyoutBoundsTimer = setTimeout(() => {
    if (!flyoutWin || flyoutWin.isDestroyed() || flyoutWin.isMaximized() || flyoutWin.isMinimized()) return;
    const b = flyoutWin.getBounds();
    liveFlyoutBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    const settings = loadSettings();
    settings.flyoutBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    saveSettings(settings);
  }, 250);
}

function createFlyoutWindow() {
  if (flyoutWin && !flyoutWin.isDestroyed()) return flyoutWin;
  const initial = restorableFlyoutBounds();
  flyoutWin = new BrowserWindow({
    title: 'Usage Monitor',
    width: initial.width,
    height: initial.height,
    ...(initial.userMoved ? { x: initial.x, y: initial.y } : {}),
    minWidth: MIN_FLYOUT_WIDTH,
    minHeight: MIN_FLYOUT_HEIGHT,
    frame: false,
    resizable: true,
    movable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  flyoutWin.loadFile(path.join(here, 'ui', 'usage-monitor.html'));
  flyoutWin.on('resize', rememberFlyoutBounds);
  flyoutWin.on('move', rememberFlyoutBounds);
  flyoutWin.on('maximize', () => {
    if (flyoutWin && !flyoutWin.isDestroyed()) flyoutWin.webContents.send('sb:refresh');
  });
  flyoutWin.on('unmaximize', () => {
    if (flyoutWin && !flyoutWin.isDestroyed()) flyoutWin.webContents.send('sb:refresh');
  });
  flyoutWin.on('blur', () => {
    if (loadSettings().flyoutPinned) return;
    if (flyoutWin && !flyoutWin.isDestroyed()) hideFlyout({ force: true });
  });
  flyoutWin.on('closed', () => { flyoutWin = null; });
  return flyoutWin;
}

function positionFlyoutWindow() {
  if (!flyoutWin || flyoutWin.isDestroyed()) return;
  if (flyoutWin.isMaximized()) return;
  try {
    const saved = restorableFlyoutBounds();
    const curBounds = flyoutWin.getBounds();
    if (saved.userMoved && saved.x != null && saved.y != null) {
      const targetW = saved.userSized ? saved.width : curBounds.width;
      const targetH = saved.userSized ? saved.height : curBounds.height;
      flyoutProgrammaticResize = true;
      flyoutWin.setBounds({ x: saved.x, y: saved.y, width: targetW, height: targetH }, false);
      setTimeout(() => { flyoutProgrammaticResize = false; }, 60);
      return;
    }
    if (!tray) return;
    const trayBounds = tray.getBounds();
    const display = screen.getDisplayMatching(trayBounds);
    const workArea = display.workArea;
    const targetW = Math.min(workArea.width - 16, saved.userSized ? saved.width : curBounds.width);
    const targetH = Math.min(workArea.height - 16, saved.userSized ? saved.height : curBounds.height);
    let x = Math.round(trayBounds.x + trayBounds.width / 2 - targetW / 2);
    let y = Math.round(trayBounds.y - targetH - 8);
    if (y < workArea.y) {
      y = Math.round(trayBounds.y + trayBounds.height + 8);
    }
    x = Math.max(workArea.x + 8, Math.min(x, workArea.x + workArea.width - targetW - 8));
    y = Math.max(workArea.y + 8, Math.min(y, workArea.y + workArea.height - targetH - 8));
    flyoutProgrammaticResize = true;
    flyoutWin.setBounds({ x, y, width: targetW, height: targetH }, false);
    setTimeout(() => { flyoutProgrammaticResize = false; }, 60);
  } catch {
    flyoutProgrammaticResize = false;
  }
}

function showFlyout({ focus = true } = {}) {
  const fw = createFlyoutWindow();
  if (fw.isMinimized()) fw.restore();
  positionFlyoutWindow();
  if (tray) tray.setToolTip('');
  fw.webContents.send('sb:refresh');
  if (focus) {
    fw.show();
    fw.focus();
  } else {
    fw.showInactive();
  }
}

function hideFlyout({ force = false } = {}) {
  if (!force && loadSettings().flyoutPinned) return;
  if (flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isVisible()) {
    flyoutWin.hide();
  }
  refreshTray();
}

function toggleFlyout() {
  if (flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isVisible()) {
    if (loadSettings().flyoutPinned) {
      flyoutWin.focus();
    } else {
      hideFlyout({ force: true });
    }
  } else {
    showFlyout({ focus: true });
  }
}

/**
 * What the tray shows that cannot be read without waiting.
 *
 * Building a menu is synchronous, and finding the installed CLIs or reading a sign-in
 * means spawning processes, so the menu reads this and never fetches. It is refreshed at
 * startup and at the end of every quota-watch pass, which is also when the account
 * readings it reports were taken.
 */
let antigravityQuotaCache = { at: 0, result: null };
let antigravityQuotaInflight = null;

async function getAntigravityQuota(force = false) {
  const now = Date.now();
  if (!force && antigravityQuotaCache.result && (now - antigravityQuotaCache.at < 90 * 1000)) {
    return antigravityQuotaCache.result;
  }
  if (antigravityQuotaInflight) return antigravityQuotaInflight;

  antigravityQuotaInflight = (async () => {
    try {
      const res = await fetchAntigravityQuota({ now });
      if (!res.error) {
        const completedAt = Date.now();
        antigravityQuotaCache = { at: completedAt, result: res };
        // Shared the way the Claude and Codex readings are, so `dry-run` and `status`
        // find it instead of starting agy themselves. See shareAntigravityQuota.
        shareAntigravityQuota(res, completedAt);
      }
      return res;
    } finally {
      antigravityQuotaInflight = null;
    }
  })();
  return antigravityQuotaInflight;
}

// installedProviders starts null, meaning "not yet detected": the menu shows every
// provider until the first detect lands, rather than briefly hiding tools that are there.
let trayFacts = {
  terminals: [], alsoSignedIn: [], notes: {}, quotas: {}, signedIn: {}, update: null, installedProviders: null, antigravityQuota: null,
};

async function refreshTrayFacts() {
  if (factsInFlight) return;
  factsInFlight = true;
  try {
    const reg = registry();
    factsSignature = accountSignature();
    const activeHomes = {};
    for (const id of Object.keys(PROVIDERS)) activeHomes[id] = activeHome(id);
    const [tools, presence, antigravity] = await Promise.all([
      detectInstalled(),
      detectPresence(),
      antigravityPresence(),
    ]);
    trayFacts.terminals = terminalChips(terminalRows({ tools, accounts: reg.accounts, activeHomes }));
    // Tools that hold one sign-in for the whole machine. There is nothing to pick
    // between, so these are shown as lines to read rather than things to click.
    const rows = presence.map((t) => ({ name: t.name, who: t.who, signedIn: t.signedIn }));
    if (antigravity.cliInstalled || antigravity.appInstalled || antigravity.signedIn) {
      rows.unshift({
        name: 'Antigravity',
        who: antigravity.who && antigravity.plan ? `${antigravity.who}, ${antigravity.plan}` : (antigravity.who ?? antigravity.plan),
        signedIn: antigravity.signedIn,
      });
      if (antigravity.signedIn) {
        try {
          trayFacts.antigravityQuota = await getAntigravityQuota(false);
        } catch (_) {}
      }
    }
    trayFacts.alsoSignedIn = rows;
    // The menu offers accounts to switch between, and an account for a tool this machine
    // does not have cannot be switched to. Same rule the Accounts page uses, from the
    // same detection, so the two can never disagree about what is here.
    trayFacts.installedProviders = new Set(tools.filter((t) => t.installed).map((t) => t.id));
  } catch (e) {
    console.error('refreshTrayFacts error', e);
  } finally {
    factsInFlight = false;
  }
  refresh();
}

/**
 * Everything the tray knows, gathered once. The menu and the hover text are both built
 * from this, so the two can never end up describing different machines.
 */
function trayInputs() {
  const reg = registry();
  const settings = loadSettings();
  const activeIds = {};
  const stranded = [];
  for (const p of Object.values(PROVIDERS)) {
    const active = activeAccount(reg, p.id);
    if (active) activeIds[p.id] = active.id;
    // A folder that is active but registered nowhere leaves every radio unticked, which
    // used to read as "nothing is set" rather than "something is set that I do not know".
    else if (reg.accounts.some((a) => a.provider === p.id) && activeHome(p.id)) stranded.push(p.name);
  }
  const installed = trayFacts.installedProviders;
  return {
    providers: Object.values(PROVIDERS).filter((p) => !installed || installed.has(p.id)),
    accounts: reg.accounts,
    activeIds,
    notes: trayFacts.notes,
    quotas: trayFacts.quotas,
    signedIn: trayFacts.signedIn,
    alsoSignedIn: trayFacts.alsoSignedIn,
    antigravityQuota: trayFacts.antigravityQuota,
    terminals: trayFacts.terminals,
    watchMode: settings.quotaWatch,
    lanes: settings.lanes,
    cooldowns: settings.cooldowns,
    overrideBlocking: configuredClaudeOverrides().length > 0,
    strandedProviders: stranded,
    update: trayFacts.update,
    startWithWindows: app.getLoginItemSettings().openAtLogin,
  };
}

// One swatch image per color, made once: the menu is rebuilt often and the pixels never
// change. keepSpace stands in a clear image for an account with no color; see colorDotBitmap.
const swatches = new Map();
function swatch(color, keepSpace = false) {
  const key = color || (keepSpace ? 'clear' : null);
  if (!key) return undefined;
  if (!swatches.has(key)) {
    const dot = colorDotBitmap(color, 16, { keepSpace });
    swatches.set(key, dot ? nativeImage.createFromBitmap(dot.buffer, { width: dot.width, height: dot.height }) : undefined);
  }
  return swatches.get(key);
}

/**
 * The tray menu: `core/tray.js` decides what it says, this turns each row into a menu
 * item and attaches what it does.
 */
function buildTrayMenu(inputs = trayInputs()) {
  const rows = trayModel(inputs);
  // A tool's accounts line up only if they all have an icon or none do, so once one of
  // them has a color the rest of that tool's rows keep the space for one.
  const coloredTools = new Set(rows.filter((r) => r.kind === 'account' && r.color).map((r) => r.provider));

  const open = (action) => showWindow(action.slice('open:'.length));
  const items = rows.map((row) => {
    switch (row.kind) {
      case 'separator':
        return { type: 'separator' };
      case 'heading':
      case 'status':
        return { label: row.label, enabled: false };
      case 'account':
        return {
          label: row.label,
          type: 'radio',
          checked: row.checked,
          enabled: row.enabled !== false,
          icon: swatch(row.color, coloredTools.has(row.provider)),
          click: () => switchDefaultTo(row.accountId),
        };
      case 'submenu': {
        const keepSpace = row.items.some((item) => item.color);
        return {
          label: row.label,
          submenu: row.items.map((item) => ({
            label: item.label,
            icon: swatch(item.color, keepSpace),
            click: () => openTerminal(item.bin, item.accountId),
          })),
        };
      }
      case 'watch':
        return {
          label: row.label,
          submenu: [
            ...row.modes.map((m) => ({ label: m.label, type: 'radio', checked: m.checked, click: () => setWatchMode(m.id) })),
            { type: 'separator' },
            { label: 'Set up lanes...', click: () => showWindow('lanes') },
          ],
        };
      case 'checkbox':
        return {
          label: row.label,
          type: 'checkbox',
          checked: row.checked,
          click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
        };
      default:
        return {
          label: row.label,
          click: row.action === 'quit'
            ? () => { quitting = true; app.quit(); }
            : row.action === 'open:flyout'
              ? () => showFlyout({ focus: true })
              : () => open(row.action),
        };
    }
  });
  return Menu.buildFromTemplate(items);
}

/**
 * Why an account may not be made the default by hand right now, or null. The tray rows
 * and the Accounts page stop offering the switch in this state, but a menu or a card
 * drawn before the lanes or the watch setting changed can still ask, and a switch the
 * watch undoes within minutes is worse than a refusal that says where the choice lives.
 */
function manualSwitchRefusal(account) {
  const settings = loadSettings();
  if (!account || !defaultFollowsLanes(settings, account.provider)) return null;
  return followsLanesNote(PROVIDERS[account.provider]?.name ?? account.provider, ranksByReset(settings, account.provider, registry().accounts), Boolean(PROVIDERS[account.provider]?.quota));
}

/**
 * A tray click must never take the app down, so a failure is shown rather than thrown.
 *
 * The registry is read here rather than trusted from when the menu was built: it may have
 * been rebuilt, or changed from the CLI, in between. And Electron moves the tick when the
 * item is clicked, before this runs, so a failure has to put the menu back or it is left
 * asserting a default that was never set.
 */
function switchDefaultTo(accountId) {
  try {
    const reg = registry();
    const refusal = manualSwitchRefusal(reg.accounts.find((a) => a.id === accountId));
    if (refusal) throw new Error(refusal);
    setActive(reg, accountId);
    refresh();
    runQuotaWatch();
  } catch (e) {
    refresh();
    dialog.showErrorBox('Switch failed', String(e.message || e));
  }
}

function openTerminal(bin, accountId) {
  try {
    openTerminalOn(bin, accountId);
  } catch (e) {
    dialog.showErrorBox('Could not open a terminal', String(e.message || e));
  }
}

let factsSignature = null;
let factsInFlight = false;

/** Which accounts exist, cheaply, so a change to them can be noticed. */
function accountSignature() {
  // The label and color are in it because the tray's terminal list shows both, so a
  // rename or a new color has to rebuild that list as surely as an added account does.
  return registry().accounts.map((a) => `${a.id}:${a.home}:${a.label}:${a.color ?? ''}`).sort().join('|');
}

let refreshTrayTimer = null;
function refreshTray() {
  if (tray) {
    if (refreshTrayTimer) clearTimeout(refreshTrayTimer);
    refreshTrayTimer = setTimeout(() => {
      refreshTrayTimer = null;
      if (!tray) return;
      const inputs = trayInputs();
      tray.setContextMenu(buildTrayMenu(inputs));
      const flyoutOpen = Boolean(flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isVisible());
      tray.setToolTip(loadSettings().trayHoverFlyout || flyoutOpen ? '' : trayTooltip(inputs));
      if (flyoutOpen) {
        flyoutWin.webContents.send('sb:refresh');
      }
    }, 40);
  }
}

function refresh() {
  refreshTray();
  if (win && !win.isDestroyed()) win.webContents.send('sb:refresh');
  if (flyoutWin && !flyoutWin.isDestroyed()) flyoutWin.webContents.send('sb:refresh');
  // The terminal list and the sign-in lines are built from the accounts, so an account
  // added or removed anywhere in the app leaves them wrong. Noticing here covers every
  // path without each one having to remember. refreshTrayFacts ends by calling back into
  // refresh, and by then the signature matches, so this does not loop.
  if (!factsInFlight && accountSignature() !== factsSignature) refreshTrayFacts();
}

function setWatchMode(mode) {
  const settings = loadSettings();
  settings.quotaWatch = mode;
  saveSettings(settings);
  // Choosing a mode again is asking to be told again. Threshold alerts are not part of
  // that: they are said once per reset period whatever the watch is set to.
  saveAlertMemory('tray', { ...loadAlertMemory().tray, notices: {} });
  refresh();
  if (mode !== 'off') runQuotaWatch();
}

let pinNotified = false;
// What the watch has already said (an unchanged suggestion, "no account has room", a
// threshold alert) is kept on disk, one record for the desktop and one for the hooks,
// the second shared with `switchboard watch`. See loadAlertMemory and freshNotices.

function configuredClaudeOverrides() {
  return configuredClaudeCredentialOverrides({
    user: readUserEnv,
    machine: readMachineEnv,
    processEnv: process.env,
  });
}

/**
 * The quota watch. Reads every registered Claude account's usage, and when the
 * ACTIVE one is spent, suggests (or performs) a switch of the machine default for
 * new processes. Running processes are never touched; unknown quota is never acted on.
 */
async function runQuotaWatch() {
  try {
    const settings = loadSettings();

    // Lane tokens are checked on every tray pass, BEFORE the quota-watch mode gate:
    // 'off' is the shipped default, and a machine that never turns the watch on still
    // deserves to learn its token was revoked. Without this, dry-run would keep
    // handing a dead token to automation, which then auth-fails instead of reverting
    // to folder mode. Same merge discipline as the CLI watch: the pass's snapshot is
    // folded into freshly loaded settings one checked lane at a time, so a mint,
    // removal or dead-mark that landed mid-pass wins. Costs nothing for a machine
    // with no tokens stored; with one, the freshness window keeps this to about one
    // small Claude run per token per hour rather than one per pass.
    const tokenCheck = await validateLaneTokens(settings, { now: Date.now(), maxAgeMs: 60 * 60 * 1000 });
    if (tokenCheck.changed) {
      const before = loadSettings();
      const merged = mergeLaneTokenResults(before, tokenCheck);
      saveSettings(merged);
      // A death is actionable the way every other watch decision is, so it gets the
      // same active notification, not just a Health-tab entry someone has to open.
      // Decided from the MERGED truth, not this pass's raw outcomes: a re-mint that
      // landed mid-pass wins the merge, and its death notice would be false; and a
      // death another overlapping pass already saved was already announced. Lane and
      // label only; the value itself never appears. The tray is only rebuilt on a
      // death, since a mere checkedAt stamp changes nothing visible.
      const deaths = tokenCheck.results.filter((r) => r.outcome === 'dead'
        && merged.laneTokens?.[r.laneId]?.dead
        && !before.laneTokens?.[r.laneId]?.dead);
      if (deaths.length) refresh();
      for (const r of deaths) {
        const accountId = merged.laneTokens?.[r.laneId]?.accountId;
        const label = registry().accounts.find((a) => a.id === accountId)?.label ?? r.laneId;
        new Notification({
          title: 'Switchboard: lane token needs re-minting',
          body: `The token for ${label} was revoked or expired; automation reverted to the folder sign-in. Click here, then Get new token on the Health page (or run: switchboard lane-token ${r.laneId}).`,
        }).on('click', () => showWindow('health')).show();
      }
    }

    // Antigravity's CLI no longer updates itself while Switchboard is running, because
    // doing so put a command window on screen several times an hour (core/agy-updates.js
    // explains the measurement). Switchboard does that job here instead, at most once a
    // day, quietly. Settings are re-read before the write for the same reason the lane
    // token merge above re-reads them: another pass may have saved in the meantime.
    try {
      const agyBin = await toolExecutable('antigravity');
      const agyState = await maybeUpdateAgy({ bin: agyBin, state: settings.agyUpdate });
      if (agyState) saveSettings({ ...loadSettings(), agyUpdate: agyState });
    } catch { /* an update that cannot run is not worth failing a watch pass over */ }

    const reg = registry();

    // The hover is useful even when automatic switching is off, but it must not create
    // background vendor traffic of its own. Read every sign-in so a stale warning cannot
    // survive a newer Accounts-page check. Reuse only in-memory or shared readings for
    // every account unless the enabled watch already needs a live quota check.
    const snapshots = {};
    const loginStates = {};
    const activeIds = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, activeAccount(reg, id)?.id ?? null]));
    const liveQuotaAccountIds = new Set();
    const flyoutOpen = Boolean(flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isVisible());
    if (settings.quotaWatch !== 'off' || settings.notifyWebhookUrl || settings.notifyCommand || settings.flyoutPinned || flyoutOpen) {
      const watchProviders = new Set(['claude']);
      if (settings.flyoutPinned || flyoutOpen) {
        Object.keys(PROVIDERS).forEach((pid) => { if (PROVIDERS[pid]?.quota) watchProviders.add(pid); });
      }
      settings.lanes.forEach((lane) => watchProviders.add(lane.harness));
      for (const account of reg.accounts) {
        if (watchProviders.has(account.provider)) liveQuotaAccountIds.add(account.id);
      }
    }

    await Promise.all(reg.accounts.map(async (a) => {
      const reads = [cachedLoginState(a)];
      if (PROVIDERS[a.provider]?.quota) {
        if (liveQuotaAccountIds.has(a.id)) reads.push(cachedQuota(a));
        else reads.push(Promise.resolve(cachedQuotaIfPresent(a)));
      }
      const [, snapshot] = await Promise.all(reads);
      // The Accounts page may have forced a newer verification while quota was in
      // flight. Re-read the cheap cache so an older result cannot win that race and
      // put "signed out" back into the tray after the page just cleared it.
      loginStates[a.id] = await cachedLoginState(a);
      if (snapshot) snapshots[a.id] = snapshot;
    }));

    // The tray has just read sign-in and usage for these accounts; the menu and hover
    // say what they mean without doing asynchronous work of their own.
    const notes = {};
    for (const a of reg.accounts) {
      const login = loginStates[a.id];
      const snapshot = snapshots[a.id];
      if (login?.signedIn === false || snapshot) {
        const note = accountNote(login, snapshot);
        if (note) notes[a.id] = note;
      }
    }
    trayFacts.notes = notes;
    trayFacts.quotas = snapshots;
    trayFacts.signedIn = Object.fromEntries(reg.accounts.map((a) => [a.id, loginStates[a.id]?.signedIn ?? null]));
    if (trayFacts.alsoSignedIn.some((t) => t.name === 'Antigravity' && t.signedIn)) {
      try {
        trayFacts.antigravityQuota = await getAntigravityQuota(false);
      } catch (_) {}
    }
    refreshTray();

    // Judged twice, once per audience: the desktop and the hooks each hear an alert once,
    // and a terminal watch that already told the hooks does not silence the desktop.
    // See loadAlertMemory.
    const told = loadAlertMemory();
    const thresholdCheck = (memory) => checkThresholds({
      accounts: reg.accounts,
      snapshots,
      thresholds: settings.thresholds,
      memory,
      now: Date.now(),
    });
    const forDesk = thresholdCheck(told.tray.thresholds);
    const forHooks = thresholdCheck(told.hooks.thresholds);
    saveAlertMemory('tray', { ...told.tray, thresholds: forDesk.memory });
    saveAlertMemory('hooks', { ...told.hooks, thresholds: forHooks.memory });

    for (const ev of forDesk.events) {
      new Notification({ title: 'Switchboard quota alert', body: formatNotificationText(ev) }).show();
    }
    for (const ev of forHooks.events) {
      dispatchNotification(settings, buildNotificationPayload(ev));
    }

    if (settings.quotaWatch === 'off') return;

    const pinPresent = configuredClaudeOverrides().length > 0;

    // The decision itself is in core, so `switchboard watch` on a machine with no
    // desktop takes exactly the same one. Only the rendering below is the app's.
    const switchDecisions = planDefaultSwitches({
      settings,
      registry: reg,
      snapshots,
      loginStates,
      pinPresent,
      now: Date.now(),
    });

    const toldNow = loadAlertMemory();
    const { notices, memory } = freshNotices(switchDecisions, toldNow.tray.notices, activeIds);
    const { notices: hookNotices, memory: hookMemory } = freshNotices(switchDecisions, toldNow.hooks.notices, activeIds);
    saveAlertMemory('tray', { ...toldNow.tray, notices: memory });
    saveAlertMemory('hooks', { ...toldNow.hooks, notices: hookMemory });

    // "No account has room" goes to the hooks once for each time it happens, whether or
    // not the desktop already showed it.
    for (const decision of switchDecisions) {
      if (decision.kind === 'exhausted' && hookNotices.includes(decision)) {
        dispatchNotification(settings, buildNotificationPayload({ kind: 'exhausted', event: 'quota_exhausted', provider: decision.provider, resetsAt: decision.resetsAt }));
      }
    }

    for (const decision of switchDecisions) {
      if ((decision.kind === 'exhausted' || decision.kind === 'suggest') && !notices.includes(decision)) continue;
      if (decision.kind === 'pin-blocked') {
        if (!pinNotified) {
          pinNotified = true;
          new Notification({ title: 'Switchboard', body: `The default ${decision.provider} account ${decision.spent ? 'is out of quota' : 'is nearly out of quota'}, but a machine-wide authentication override makes folder switching unreliable. Open Health to inspect it.` })
            .on('click', () => showWindow('health')).show();
        }
        continue;
      }
      if (decision.kind === 'exhausted') {
        const when = decision.resetsAt ? ` Earliest reset: ${new Date(decision.resetsAt).toLocaleString()}.` : '';
        new Notification({ title: 'Switchboard', body: `No signed-in ${decision.provider} account with readable quota has room.${when}` }).show();
        continue;
      }
      if (decision.kind === 'switch') {
        const target = reg.accounts.find((a) => a.id === decision.to);
        const login = target ? await cachedLoginState(target, true) : null;
        if (login?.signedIn !== true) {
          new Notification({ title: 'Switchboard did not switch', body: `The suggested ${decision.provider} account is no longer signed in.` }).show();
          continue;
        }
        setActive(reg, decision.to);
        // Re-read at the save point: this pass's settings snapshot predates a network
        // window (quota and login fetches above), and saving it back wholesale would
        // silently revert a lane-token mint, removal, or dead-mark that landed in the
        // meantime. The pass writes only the one field it owns.
        saveSettings({ ...loadSettings(), lastAutoSwitchAt: Date.now() });
        refresh();
        new Notification({ title: 'Switchboard switched the default', body: `${decision.reason}. New terminals and apps now use it; running processes are unchanged.` }).show();
        dispatchNotification(settings, buildNotificationPayload({ kind: 'switch', event: 'default_switched', provider: decision.provider, to: decision.to, reason: decision.reason }));
        continue;
      }
      if (decision.kind === 'suggest') {
        const target = reg.accounts.find((a) => a.id === decision.to);
        new Notification({ title: 'Switchboard', body: `${decision.reason}. Click to switch new terminals to ${target?.label}.` })
          .on('click', async () => {
            const fresh = registry();
            const freshTarget = fresh.accounts.find((a) => a.id === decision.to);
            const login = freshTarget ? await cachedLoginState(freshTarget, true) : null;
            if (login?.signedIn !== true) {
              new Notification({ title: 'Switchboard did not switch', body: `That ${decision.provider} account is no longer signed in.` }).show();
              return;
            }
            setActive(fresh, decision.to);
            const s = loadSettings();
            s.lastAutoSwitchAt = Date.now();
            saveSettings(s);
            refresh();
          })
          .show();
      }
    }

  } catch (err) {
    /* the watch must never take the app down; it tries again next tick */
    console.error('runQuotaWatch error', err);
  }
}

app.whenReady().then(async () => {
  // First run: register vendor folders that already exist, generically labeled. Only for
  // tools this machine actually has: registering a folder for a missing tool produced an
  // account nobody asked for, which then outlived the tool and kept an empty section and
  // a dead tray row alive. Detection is cheap here (no tool is asked its version).
  const reg = registry();
  const installedIds = new Set((await detectInstalled()).filter((t) => t.installed).map((t) => t.id));
  const found = detectDefaults(reg, undefined, { isInstalled: (id) => installedIds.has(id) });
  if (found.length) {
    for (const f of found) addAccount(reg, f);
    saveRegistry(reg);
  }

  const trayIcon = nativeImage.createFromPath(path.join(here, '..', 'assets', 'tray.png'));
  tray = new Tray(trayIcon);
  const startupTray = trayInputs();
  tray.setContextMenu(buildTrayMenu(startupTray));
  tray.setToolTip(loadSettings().trayHoverFlyout ? '' : trayTooltip(startupTray));
  // Option C: left-click toggles the read-only Quota Flyout; double-click opens the main
  // Switchboard window; optional 600ms dwell hover opens the flyout when enabled in Settings.
  tray.on('click', () => {
    if (trayHoverTimer) { clearTimeout(trayHoverTimer); trayHoverTimer = null; }
    toggleFlyout();
  });
  tray.on('double-click', () => {
    if (trayHoverTimer) { clearTimeout(trayHoverTimer); trayHoverTimer = null; }
    hideFlyout();
    showWindow();
  });
  tray.on('mouse-enter', () => {
    if (!loadSettings().trayHoverFlyout) return;
    if (tray) tray.setToolTip('');
    if (trayHoverTimer) clearTimeout(trayHoverTimer);
    trayHoverTimer = setTimeout(() => {
      trayHoverTimer = null;
      showFlyout({ focus: false });
    }, 600);
  });
  tray.on('mouse-leave', () => {
    if (trayHoverTimer) { clearTimeout(trayHoverTimer); trayHoverTimer = null; }
  });

  applyThemeSetting(loadSettings().theme);
  nativeTheme.on('updated', () => {
    broadcastTheme();
  });

  createWindow();
  if (loadSettings().flyoutPinned) {
    showFlyout({ focus: false });
  }

  if (loadSettings().gateway?.enabled) {
    gatewayServer.start().catch((err) => {
      console.error('gateway startup error', err);
    });
    // The wrapper inside each WSL distro follows this version of the app; a copy that
    // already matches is left alone, and so is a symlink (a developer's link into a checkout).
    if (process.platform === 'win32') {
      syncWslLeaseWrapper({ leaseScriptPath: path.join(here, '..', 'bin', 'switchboard-lease') }).catch(() => {});
    }
    // A T3 environment on another machine (or a distro) set up by an older Switchboard gets
    // this version's wrapper files the same way, in the background. Only one whose wrapper
    // is out of date is touched, and only its wrapper files: no key is issued (a revoked
    // one stays revoked) and T3's settings there are not written. A machine that is off or
    // would ask for a password (ssh runs with BatchMode) keeps its last record; Health shows
    // the failed attempt beside it.
    refreshStaleT3Environments().catch(() => {});
  }
  settingsWatcher = createSettingsWatcher({ file: settingsFile(), onChange: applyGatewaySettings });

  // Rules from one source: build every tool's instruction file now, again the moment a
  // source file is saved, and on a slow timer in case a folder cannot be watched. Files
  // already in step are not rewritten, so the timer costs a few small reads.
  // Skills kept in the shared AI folder follow the same pattern (core/skills-sync.js).
  startRulesSync([...installedIds]);
  runSkillsSync([...installedIds]);
  setInterval(async () => {
    // Asked fresh each time, so a tool installed since startup is included.
    const ids = await installedCustomizationToolIds().catch(() => [...installedIds]);
    runRulesSync(ids);
    runSkillsSync(ids);
  }, 10 * 60 * 1000);

  refreshTrayFacts();

  // Quota watch: first pass shortly after startup, then every five minutes. Each pass
  // ends by refreshing the menu, which is what keeps the account notes current.
  setTimeout(runQuotaWatch, 20 * 1000);
  setInterval(runQuotaWatch, 5 * 60 * 1000);

  // Update check: shortly after startup, then twice a day. Renderer shows the button.
  const updateCheck = async () => {
    try {
      const r = await checkAppUpdate({ repo: effectiveUpdateRepo(), currentVersion: app.getVersion() });
      trayFacts.update = r.available ? r.tag : null;
      refresh();
      if (r.available) win?.webContents.send('sb:updateAvailable', { tag: r.tag, assetUrl: r.assetUrl ?? null });
    } catch { /* checked again next interval */ }
  };
  setTimeout(updateCheck, 30 * 1000);
  setInterval(updateCheck, 12 * 60 * 60 * 1000);
});

app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; settingsWatcher?.close(); rulesWatcher?.close(); skillsWatcher?.close(); gatewayServer.stop().catch(() => {}); });

let skillsWatcher = null;
let skillsWatched = null;
let lastSkillsSync = null;

function runSkillsSync(installedToolIds) {
  // The shared folder can be changed in Settings or from a terminal, and its skills
  // folder can appear after startup; watch whichever folder is current now.
  const dir = activeSharedSkillsFolder(loadSettings());
  if (dir !== skillsWatched) {
    skillsWatcher?.close();
    skillsWatched = dir;
    skillsWatcher = dir ? createSkillsWatcher({ dir, onChange: () => runSkillsSync(installedToolIds) }) : null;
  }
  try {
    lastSkillsSync = { at: new Date().toISOString(), ...syncSkills({ installedToolIds }) };
  } catch (e) {
    // Kept for the Customizations tab rather than thrown out of a timer or a watcher.
    lastSkillsSync = { at: new Date().toISOString(), error: e.message, skills: [], targets: [] };
  }
  return lastSkillsSync;
}

let rulesWatcher = null;
let rulesWatched = '';
let lastRulesSync = null;

function runRulesSync(installedToolIds) {
  // The list can also be changed from a terminal (`switchboard rules sources`), which
  // this process never hears about; notice it here and watch the new files instead.
  if (JSON.stringify(loadRulesSources()) !== rulesWatched) watchRuleSources(installedToolIds);
  try {
    lastRulesSync = { at: new Date().toISOString(), ...syncRules({ installedToolIds }) };
  } catch (e) {
    // A missing source refuses the whole sync (see core/rules-sync.js); keep the reason
    // for the Customizations tab rather than throwing out of a timer.
    lastRulesSync = { at: new Date().toISOString(), error: e.message, sources: loadRulesSources(), targets: [] };
  }
  return lastRulesSync;
}

function watchRuleSources(installedToolIds) {
  const sources = loadRulesSources();
  rulesWatched = JSON.stringify(sources);
  rulesWatcher?.close();
  rulesWatcher = createRulesWatcher({ sources, onChange: () => runRulesSync(installedToolIds) });
}

/** (Re)start watching the current source list, then sync once. */
function startRulesSync(installedToolIds) {
  watchRuleSources(installedToolIds);
  return runRulesSync(installedToolIds);
}

// ---- IPC: the renderer only ever talks to the core through these. ----

ipcMain.handle('sb:getTheme', () => currentThemeInfo());

ipcMain.handle('sb:setTheme', (_e, mode) => {
  const valid = THEME_MODES.includes(mode) ? mode : 'system';
  const s = loadSettings();
  s.theme = valid;
  saveSettings(s);
  const info = applyThemeSetting(valid);
  broadcastTheme();
  return { ok: true, ...info };
});

function localAccountPerson(account, login) {
  let email = login?.email ?? null;
  let plan = login?.plan ?? null;
  if ((!email || !plan) && account?.provider === 'claude' && account?.home) {
    try {
      const claudeJson = JSON.parse(fs.readFileSync(path.join(account.home, '.claude.json'), 'utf8'));
      const oauthAcct = claudeJson?.oauthAccount;
      if (!email && typeof oauthAcct?.emailAddress === 'string' && oauthAcct.emailAddress) {
        email = oauthAcct.emailAddress;
      }
    } catch { /* ignore */ }
    try {
      const creds = JSON.parse(fs.readFileSync(path.join(account.home, '.credentials.json'), 'utf8'));
      const subType = creds?.claudeAiOauth?.subscriptionType;
      if (!plan && typeof subType === 'string' && subType) {
        plan = claudePlanName(subType, readClaudeRateLimitTier(account.home));
      }
    } catch { /* ignore */ }
  }
  return [email, plan ? `${plan} plan` : null].filter(Boolean).join(' \u00b7 ') || null;
}

ipcMain.handle('sb:trayFlyoutState', () => {
  const inputs = trayInputs();
  const quotas = { ...inputs.quotas };
  const signedIn = { ...inputs.signedIn };
  const notes = { ...inputs.notes };
  const accounts = inputs.accounts.map((a) => {
    if (!quotas[a.id] && PROVIDERS[a.provider]?.quota) {
      const q = cachedQuotaIfPresent(a);
      if (q) quotas[a.id] = q;
    }
    const authEntry = authCache.get(a.id);
    const cachedAuth = authEntry?.result ?? null;
    if (!cachedAuth && !authEntry?.pending && a.provider === 'claude') {
      cachedLoginState(a).then(() => {
        if (flyoutWin && !flyoutWin.isDestroyed()) {
          flyoutWin.webContents.send('sb:refresh');
        }
      }).catch(() => {});
    }
    const login = cachedAuth ?? accountLoginState(a);
    if (signedIn[a.id] == null) {
      if (login?.signedIn != null) signedIn[a.id] = login.signedIn;
      if (!notes[a.id] && (login?.signedIn === false || quotas[a.id])) {
        const n = accountNote(login, quotas[a.id]);
        if (n) notes[a.id] = n;
      }
    }
    const person = localAccountPerson(a, login);
    return { ...a, person };
  });
  const s = loadSettings();
  const themeInfo = currentThemeInfo(s.theme);
  const isMaximized = Boolean(flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isMaximized());
  const savedBounds = restorableFlyoutBounds();
  return {
    ...trayFlyoutModel({ ...inputs, accounts, quotas, signedIn, notes }),
    pinned: Boolean(s.flyoutPinned),
    maximized: isMaximized,
    userMoved: Boolean(savedBounds.userMoved),
    userSized: Boolean(savedBounds.userSized),
    theme: themeInfo.theme,
    effectiveTheme: themeInfo.effectiveTheme,
  };
});

ipcMain.handle('sb:flyoutResize', (_e, height) => {
  if (!flyoutWin || flyoutWin.isDestroyed()) return { ok: false };
  if (flyoutWin.isMaximized()) return { ok: true, maximized: true };
  const saved = restorableFlyoutBounds();
  if (saved.userSized || saved.userMoved) {
    return { ok: true, width: saved.width, height: saved.height, userSized: true };
  }
  const b = flyoutWin.getBounds();
  let maxH = 920;
  try {
    const display = screen.getDisplayMatching(b);
    if (display?.workArea?.height) {
      maxH = Math.max(DEFAULT_FLYOUT_HEIGHT, display.workArea.height - 24);
    }
  } catch {}
  const h = Math.min(maxH, Math.max(DEFAULT_FLYOUT_HEIGHT, Math.ceil(Number(height) || DEFAULT_FLYOUT_HEIGHT)));
  if (Math.abs(b.height - h) > 2 || Math.abs(b.width - DEFAULT_FLYOUT_WIDTH) > 2) {
    flyoutProgrammaticResize = true;
    flyoutWin.setSize(DEFAULT_FLYOUT_WIDTH, h, false);
    positionFlyoutWindow();
    setTimeout(() => { flyoutProgrammaticResize = false; }, 100);
  }
  return { ok: true, width: DEFAULT_FLYOUT_WIDTH, height: h, userSized: false };
});

ipcMain.handle('sb:trayFlyoutSettings', () => {
  const s = loadSettings();
  return { trayHoverFlyout: Boolean(s.trayHoverFlyout), flyoutPinned: Boolean(s.flyoutPinned) };
});

ipcMain.handle('sb:setTrayFlyoutSettings', (_e, { trayHoverFlyout, flyoutPinned } = {}) => {
  const s = loadSettings();
  if (trayHoverFlyout !== undefined) {
    s.trayHoverFlyout = Boolean(trayHoverFlyout);
  }
  if (flyoutPinned !== undefined) {
    s.flyoutPinned = Boolean(flyoutPinned);
  }
  saveSettings(s);
  if (tray && s.trayHoverFlyout) tray.setToolTip('');
  refreshTray();
  return { ok: true, trayHoverFlyout: s.trayHoverFlyout, flyoutPinned: s.flyoutPinned };
});

ipcMain.handle('sb:flyoutAction', async (_e, action) => {
  if (action === 'toggle-pin') {
    const s = loadSettings();
    s.flyoutPinned = !s.flyoutPinned;
    saveSettings(s);
    if (flyoutWin && !flyoutWin.isDestroyed()) {
      flyoutWin.webContents.send('sb:refresh');
    }
    return { ok: true, pinned: s.flyoutPinned };
  }
  if (action === 'minimize') {
    hideFlyout({ force: true });
    return { ok: true };
  }
  if (action === 'toggle-maximize') {
    if (flyoutWin && !flyoutWin.isDestroyed()) {
      if (flyoutWin.isMaximized()) {
        flyoutWin.unmaximize();
      } else {
        flyoutWin.maximize();
      }
      flyoutWin.webContents.send('sb:refresh');
    }
    return { ok: true, maximized: Boolean(flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isMaximized()) };
  }
  if (action === 'close') {
    // Closing hides the Usage Monitor while remembering whether it was pinned,
    // so the next time it is opened it keeps the same pinned behavior.
    hideFlyout({ force: true });
    return { ok: true };
  }
  if (action === 'refresh') {
    await runQuotaWatch();
    if (flyoutWin && !flyoutWin.isDestroyed()) {
      flyoutWin.webContents.send('sb:refresh');
    }
    return { ok: true };
  }
  if (action === 'dock-tray') {
    liveFlyoutBounds = null;
    clearTimeout(flyoutBoundsTimer);
    const s = loadSettings();
    s.flyoutBounds = null;
    saveSettings(s);
    if (flyoutWin && !flyoutWin.isDestroyed() && flyoutWin.isMaximized()) {
      flyoutWin.unmaximize();
    }
    positionFlyoutWindow();
    if (flyoutWin && !flyoutWin.isDestroyed()) {
      flyoutWin.webContents.send('sb:refresh');
    }
    return { ok: true };
  }
  hideFlyout();
  if (typeof action === 'string' && action.startsWith('open:')) {
    showWindow(action.slice('open:'.length));
    return { ok: true };
  }
  showWindow();
  return { ok: true };
});

ipcMain.handle('sb:state', (_e, forceAuthAccountId = null) => {
  const force = typeof forceAuthAccountId === 'string'
    && registry().accounts.some((account) => account.id === forceAuthAccountId)
    ? forceAuthAccountId
    : null;
  return stateSnapshot(force);
});

ipcMain.handle('sb:configExport', async () => {
  const stamp = new Date().toISOString().slice(0, 10);
  const picked = await dialog.showSaveDialog(win, {
    title: 'Export Switchboard configuration',
    defaultPath: path.join(app.getPath('documents'), `switchboard-config-${stamp}.json`),
    filters: [{ name: 'Switchboard configuration', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePath) return { ok: false };
  const config = currentConfig();
  fs.writeFileSync(picked.filePath, JSON.stringify(config, null, 2) + '\n', 'utf8');
  const skipped = config.files?.skipped ?? [];
  if (skipped.length) {
    // Every file left out is also listed inside the export; this says so at the time.
    await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Some files were left out',
      message: `${skipped.length} file(s) were left out of the export.`,
      detail: describeSkipped(skipped).join('\n'),
      buttons: ['OK'],
      noLink: true,
    });
  }
  return { ok: true, filePath: picked.filePath, summary: configSummary(config) };
});

ipcMain.handle('sb:configImport', async () => {
  const picked = await dialog.showOpenDialog(win, {
    title: 'Import Switchboard configuration',
    defaultPath: app.getPath('documents'),
    properties: ['openFile'],
    filters: [{ name: 'Switchboard configuration', extensions: ['json'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false };
  const filePath = picked.filePaths[0];
  // Room for the files section, which is capped at 15 MB of text (core/shared-backup.js).
  if (fs.statSync(filePath).size > 20 * 1024 * 1024) throw new Error('the selected config is too large');
  const imported = parseSwitchboardConfig(fs.readFileSync(filePath, 'utf8'));
  const summary = configSummary(imported);
  const filesPlan = imported.files ? planFilesImport(imported.files) : null;
  let detail = `${summary.accounts} account registration(s), ${summary.customApps} custom app(s), and ${summary.mcpServers} custom MCP server(s) will be imported.`;
  if (filesPlan) {
    const f = filesPlan.summary;
    detail += `\n\nFiles: ${f.folders} folder(s), ${f.files} file(s), ${formatBytes(f.bytes)}. A file already here with different text is kept beside it as <file>.before-import-<time>.`;
    if (filesPlan.needsFolder) detail += `\nShared AI folder on this machine: ${filesPlan.suggested}`;
    if (f.skipped) detail += `\n\nLeft out when the backup was made:\n${describeSkipped(imported.files.skipped).join('\n')}`;
  }
  detail += '\n\nThis does not copy, delete, or change vendor credential folders. MCP client registrations and sign-ins also remain untouched.';
  const buttons = filesPlan?.needsFolder ? ['Import', 'Import into another folder...', 'Cancel'] : ['Import', 'Cancel'];
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Import Switchboard configuration?',
    message: `Replace this machine's Switchboard configuration with ${path.basename(filePath)}?`,
    detail,
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    noLink: true,
  });
  if (answer.response === buttons.length - 1) return { ok: false };
  let sharedRoot = filesPlan?.suggested ?? null;
  if (filesPlan?.needsFolder && answer.response === 1) {
    const chosen = await dialog.showOpenDialog(win, {
      title: 'Where should the shared AI folder go on this machine?',
      defaultPath: sharedRoot ?? app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (chosen.canceled || !chosen.filePaths[0]) return { ok: false };
    sharedRoot = chosen.filePaths[0];
  }

  // Keep a known-good, importable snapshot before changing any of the three data files.
  const backupPath = saveRecoveryConfig('before-import');

  const oldRegistry = registry();
  const oldSettings = loadSettings();
  const oldMcp = loadServers();
  const nextRegistry = { accounts: imported.accounts };
  const nextSettings = settingsFromConfig(imported, oldSettings);
  if (imported.files) {
    // Saved with the other records, before the rule list below is checked against it.
    nextSettings.sharedAiFolder = filesPlan.needsFolder ? sharedSettingFor(sharedRoot) : imported.files.sharedFolder;
  }
  // The copies held for switched-off servers are not part of an exported config and are
  // not something an import should throw away: they are the only way those servers come
  // back, and the machine they came from is this one.
  const nextMcp = { servers: keepLocalEnv(imported.mcpServers, oldMcp.servers), disabled: oldMcp.disabled ?? [] };
  try {
    saveRegistry(nextRegistry);
    saveSettings(nextSettings);
    saveServers(nextMcp);
  } catch (error) {
    // Each file write is atomic; restoring all three puts the set back together if a
    // later write failed (disk full, permissions, or an external lock).
    try {
      saveRegistry(oldRegistry);
      saveSettings(oldSettings);
      saveServers(oldMcp);
    } catch { /* the combined backup above remains available for manual recovery */ }
    throw error;
  }

  const warnings = [];
  let filesResult = null;
  if (imported.files) {
    filesResult = restoreFilesSection(imported.files, { sharedRoot: filesPlan.needsFolder ? sharedRoot : null });
    const s = loadSettings();
    s.sharedAiBackupFolders = filesResult.backupFolders;
    saveSettings(s);
    if (imported.files.rulesSources.length) {
      try {
        if (filesResult.rulesSources.length) saveRulesSources(filesResult.rulesSources);
        else warnings.push('None of the rule files the backup lists are on this machine, so the rule file list was left as it was.');
      } catch (error) {
        warnings.push(`Could not restore the rule file list: ${error.message || error}`);
      }
    }
    // One sync, on the restored list and files, and the watcher moved onto them.
    // The restored shared folder can carry skills too, so they go out the same way.
    const restoredIds = await installedCustomizationToolIds().catch(() => []);
    startRulesSync(restoredIds);
    runSkillsSync(restoredIds);
    if (filesResult.skipped.length) {
      warnings.push(`${filesResult.skipped.length} file(s) not restored: ${describeSkipped(filesResult.skipped, 5).join('; ')}.`);
    }
  }
  for (const [provider, id] of Object.entries(imported.activeAccounts)) {
    try {
      setActive(nextRegistry, id);
    } catch (error) {
      warnings.push(`Could not make ${provider} account ${id} active: ${error.message || error}`);
    }
  }
  authCache.clear();
  quotaCache.clear();
  quotaInflight.clear();
  refresh();
  if (nextSettings.quotaWatch !== 'off') runQuotaWatch();
  const files = filesResult && {
    created: filesResult.created.length,
    replaced: filesResult.replaced.length,
    same: filesResult.same.length,
    skipped: filesResult.skipped,
  };
  return { ok: true, filePath, backupPath, summary, warnings, files };
});

ipcMain.handle('sb:setActive', async (_e, id) => {
  const reg = registry();
  const chosen = reg.accounts.find((a) => a.id === id);
  if (!chosen) throw new Error(`no such account: ${id}`);
  const refusal = manualSwitchRefusal(chosen);
  if (refusal) throw new Error(refusal);
  // The button for a signed-out account is disabled, but a card drawn before the login
  // went stale could still send this. The usage watch refuses the same switch, so the
  // deliberate one is refused too rather than pointing new terminals at a dead folder.
  // The cached reading is keyed to the credential file, so this costs nothing when the
  // sign-in has not moved since the page was drawn.
  const login = await cachedLoginState(chosen);
  if (login?.signedIn === false) {
    throw new Error(`${chosen.label} is not signed in. Sign it in first, then switch.`);
  }
  const account = setActive(reg, id);
  refresh();
  runQuotaWatch();
  return { ok: true, account };
});

// A brand-new account: Switchboard makes the folder, and the page then opens sign-in.
ipcMain.handle('sb:createAccount', (_e, provider, label) => {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`unknown provider: ${provider}`);
  const reg = registry();
  const account = createAccount(reg, { provider, label });
  saveRegistry(reg);
  quotaCache.clear();
  quotaInflight.clear();
  refresh();
  return { ok: true, account };
});

// An account whose folder already exists somewhere, picked by hand.
ipcMain.handle('sb:addAccount', async (_e, provider) => {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`unknown provider: ${provider}`);
  const picked = await dialog.showOpenDialog(win, {
    title: `Choose (or create) a config folder for a ${def.name} account`,
    defaultPath: path.dirname(def.defaultHome()),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false };
  const label = path.basename(picked.filePaths[0]);
  const home = normalizeHome(provider, picked.filePaths[0]);
  fs.mkdirSync(home, { recursive: true });
  const reg = registry();
  const account = addAccount(reg, { provider, label, home });
  saveRegistry(reg);
  // Claude Desktop attribution depends on organization IDs being unique across the
  // whole registry, so membership changes invalidate every cached attribution.
  quotaCache.clear();
  quotaInflight.clear();
  refresh();
  return { ok: true, account, loginHint: def.loginHint };
});

ipcMain.handle('sb:rename', (_e, id, label) => {
  const reg = registry();
  const account = renameAccount(reg, id, label);
  saveRegistry(reg);
  refresh();
  return { ok: true, account };
});

ipcMain.handle('sb:setColor', (_e, id, color) => {
  const reg = registry();
  const account = setAccountColor(reg, id, color);
  saveRegistry(reg);
  refresh();
  return { ok: true, account };
});

/** Give every account T3 Code also knows the color T3 shows it in. Nothing else changes. */
ipcMain.handle('sb:copyT3Colors', () => {
  const reg = registry();
  const colors = matchT3Colors(reg, readT3Instances());
  let changed = 0;
  for (const [id, color] of Object.entries(colors)) {
    if (reg.accounts.find((a) => a.id === id)?.color === color) continue;
    setAccountColor(reg, id, color);
    changed++;
  }
  if (changed) {
    saveRegistry(reg);
    refresh();
  }
  return { ok: true, matched: Object.keys(colors).length, changed };
});

ipcMain.handle('sb:removeAccount', (_e, id) => {
  const reg = registry();
  const removed = removeAccount(reg, id);
  saveRegistry(reg);
  authCache.delete(id);
  quotaCache.clear();
  quotaInflight.clear();
  refresh();
  return { ok: true, removed };
});

ipcMain.handle('sb:providers', () => detectAll());

ipcMain.handle('sb:updates', async () => checkAllUpdates(await detectAll(), { agyUpdate: loadSettings().agyUpdate }));

ipcMain.handle('sb:detectOne', (_e, toolId) => detectToolById(toolId));

ipcMain.handle('sb:candidates', () => detectCandidates(registry()));

ipcMain.handle('sb:register', (_e, candidate) => {
  const reg = registry();
  const account = addAccount(reg, candidate);
  saveRegistry(reg);
  quotaCache.clear();
  quotaInflight.clear();
  refresh();
  return { ok: true, account };
});

ipcMain.handle('sb:fix', async (_e, action, args) => {
  // Minting a lane token needs a person at a real console (see laneTokenTerminal), so this
  // fix opens one rather than changing anything itself. The window's own lane-token command
  // stores the token, and the settings watcher picks it up.
  if (action === 'mint-lane-token') {
    const laneId = String(args?.laneId ?? '');
    const lane = loadSettings().lanes?.find((l) => l.id === laneId && l.harness === 'claude');
    if (!lane) throw new Error(`no Claude lane with id "${laneId}"`);
    const account = registry().accounts.find((a) => a.id === lane.accountId);
    if (!account) throw new Error(`lane ${laneId} names an unregistered account (${lane.accountId})`);
    if (!claudeExecutablePromise) claudeExecutablePromise = toolExecutable('claude');
    const claudePath = await claudeExecutablePromise;
    if (!claudePath) throw new Error('Claude Code is not installed or not on PATH');
    const { command, env: tokenEnv } = laneTokenTerminal({
      laneId,
      label: account.label,
      exePath: process.execPath,
      cliPath: path.join(here, '..', 'bin', 'cli.js'),
      claudePath,
    });
    spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', command], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
      // The lane's own folder, with any inherited Claude token stripped, so setup-token
      // mints for this account and no other (the same scoping the sign-in window uses).
      env: { ...accountScopedEnv(account, process.env), ...tokenEnv },
    }).unref();
    return { ok: true, did: 'A window has opened. Approve in the browser, then paste the token back into that window.' };
  }
  const result = applyFix(action, args);
  refresh();
  return result;
});

ipcMain.handle('sb:signin', (_e, accountId) => {
  const account = registry().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account: ${accountId}`);
  // Preserve the last known usage while the interactive login runs, but invalidate
  // an old-token request so it cannot repopulate the cache after authentication.
  quotaInflight.delete(accountId);
  // A visible terminal with the account's folder preselected, so the vendor's own
  // login flow lands in the right home. The folder travels in the child's environment,
  // never in the command text: see core/signin.js for why.
  const { command, env: signinEnv } = signinTerminal(account);
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', command], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
    env: { ...accountScopedEnv(account, process.env), ...signinEnv },
  }).unref();
  return { ok: true };
});

ipcMain.handle('sb:signout', async (_e, accountId) => {
  const account = registry().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account: ${accountId}`);
  const def = PROVIDERS[account.provider];
  if (!signoutSupported(account.provider)) {
    throw new Error(`${def?.name ?? account.provider} has no sign-out command Switchboard can run`);
  }
  // An in-flight request still holds the credential this is about to remove, so it is
  // dropped before the command runs and the stored reading after it: neither may outlive
  // the sign-in it was taken with.
  quotaInflight.delete(accountId);
  const executable = await toolExecutable(account.provider);
  const result = await signOutAccount(account, { executable });
  authCache.delete(accountId);
  quotaCache.delete(accountId);
  quotaInflight.delete(accountId);
  refresh();
  return result;
});

let installedToolIdsCache = { at: 0, ids: null, inflight: null };
let mcpClientAvailCache = { at: 0, map: null, inflight: null };
const CLI_DETECT_CACHE_TTL_MS = 60_000;

function invalidateCliDetectionCaches() {
  installedToolIdsCache = { at: 0, ids: null, inflight: null };
  mcpClientAvailCache = { at: 0, map: null, inflight: null };
}

async function installedCustomizationToolIds() {
  const now = Date.now();
  if (installedToolIdsCache.ids && now - installedToolIdsCache.at < CLI_DETECT_CACHE_TTL_MS) {
    return installedToolIdsCache.ids;
  }
  if (!installedToolIdsCache.inflight) {
    installedToolIdsCache.inflight = detectInstalled()
      .then((detected) => {
        const ids = detected.filter((t) => t.installed).map((t) => t.id);
        installedToolIdsCache = { at: Date.now(), ids, inflight: null };
        return ids;
      })
      .catch((err) => {
        installedToolIdsCache.inflight = null;
        throw err;
      });
  }
  return installedToolIdsCache.inflight;
}

async function cachedMcpClients() {
  const now = Date.now();
  if (!mcpClientAvailCache.map || now - mcpClientAvailCache.at >= CLI_DETECT_CACHE_TTL_MS) {
    if (!mcpClientAvailCache.inflight) {
      mcpClientAvailCache.inflight = Promise.all(
        Object.values(MCP_CLIENTS).map(async (c) => [c.id, await clientAvailable(c.id)]),
      )
        .then((pairs) => {
          const map = Object.fromEntries(pairs);
          mcpClientAvailCache = { at: Date.now(), map, inflight: null };
          return map;
        })
        .catch((err) => {
          mcpClientAvailCache.inflight = null;
          throw err;
        });
    }
    await mcpClientAvailCache.inflight;
  }
  return Object.values(MCP_CLIENTS).map((c) => ({
    id: c.id,
    name: c.name,
    available: Boolean(mcpClientAvailCache.map?.[c.id]),
    // File-edited clients can always undo; CLI-driven ones only if they ship a remove verb.
    canRemove: c.via === 'file' || Boolean(c.removeArgs),
    canList: Boolean(c.listArgs),
    // Whether this client can say if a server is actually signed in, or only registered.
    reportsAuth: Boolean(c.authFile && c.parseAuth),
    site: c.site ?? null,
  }));
}

ipcMain.handle('sb:install', (_e, toolId, mode = 'install') => {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) throw new Error(`unknown tool: ${toolId}`);
  const cmd = installCmdFor(tool, mode);
  if (!cmd) throw new Error(`${tool.name} has no automated ${mode}; use the vendor site`);
  invalidateCliDetectionCaches();
  // Vendor installers run in a visible terminal the user can watch and answer.
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', cmd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
  return { ok: true, cmd };
});

ipcMain.handle('sb:doctor', async () => {
  const accounts = registry().accounts;
  const loginStates = {};
  await Promise.all(accounts.map(async (account) => {
    loginStates[account.id] = await cachedLoginState(account);
  }));
  // Settings ride along so a dead lane token surfaces here; the checks only ever name
  // the lane and account, never the token value.
  const installedIds = new Set((await detectInstalled()).filter((t) => t.installed).map((t) => t.id));
  return runChecks({ accounts, loginStates, settings: loadSettings(), isInstalled: (id) => installedIds.has(id), t3LeaseSha: currentLeaseSha() });
});

// A vendor status page belongs to the tool, not to any one account, so this needs
// none of sb:doctor's account/settings gathering. `force` is what the Health tab's
// "Check now" button sends to skip the shared five-minute cache.
ipcMain.handle('sb:providerHealth', async (_e, force = false) => {
  const health = await fetchAllProviderStatus({ force });
  return TOOLS.map((t) => ({ id: t.id, name: t.name, ...health[t.id] }));
});

/**
 * MCP servers. Switchboard keeps the definition (a name and an https url, or a local
 * command) and asks each client's own CLI to register it. No sign-in passes through here
 * and nothing is proxied: every client still signs in for itself and keeps its own
 * credentials.
 */
ipcMain.handle('sb:mcpState', async () => {
  const reg = loadServers();
  // Opening the tab is when someone wants to see every account's servers, so it is when
  // they are shared across accounts. A failure here must not stop the tab from opening.
  try { syncClientAccountMirrors(reg); } catch { /* the panel still shows what each file has */ }
  const clients = await cachedMcpClients();
  // Only ask about clients that are actually here; reading a config for a tool that is
  // not installed would report nothing anyway and just muddies the panel.
  const usable = clients.filter((c) => c.available).map((c) => c.id);
  return { servers: registrationMatrix(activeServers(reg, usable), usable), local: reg.servers, clients };
});

/** The browse screen: the whole catalogue, filtered, with the categories to filter by. */
ipcMain.handle('sb:mcpBrowse', async (_e, { query = '', category = '' } = {}) => {
  const reg = loadServers();
  const all = browseServers(reg);
  const clients = await cachedMcpClients();
  const usable = clients.filter((c) => c.available).map((c) => c.id);
  const matched = searchCatalog(all, { query, category });
  return {
    total: all.length,
    matched: matched.length,
    categories: categoriesOf(all),
    // The catalogue ships with the application and is a few dozen rows, so it is sent
    // whole. It was once capped at sixty, which hid four servers behind a search box on a
    // screen whose whole job is to show what is available.
    servers: registrationMatrix(matched, usable),
  };
});

ipcMain.handle('sb:mcpAdd', (_e, payload = {}) => {
  const reg = loadServers();
  const server = addServer(reg, payload);
  saveServers(reg);
  return { ok: true, server };
});

ipcMain.handle('sb:mcpRemove', (_e, name) => {
  const reg = loadServers();
  removeServer(reg, name);
  saveServers(reg);
  return { ok: true };
});

// The renderer sends a server name, never a command or a url. The definition is resolved
// from the catalogue, the local registry, or the clients' own configs, so a renderer
// cannot invent one.
const resolveServer = (name) => resolveServerByName(name);

ipcMain.handle('sb:mcpRegister', (_e, clientId, name) => registerServer(clientId, resolveServer(name)));

ipcMain.handle('sb:mcpUnregister', (_e, clientId, name) => unregisterServer(clientId, resolveServer(name)));

ipcMain.handle('sb:mcpList', (_e, clientId) => listRegistered(clientId));

/**
 * Switching a whole server off and on again. The renderer sends a name only; which
 * clients hold it, and what each of their entries says, is read here and kept here.
 */
ipcMain.handle('sb:mcpDisable', (_e, name) => disableServer(name));

ipcMain.handle('sb:mcpEnable', (_e, name) => enableServer(name));

ipcMain.handle('sb:mcpServerTools', (_e, name) => listServerTools(name));

/**
 * Customizations control plane: Plugins, Skills, Global Rules, Custom Agents, and
 * Trusted Multi-Source Marketplace across all installed or configured providers.
 */
ipcMain.handle('sb:customizationsState', async () => {
  const installedToolIds = await installedCustomizationToolIds();
  const snap = customizationsSnapshot({ installedToolIds });
  const { mcpServerTools, ...serializable } = snap;
  return serializable;
});

ipcMain.handle('sb:customizationsMarketplace', (_e, opts = {}) => {
  const all = loadMarketplaceCatalog();
  const matched = searchMarketplace(all, opts);
  return {
    total: all.length,
    matched: matched.length,
    sources: MARKETPLACE_SOURCES,
    items: matched,
  };
});

ipcMain.handle('sb:customizationsInstall', async (_e, { target = '', clients = [] } = {}) => {
  const cleanTarget = String(target ?? '').trim();
  if (!cleanTarget) throw new Error('specify a marketplace item name or a GitHub owner/repo');
  const installedToolIds = await installedCustomizationToolIds();
  if (cleanTarget.includes('/') || cleanTarget.startsWith('http')) {
    return installFromGitHub(cleanTarget, { clients, installedToolIds });
  }
  return installMarketplaceItem(cleanTarget, { clients, installedToolIds });
});

ipcMain.handle('sb:customizationsSetSkill', async (_e, { skillName, clientId, enabled } = {}) => {
  const installedToolIds = await installedCustomizationToolIds();
  // setSkillState handles a skill kept in the shared AI folder itself (remember the
  // choice, then sync that skill for that tool) and passes any other skill on.
  return setSkillState(skillName, clientId, enabled, { installedToolIds });
});

ipcMain.handle('sb:customizationsSaveSkill', async (_e, payload = {}) => {
  const installedToolIds = await installedCustomizationToolIds();
  return saveCustomSkill(payload, { installedToolIds });
});

ipcMain.handle('sb:customizationsSetAgent', async (_e, { agentName, clientId, enabled } = {}) => {
  const installedToolIds = await installedCustomizationToolIds();
  return setAgentClientState(agentName, clientId, enabled, { installedToolIds });
});

ipcMain.handle('sb:customizationsSaveAgent', async (_e, payload = {}) => {
  const installedToolIds = await installedCustomizationToolIds();
  return saveCustomAgent(payload, { installedToolIds });
});

ipcMain.handle('sb:customizationsSyncRule', async (_e, { text = '', clients = [] } = {}) => {
  const installedToolIds = await installedCustomizationToolIds();
  return syncGlobalInstructionToClients(text, clients, { installedToolIds });
});
// Rules from one source. State is a dry run, so opening the tab never writes anything;
// saving a new list restarts the watcher on the new files and syncs straight away.
ipcMain.handle('sb:rulesState', async () => {
  const installedToolIds = await installedCustomizationToolIds();
  try {
    return { ...syncRules({ dryRun: true, installedToolIds }), last: lastRulesSync };
  } catch (e) {
    return { error: e.message, sources: loadRulesSources(), targets: [], last: lastRulesSync };
  }
});

ipcMain.handle('sb:rulesSetSources', async (_e, sources = []) => {
  saveRulesSources(sources);
  return startRulesSync(await installedCustomizationToolIds());
});

ipcMain.handle('sb:rulesSync', async () => runRulesSync(await installedCustomizationToolIds()));

// Skills from the shared AI folder (core/skills-sync.js). State is a dry run, as for rules.
ipcMain.handle('sb:skillsSyncState', async () => {
  const installedToolIds = await installedCustomizationToolIds();
  try {
    return { ...syncSkills({ dryRun: true, installedToolIds }), last: lastSkillsSync };
  } catch (e) {
    return { error: e.message, skills: [], targets: [], last: lastSkillsSync };
  }
});

ipcMain.handle('sb:skillsSync', async () => runSkillsSync(await installedCustomizationToolIds()));

// Rule file history (core/rules-history.js): the copies a sync kept, and putting one
// back. A restore keeps the current text first and then syncs, as `switchboard rules
// restore` does, so the page and the terminal leave the same trail.
ipcMain.handle('sb:rulesHistory', (_e, file) => listRuleVersions(String(file ?? '')));

ipcMain.handle('sb:rulesRestore', async (_e, file, version) => {
  const restored = restoreRuleVersion(String(file ?? ''), String(version ?? ''));
  return { restored, ...startRulesSync(await installedCustomizationToolIds()) };
});

// The shared AI folder (core/shared-folder.js) and the rule file list kept inside it.
// Every change goes through the same core functions `switchboard settings` and
// `switchboard rules sources` use, so the page and the terminal cannot disagree.
function sharedFolderSnapshot() {
  const settings = loadSettings();
  const state = sharedFolderState(settings);
  const sources = loadRulesSources();
  const active = state.exists ? state.path : null;
  return { ...state, rulesSources: sources, outsideSharedFolder: sourcesOutsideSharedFolder(sources, active) };
}

ipcMain.handle('sb:sharedFolderState', () => sharedFolderSnapshot());

ipcMain.handle('sb:sharedFolderChoose', async () => {
  const current = sharedFolderState(loadSettings());
  const picked = await dialog.showOpenDialog(win, {
    title: 'Choose the shared AI folder',
    defaultPath: current.exists ? current.path : app.getPath('home'),
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, ...sharedFolderSnapshot() };
  saveSettings(withSharedFolder(loadSettings(), picked.filePaths[0]));
  return { ok: true, ...sharedFolderSnapshot() };
});

ipcMain.handle('sb:sharedFolderSet', (_e, value) => {
  saveSettings(withSharedFolder(loadSettings(), typeof value === 'string' ? value : ''));
  return sharedFolderSnapshot();
});

ipcMain.handle('sb:sharedFolderSetBackups', (_e, names = []) => {
  saveSettings(withBackupFolders(loadSettings(), Array.isArray(names) ? names : []));
  return sharedFolderSnapshot();
});

ipcMain.handle('sb:rulesAddSource', async () => {
  const shared = activeSharedFolder(loadSettings());
  const rulesDir = shared ? path.join(shared, 'rules') : null;
  const startIn = rulesDir && fs.existsSync(rulesDir) ? rulesDir : shared ?? app.getPath('home');
  const picked = await dialog.showOpenDialog(win, {
    title: 'Add a rule file',
    defaultPath: startIn,
    properties: ['openFile'],
    filters: [{ name: 'Rule files', extensions: ['md', 'txt'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false, ...sharedFolderSnapshot() };
  saveRulesSources([...loadRulesSources(), picked.filePaths[0]]);
  startRulesSync(await installedCustomizationToolIds());
  return { ok: true, ...sharedFolderSnapshot() };
});

ipcMain.handle('sb:automationsState', () => {
  const state = loadAutomations();
  return {
    automations: state.automations,
    presets: AUTOMATION_INTERVAL_PRESETS,
  };
});

ipcMain.handle('sb:automationsAdd', (_e, payload = {}) => {
  const state = loadAutomations();
  const item = addAutomation(state, payload);
  saveAutomations(state);
  return { ok: true, item };
});

ipcMain.handle('sb:automationsRemove', (_e, id) => {
  const state = loadAutomations();
  removeAutomation(state, id);
  saveAutomations(state);
  return { ok: true };
});

ipcMain.handle('sb:automationsToggle', (_e, { id, enabled } = {}) => {
  const state = loadAutomations();
  const item = toggleAutomation(state, id, enabled);
  saveAutomations(state);
  return { ok: true, item };
});

ipcMain.handle('sb:automationsRun', (_e, id) => {
  const state = loadAutomations();
  const target = state.automations.find((a) => a.id === id);
  if (!target) throw new Error(`Automation not found: ${id}`);
  recordAutomationRun(state, id, {
    status: 'launched',
    summary: `Launched via Switchboard failover lane pool at ${new Date().toLocaleTimeString()}`,
  });
  saveAutomations(state);
  return { ok: true, item: target };
});

// What the Apps panel last showed, kept so the running poll can match processes to
// apps without re-running detection (a PowerShell call) every few seconds.
let appRefs = [];

ipcMain.handle('sb:apps', async () => {
  const startApps = await getStartApps();
  const settings = loadSettings();
  // An installed app carries the accounts it can open on, so the panel can name the
  // one its button opens without a second round trip and a visible correction.
  const builtin = detectApps(startApps).map((a) => (a.installed ? { ...a, ...appProfilesFor(a.id) } : a));
  const custom = settings.customApps.map((c) => ({ id: `custom:${c.appId}`, name: c.label, installed: true, appId: c.appId, exePath: null, custom: true }));
  const ordered = orderApps([...builtin, ...custom], settings.appOrder);
  appRefs = ordered.filter((a) => a.installed).map((a) => ({ id: a.id, exePath: a.exePath, appId: a.appId }));
  return ordered;
});

/**
 * One process snapshot answers for every card: which apps are running, and which
 * bridges. `known: false` means the machine could not be asked, which the panel shows
 * as no state at all rather than as everything-stopped.
 */
ipcMain.handle('sb:running', async () => {
  const settings = loadSettings();
  const processes = await listProcesses();
  if (!processes) return { known: false, apps: {}, bridges: settings.bridges.map((b) => ({ ...b, running: null })) };
  const apps = {};
  for (const a of appRefs) apps[a.id] = appRunning(processes, a);
  return { known: true, apps, bridges: settings.bridges.map((b) => ({ ...b, running: bridgeRunning(processes, b.match) })) };
});

// The list alone, so the panel can draw its rows instantly; the snapshot poll
// (sb:running) fills in whether each one is alive.
ipcMain.handle('sb:bridges', () => loadSettings().bridges);

ipcMain.handle('sb:addBridge', (_e, entry) => {
  const problem = bridgeProblem(entry ?? {});
  if (problem) return { ok: false, error: problem };
  const settings = loadSettings();
  const label = entry.label.trim();
  const match = entry.match.trim();
  if (settings.bridges.some((b) => b.match === match)) return { ok: false, error: 'that match text is already being watched' };
  settings.bridges.push({ id: `bridge-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, label, match });
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:removeBridge', (_e, id) => {
  const settings = loadSettings();
  settings.bridges = settings.bridges.filter((b) => b.id !== id);
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:renameBridge', (_e, { id, label } = {}) => {
  const problem = renameBridgeProblem({ label });
  if (problem) return { ok: false, error: problem };
  const settings = loadSettings();
  const bridge = settings.bridges.find((b) => b.id === id);
  if (!bridge) return { ok: false, error: 'bridge not found' };
  bridge.label = label.trim();
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:bridgeProcessCandidates', async (_e, query = '') => {
  const processes = await listProcesses();
  if (!processes) return [];
  return candidateBridgeProcesses(processes, { query });
});

ipcMain.handle('sb:setAppOrder', (_e, ids) => {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new Error('order must be a list of app ids');
  const settings = loadSettings();
  settings.appOrder = ids;
  saveSettings(settings);
  return { ok: true };
});

/**
 * The accounts one app can be opened on, and which of them the button opens.
 *
 * Impure by nature: it reads the account registry, the folders added by hand, and each
 * folder's own record of who it is signed in as. Every decision it makes about those
 * facts lives in core/appprofiles.js, where it can be tested.
 */
function appProfilesFor(appId) {
  const def = appProfileDef(appId);
  if (!def) return { supported: false, profiles: [], openDir: null };
  const settings = loadSettings();
  const dirs = discoverProfileDirs(appId, { extra: settings.appProfileDirs[appId] ?? [] });
  const reg = registry();
  const accounts = reg.accounts
    .filter((a) => a.provider === def.provider)
    .map((a) => ({ id: a.id, label: a.label, color: a.color ?? null, organizationUuid: def.accountOrganization(a.home) }));
  const profiles = describeProfiles(dirs, {
    accounts,
    organizationOf: def.organizationOf,
    defaultDir: def.defaultDir(),
  });
  const active = activeAccount(reg, def.provider);
  const open = chooseOpenProfile(profiles, active?.id ?? null);
  const added = settings.appProfileDirs[appId] ?? [];
  return {
    supported: true,
    profiles: profiles.map((p) => ({
      ...p,
      added: added.some((d) => samePath(d, p.dir)),
      isOpen: open != null && samePath(p.dir, open.dir),
    })),
    openDir: open?.dir ?? null,
  };
}

ipcMain.handle('sb:appProfiles', (_e, appId) => appProfilesFor(appId));

ipcMain.handle('sb:appLaunch', async (_e, id, profileDir = null) => {
  if (id.startsWith('custom:')) {
    return { ok: launchApp({ appId: id.slice('custom:'.length) }) };
  }
  const detected = detectApps(await getStartApps()).find((a) => a.id === id);
  if (!detected?.installed) throw new Error('not installed');
  if (!profileDir) return { ok: launchApp(detected) };
  // The renderer names one of the folders Switchboard itself offered, never a path of
  // its own, so the list is rebuilt here rather than trusted.
  const profile = appProfilesFor(id).profiles.find((p) => samePath(p.dir, profileDir));
  if (!profile) throw new Error('that is not a folder this app was offered on');
  // The standard profile opens the way it always has, through Windows' own activation,
  // so the everyday launch keeps the app's package identity and needs nothing found.
  if (profile.isDefault) return { ok: launchApp(detected) };
  const exePath = detected.exePath ?? await resolvePackagedExe(detected.appId, detected.packagedExe);
  if (!exePath) throw new Error(`Switchboard cannot find ${detected.name}'s program file, so it can only open the standard account.`);
  return { ok: launchApp({ exePath, args: profileLaunchArgs(id, profile.dir) }) };
});

/**
 * Add a folder for an app to open on. Switchboard records the folder and nothing else:
 * the account inside it is created by signing in to the app itself, exactly as a CLI
 * account is created by signing in to the CLI.
 */
ipcMain.handle('sb:addAppProfile', async (_e, appId) => {
  const def = appProfileDef(appId);
  if (!def) throw new Error('that app cannot be opened on a chosen account');
  const named = APPS.find((a) => a.id === appId)?.name ?? appId;
  const picked = await dialog.showOpenDialog(win, {
    title: `Choose (or create) a data folder for another ${named} account`,
    defaultPath: app.getPath('home'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false };
  const dir = picked.filePaths[0];
  const problem = profileFolderProblem(dir);
  if (problem) return { ok: false, error: problem };
  const settings = loadSettings();
  const known = appProfilesFor(appId).profiles.some((p) => samePath(p.dir, dir));
  if (!known) {
    settings.appProfileDirs[appId] = [...(settings.appProfileDirs[appId] ?? []), dir];
    saveSettings(settings);
  }
  return { ok: true, dir, alreadyListed: known };
});

/** Stop offering a folder that was added by hand. The folder itself is left alone. */
ipcMain.handle('sb:removeAppProfile', (_e, appId, dir) => {
  const settings = loadSettings();
  const kept = (settings.appProfileDirs[appId] ?? []).filter((d) => !samePath(d, dir));
  settings.appProfileDirs[appId] = kept;
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:appInstall', (_e, id, mode = 'install') => {
  const app_ = APPS.find((a) => a.id === id);
  if (!app_) throw new Error(`unknown app: ${id}`);
  const cmd = installCmdFor(app_, mode);
  if (!cmd) throw new Error(`${app_.name} has no automated ${mode}; use the vendor site`);
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', cmd], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true, cmd };
});

ipcMain.handle('sb:startAppsList', () => getStartApps());

ipcMain.handle('sb:addCustomApp', (_e, { label, appId }) => {
  if (!label || !appId) throw new Error('label and appId are required');
  const settings = loadSettings();
  if (!settings.customApps.some((c) => c.appId === appId)) {
    settings.customApps.push({ label: String(label), appId: String(appId) });
    saveSettings(settings);
  }
  return { ok: true };
});

ipcMain.handle('sb:removeCustomApp', (_e, appId) => {
  const settings = loadSettings();
  settings.customApps = settings.customApps.filter((c) => c.appId !== appId);
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:antigravityQuota', (_e, force = false) => getAntigravityQuota(force));

ipcMain.handle('sb:antigravity', () => antigravityPresence());

ipcMain.handle('sb:presence', () => detectPresence());

ipcMain.handle('sb:terminals', async () => {
  const activeHomes = {};
  for (const id of Object.keys(PROVIDERS)) activeHomes[id] = activeHome(id);
  const rows = terminalRows({ tools: await detectInstalled(), accounts: registry().accounts, activeHomes });
  return terminalChips(rows);
});

/**
 * Open a terminal on one CLI, optionally pinned to one account.
 *
 * Only a bin from the tool table can ever be run, and only an account that belongs to
 * that tool: a caller names things, it never supplies a command or a path. With no
 * account named the terminal inherits the machine defaults; named, it is pointed at that
 * account's folder through its own environment, leaving the machine default alone.
 */
function openTerminalOn(bin, accountId = null) {
  const tool = TOOLS.find((t) => t.bin === bin);
  if (!tool) throw new Error('unknown terminal target');
  let env = { ...process.env };
  if (accountId) {
    const account = registry().accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`no such account: ${accountId}`);
    if (account.provider !== tool.id) throw new Error(`${account.label} is not a ${tool.name} account`);
    env = accountScopedEnv(account, process.env);
  }
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', bin], { detached: true, stdio: 'ignore', windowsHide: false, env }).unref();
  return { ok: true };
}

ipcMain.handle('sb:openTerminal', (_e, bin, accountId = null) => openTerminalOn(bin, accountId));

/**
 * Quota cache. The usage endpoint rate-limits per token aggressively, so the app
 * asks at most once per account per interval and otherwise serves the last good
 * answer (marked stale) rather than burning the allowance on every render.
 */
const QUOTA_TTL_MS = 5 * 60 * 1000;
const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000;
const AUTH_FAILURE_BACKOFF_MS = 60 * 60 * 1000;
const quotaCache = new Map(); // accountId -> { key, at, lastAttemptAt, result }
const quotaInflight = new Map(); // accountId -> { key, pending }

/** A current quota reading already paid for by another surface, without any I/O to a vendor. */
function cachedQuotaIfPresent(account, now = Date.now()) {
  const key = quotaAccountCacheKey(account);
  const hit = quotaCache.get(account.id);
  if (hit?.key === key && hit.result) {
    const liveReadingAged = hit.result.source === 'token'
      && (hit.at == null || now - hit.at > DESKTOP_STALE_MS);
    return {
      ...hit.result,
      observedAt: hit.at,
      cached: true,
      ...(hit.lastError ? { refreshError: hit.lastError } : {}),
      ...(liveReadingAged ? { stale: true } : {}),
    };
  }
  return readSharedQuota(account.id, sharedQuotaKey(account.provider, account.home), now);
}

async function cachedQuota(account, force = false) {
  const key = quotaAccountCacheKey(account);
  const cached = quotaCache.get(account.id);
  const hit = cached?.key === key ? cached : null;
  const now = Date.now();
  const lastAttemptAt = hit?.lastAttemptAt ?? hit?.at ?? 0;
  const retryDelay = hit?.lastError === 'rate-limited'
    ? RATE_LIMIT_BACKOFF_MS
    : hit?.lastError === 'auth' ? AUTH_FAILURE_BACKOFF_MS : QUOTA_TTL_MS;
  if (!force && hit && now - lastAttemptAt < retryDelay) {
    if (!hit.result) return { error: hit.lastError, cached: true, checkedAt: lastAttemptAt };
    return {
      ...hit.result,
      observedAt: hit.at,
      cached: true,
      ...(hit.lastError ? { refreshError: hit.lastError } : {}),
    };
  }
  if (!force && !hit) {
    const shared = readSharedQuota(account.id, sharedQuotaKey(account.provider, account.home), now);
    if (shared) {
      const { observedAt, cached: _cached, ...result } = shared;
      quotaCache.set(account.id, {
        key,
        at: observedAt,
        lastAttemptAt: observedAt,
        lastError: null,
        result,
      });
      return shared;
    }
  }
  const inFlight = quotaInflight.get(account.id);
  if (inFlight?.key === key) return inFlight.pending;

  let flight;
  const pending = (async () => {
    const settings = loadSettings();
    const reg = registry();
    const fetched = await providerQuota(account.provider, account.home, {
      usageSource: settings.usageSources[account.id] ?? null,
      allowDesktopFallback: desktopFallbackIsUnambiguous(account, reg.accounts),
    });
    const completedAt = Date.now();
    // The reading already on show and when it arrived: the one in memory, or the shared
    // file's when the app restarted and the in-memory cache is empty.
    const shared = hit?.result ? null : lastSharedQuota(account.id);
    const held = hit?.result
      ? { result: hit.result, at: hit.at }
      : shared ? { result: shared, at: shared.observedAt ?? null } : null;
    // A reading missing turnover times (the Desktop fallback never has them) inherits
    // any still-future ones the last reading knew, so a rate-limited tick cannot make
    // an account's known week turnover vanish; see inheritResetTimes, which refuses
    // to carry a schedule across a change of account.
    const result = inheritResetTimes(fetched, held?.result ?? null, completedAt);
    const isCurrent = quotaInflight.get(account.id) === flight;
    // A fallback snapshot older than the reading on show is not a refresh, only a failed
    // one, however readable it is. See heldReadingIsNewer.
    const olderSnapshot = heldReadingIsNewer(result, held?.result, held?.at);
    if (!result.error && !olderSnapshot) {
      if (isCurrent) quotaCache.set(account.id, {
        key,
        at: completedAt,
        lastAttemptAt: completedAt,
        lastError: result.fallbackReason ?? null,
        result,
      });
      // Shared with the CLI (and through it Paperclip and the Slack bridge), so the
      // app's five-minute watch is the one caller that actually spends requests.
      writeSharedQuota(account.id, sharedQuotaKey(account.provider, account.home), result, completedAt);
      return { ...result, observedAt: completedAt, cached: false };
    }
    // A failed forced refresh must not erase the last known good reading. It is still
    // re-served for display, but past the staleness bound it stops claiming to be a
    // current one: decisions read stale as unreadable, which is the honest answer
    // while the endpoint is failing. Without the bound the tray was the one reader
    // with no age limit at all (the CLI has the shared five-minute window and the
    // Desktop sample carries its own), so an outage could hold a reading current for
    // hours and let the watch move the default on percentages that had moved on.
    // An outright failure keeps only what memory holds, as it always has; an older
    // snapshot also gives way to the shared reading, which heldReadingIsNewer has
    // already matched to the same account.
    const keep = result.error ? (hit?.result ? held : null) : held;
    if (keep) {
      const refreshError = result.error ?? result.fallbackReason ?? 'unavailable';
      if (isCurrent) quotaCache.set(account.id, { key, at: keep.at, lastAttemptAt: completedAt, lastError: refreshError, result: keep.result });
      const aged = completedAt - keep.at > DESKTOP_STALE_MS;
      return { ...keep.result, observedAt: keep.at, cached: true, refreshError, ...(aged ? { stale: true } : {}) };
    }
    if (isCurrent) quotaCache.set(account.id, { key, at: null, lastAttemptAt: completedAt, lastError: result.error, result: null });
    return result;
  })();
  flight = { key, pending };
  quotaInflight.set(account.id, flight);
  try {
    return await pending;
  } finally {
    if (quotaInflight.get(account.id) === flight) quotaInflight.delete(account.id);
  }
}

ipcMain.handle('sb:quota', async (_e, accountId, force = false) => {
  const account = registry().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account: ${accountId}`);
  if (!PROVIDERS[account.provider]?.quota) return { error: 'unsupported' };
  const result = await cachedQuota(account, force === true);
  // The Accounts page already paid for this reading. Hand it to the tooltip immediately
  // rather than waiting for the next cache-only tray pass or asking the provider again.
  trayFacts.quotas = { ...trayFacts.quotas, [account.id]: result };
  refreshTray();
  return result;
});

ipcMain.handle('sb:setUsageSource', async (_e, accountId) => {
  const account = registry().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account: ${accountId}`);
  const picked = await dialog.showOpenDialog(win, {
    title: 'Choose the Claude Desktop profile folder for this account (it contains plan-usage-history.json)',
    defaultPath: process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude') : undefined,
    properties: ['openDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false };
  const identity = readClaudeAccountIdentity(account.home);
  if (!identity?.organizationUuid) {
    return { ok: false, error: 'Switchboard cannot identify this Claude account well enough to match Desktop usage safely.' };
  }
  if (!desktopFallbackIsUnambiguous(account)) {
    return { ok: false, error: 'More than one registered Claude account belongs to this organization, so Desktop usage cannot be assigned to one card safely.' };
  }
  const usage = readDesktopUsage(picked.filePaths[0], Date.now(), identity.organizationUuid);
  if (usage.error) {
    return { ok: false, error: 'That folder has no Claude Desktop usage for this account.' };
  }
  const settings = loadSettings();
  settings.usageSources[accountId] = picked.filePaths[0];
  saveSettings(settings);
  quotaCache.delete(accountId);
  quotaInflight.delete(accountId);
  return { ok: true };
});

ipcMain.handle('sb:openExternal', (_e, url) => {
  if (!/^https:\/\//.test(url)) throw new Error('https URLs only');
  return shell.openExternal(url);
});

// ---- Self-update through the user's own gh login; see core/updatecheck.js ----

ipcMain.handle('sb:updateCheck', () => {
  return checkAppUpdate({ repo: effectiveUpdateRepo(), currentVersion: app.getVersion() });
});

ipcMain.handle('sb:updateRun', async (_e, tag, assetUrl) => {
  let lastSent = 0;
  const exe = await downloadUpdate({
    repo: effectiveUpdateRepo(),
    tag,
    assetUrl,
    dir: app.getPath('temp'),
    onProgress: (received, total) => {
      const now = Date.now();
      if (now - lastSent < 200 && received !== total) return; // do not flood the renderer
      lastSent = now;
      win?.webContents.send('sb:updateProgress', { received, total });
    },
  });
  // The installer is not allowed to start unless the current configuration has
  // landed safely on disk in the same importable format as a manual export.
  const backupPath = saveRecoveryConfig('before-upgrade');
  // A short hold so the "restarting" state is legible even on a connection fast
  // enough to finish the download in a blink; then the installer closes the app,
  // upgrades in place, and relaunches.
  win?.webContents.send('sb:updateProgress', { received: 1, total: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  setTimeout(() => {
    quitting = true;
    if (tray) {
      try { tray.destroy(); } catch {}
      tray = null;
    }
    app.quit();
  }, 400);
  return { ok: true, backupPath };
});

ipcMain.handle('sb:getUpdateRepo', () => effectiveUpdateRepo());

ipcMain.handle('sb:setUpdateRepo', (_e, slug) => {
  if (slug !== null && !validRepoSlug(slug)) throw new Error('use the owner/name form');
  const settings = loadSettings();
  settings.updateRepo = slug;
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:getLanes', () => {
  const settings = loadSettings();
  return { lanes: settings.lanes, spendPolicies: settings.spendPolicies };
});

// The lane rules live in core so a lane added here and a lane added from a terminal are
// the same shape, checked the same way. The renderer sends the account and the billing;
// which harness and vendor that implies is not its decision to make.
// Each lane change ends with refresh(): whether a tool has lanes decides whether the tray
// and the Accounts page offer to switch its account by hand (see defaultFollowsLanes), so
// both are redrawn at once rather than at the next watch pass.
ipcMain.handle('sb:addLane', async (_e, wanted) => {
  try {
    const accounts = await resolveAllAccounts(registry());
    const { settings, lane } = addLane(loadSettings(), wanted, accounts);
    saveSettings(settings);
    refresh();
    return { ok: true, lane };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:removeLane', (_e, laneId) => {
  try {
    saveSettings(removeLane(loadSettings(), laneId));
    refresh();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:updateLaneOrder', (_e, laneIds) => {
  saveSettings(reorderLanes(loadSettings(), laneIds));
  refresh();
  return { ok: true };
});

ipcMain.handle('sb:setLaneBudget', (_e, laneId, budget) => {
  try {
    saveSettings(setLaneBudget(loadSettings(), laneId, budget));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:notifySettings', () => {
  const s = loadSettings();
  return {
    webhookUrl: s.notifyWebhookUrl,
    command: s.notifyCommand,
    thresholds: s.thresholds,
  };
});

ipcMain.handle('sb:setNotifySettings', (_e, { webhookUrl, command, thresholds } = {}) => {
  const s = loadSettings();
  if (webhookUrl !== undefined) {
    if (!webhookUrl || !webhookUrl.trim() || webhookUrl.trim().toLowerCase() === 'none') {
      s.notifyWebhookUrl = null;
    } else {
      try {
        const u = new URL(webhookUrl.trim());
        if (u.protocol === 'http:' || u.protocol === 'https:') s.notifyWebhookUrl = u.href;
      } catch {}
    }
  }
  if (command !== undefined) {
    if (!command || !command.trim() || command.trim().toLowerCase() === 'none') {
      s.notifyCommand = null;
    } else {
      s.notifyCommand = command.trim();
    }
  }
  if (thresholds && typeof thresholds === 'object') {
    s.thresholds = { ...s.thresholds, ...thresholds };
  }
  saveSettings(s);
  return { ok: true };
});

ipcMain.handle('sb:testNotify', async () => {
  const s = loadSettings();
  const payload = buildNotificationPayload({
    kind: 'test',
    event: 'test_notification',
    provider: 'claude',
    accountId: 'test',
    accountLabel: 'Test Account',
    window: 'session',
    windowLabel: 'Session (5h)',
    usedPercent: 82,
    threshold: s.thresholds?.session ?? 80,
    resetsAt: Date.now() + 2 * 3600 * 1000,
  });
  return dispatchNotification(s, payload);
});

ipcMain.handle('sb:gatewayState', async () => {
  return gatewayServer.status();
});

ipcMain.handle('sb:gatewayToggle', async (_e, enabled) => {
  try {
    const s = loadSettings();
    const gw = normalizeGatewaySettings(s.gateway);
    gw.enabled = Boolean(enabled);
    s.gateway = gw;
    saveSettings(s);
    const status = gw.enabled ? await gatewayServer.start() : await gatewayServer.stop();
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:gatewaySetScope', async (_e, scope) => {
  try {
    const clean = normalizeGatewayScope(scope);
    const s = loadSettings();
    const gw = normalizeGatewaySettings(s.gateway);
    gw.scope = clean;
    s.gateway = gw;
    saveSettings(s);
    const status = gatewayServer.isRunning() || gw.enabled
      ? await gatewayServer.start({ scope: clean })
      : await gatewayServer.status();
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:gatewaySetPort', async (_e, port) => {
  try {
    const clean = normalizeGatewayPort(port);
    const s = loadSettings();
    const gw = normalizeGatewaySettings(s.gateway);
    gw.port = clean;
    s.gateway = gw;
    saveSettings(s);
    const status = gatewayServer.isRunning() || gw.enabled
      ? await gatewayServer.start({ port: clean })
      : await gatewayServer.status();
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:gatewayCreateKey', async (_e, { label, scope } = {}) => {
  try {
    const { settings, key, secret } = createGatewayKey(loadSettings(), { label, scope });
    saveSettings(settings);
    // Every scope, `lan` included: a LAN gateway's own WSL distros and local callers use
    // the same key file and wrapper, and leaving them out made a `lan` key a hand install.
    let provisioned = null;
    try {
      provisioned = await provisionLocalAndWslClient({
        token: secret,
        leaseScriptPath: path.join(here, '..', 'bin', 'switchboard-lease'),
      });
    } catch {
      provisioned = null;
    }
    const status = await gatewayServer.status();
    return { ok: true, key, secret, provisioned, status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:gatewayInstallClient', async (_e, keyId = null) => {
  try {
    const settings = loadSettings();
    const map = settings?.gatewayKeys ?? {};
    const entries = Object.values(map).filter((e) => e && typeof e.token === 'string' && !e.unreadable);
    const target = keyId ? map[keyId] : entries[0];
    if (!target || typeof target.token !== 'string') {
      return { ok: false, error: 'No active client key found. Generate a client key first.' };
    }
    const res = await provisionLocalAndWslClient({
      token: target.token,
      leaseScriptPath: path.join(here, '..', 'bin', 'switchboard-lease'),
    });
    return { ...res, keyLabel: target.label };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:gatewayUpdateKey', async (_e, { keyId, label, scope } = {}) => {
  try {
    const { settings, key } = updateGatewayKey(loadSettings(), keyId, { label, scope });
    saveSettings(settings);
    const status = await gatewayServer.status();
    return { ok: true, key, status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle('sb:gatewayRevokeKey', async (_e, keyId) => {
  try {
    const next = revokeGatewayKey(loadSettings(), keyId);
    saveSettings(next);
    const status = await gatewayServer.status();
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

// T3 Code environments (Gateway tab). The tray and the `switchboard t3` command share
// core/t3env-run.js; one setup runs at a time, shared with the start-up refresh.
ipcMain.handle('sb:t3EnvState', async () => {
  try {
    return { ok: true, environments: currentT3Status(), distros: await wslDistrosCached() };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});
ipcMain.handle('sb:t3EnvSetup', async (_e, { targets = [], replaceSymlink = false } = {}) => {
  const lines = [];
  try {
    const res = await withT3Lock(async () => {
      const resolved = await resolveT3Targets(Array.isArray(targets) ? targets.map(String) : []);
      if (!resolved.length) return { ok: false, error: 'No environment to set up.' };
      const reports = await runT3Setup(resolved, { replaceSymlink: Boolean(replaceSymlink), onProgress: (l) => lines.push(l) });
      return { ok: reports.every((r) => r.ok), reports, lines };
    });
    if (res.busy) return { ok: false, error: 'A setup is already running.' };
    return res.value;
  } catch (e) {
    return { ok: false, error: String(e.message || e), lines };
  }
});
ipcMain.handle('sb:t3EnvForget', async (_e, targetId) => {
  try {
    forgetT3(String(targetId));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
});

ipcMain.handle('sb:openPath', (_e, p) => shell.openPath(p));
