import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRegistry, saveRegistry, addAccount, removeAccount, renameAccount, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, PROVIDERS } from '../core/accounts.js';
import { detectAll, detectToolById, checkAllUpdates, uninstallCmdFor, installCmdFor, TOOLS } from '../core/providers.js';
import { runChecks } from '../core/doctor.js';
import { accountQuota } from '../core/quota.js';
import { applyFix } from '../core/fixes.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { detectApps, getStartApps, launchApp, antigravityPresence, APPS } from '../core/apps.js';
import { detectPresence } from '../core/presence.js';
import { snapshotQuotas, decideDefaultSwitch } from '../core/watch.js';
import { readUserEnv, readMachineEnv } from '../core/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
let win = null;
let tray = null;
let quitting = false;

// One instance only: a second launch fronts the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
}

app.setAppUserModelId('io.switchboard.app');

function registry() {
  return loadRegistry();
}

function stateSnapshot() {
  const reg = registry();
  const providers = {};
  for (const p of Object.values(PROVIDERS)) {
    providers[p.id] = {
      id: p.id,
      name: p.name,
      envVar: p.envVar,
      activeAccountId: activeAccount(reg, p.id)?.id ?? null,
      activeHome: activeHome(p.id),
    };
  }
  return { accounts: reg.accounts, providers, version: app.getVersion() };
}

function showWindow(hash = '') {
  if (!win) createWindow();
  if (hash) win.webContents.send('sb:navigate', hash);
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 452,
    height: 780,
    minWidth: 420,
    minHeight: 560,
    autoHideMenuBar: true,
    icon: path.join(here, '..', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  win.loadFile(path.join(here, 'ui', 'index.html'));
  // Close hides to the tray; Quit lives in the tray menu.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => { win = null; });
}

function buildTrayMenu() {
  const reg = registry();
  const items = [];
  for (const p of Object.values(PROVIDERS)) {
    const accounts = reg.accounts.filter((a) => a.provider === p.id);
    if (accounts.length === 0) continue;
    const active = activeAccount(reg, p.id);
    items.push({ label: p.name, enabled: false });
    for (const a of accounts) {
      items.push({
        label: a.label,
        type: 'radio',
        checked: active?.id === a.id,
        click: () => {
          try {
            setActive(reg, a.id);
            refresh();
          } catch (e) {
            dialog.showErrorBox('Switch failed', String(e.message || e));
          }
        },
      });
    }
    items.push({ type: 'separator' });
  }
  items.push({ label: 'Open Switchboard', click: () => showWindow() });
  items.push({ label: 'Run health checks', click: () => showWindow('health') });
  const settings = loadSettings();
  items.push({
    label: 'Quota watch',
    submenu: [
      { label: 'Off', type: 'radio', checked: settings.quotaWatch === 'off', click: () => setWatchMode('off') },
      { label: 'Notify when the default runs out', type: 'radio', checked: settings.quotaWatch === 'notify', click: () => setWatchMode('notify') },
      { label: 'Switch the default automatically', type: 'radio', checked: settings.quotaWatch === 'auto', click: () => setWatchMode('auto') },
    ],
  });
  items.push({
    label: 'Start with Windows',
    type: 'checkbox',
    checked: app.getLoginItemSettings().openAtLogin,
    click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
  });
  items.push({ type: 'separator' });
  items.push({ label: 'Quit', click: () => { quitting = true; app.quit(); } });
  return Menu.buildFromTemplate(items);
}

function trayTooltip() {
  const reg = registry();
  const parts = [];
  for (const p of Object.values(PROVIDERS)) {
    const a = activeAccount(reg, p.id);
    if (a) parts.push(`${p.name}: ${a.label}`);
  }
  return parts.length ? `Switchboard\n${parts.join('\n')}` : 'Switchboard';
}

function refresh() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(trayTooltip());
  }
  if (win) win.webContents.send('sb:refresh');
}

function setWatchMode(mode) {
  const settings = loadSettings();
  settings.quotaWatch = mode;
  saveSettings(settings);
  refresh();
  if (mode !== 'off') runQuotaWatch();
}

let pinNotified = false;

/**
 * The quota watch. Reads every registered Claude account's usage, and when the
 * ACTIVE one is spent, suggests (or performs) a switch of the machine default for
 * new processes. Running processes are never touched; unknown quota is never acted on.
 */
async function runQuotaWatch() {
  try {
    const settings = loadSettings();
    if (settings.quotaWatch === 'off') return;
    const reg = registry();
    const active = activeAccount(reg, 'claude');
    const snapshots = await snapshotQuotas({ accounts: reg.accounts, usageSources: settings.usageSources });
    const pinPresent = Boolean(readUserEnv('CLAUDE_CODE_OAUTH_TOKEN') || readMachineEnv('CLAUDE_CODE_OAUTH_TOKEN'));
    const decision = decideDefaultSwitch({
      mode: settings.quotaWatch,
      accounts: reg.accounts,
      activeId: active?.id ?? null,
      snapshots,
      lastSwitchAt: settings.lastAutoSwitchAt,
      pinPresent,
    });

    if (decision.kind === 'pin-blocked') {
      if (!pinNotified) {
        pinNotified = true;
        new Notification({ title: 'Switchboard', body: 'The default account is out of quota, but a machine-wide Claude token pins billing to one account. Open Health to remove it; switching has no effect until then.' })
          .on('click', () => showWindow('health')).show();
      }
      return;
    }
    if (decision.kind === 'exhausted') {
      const when = decision.resetsAt ? ` Earliest reset: ${new Date(decision.resetsAt).toLocaleString()}.` : '';
      new Notification({ title: 'Switchboard', body: `Every readable Claude account is out of quota.${when}` }).show();
      return;
    }
    if (decision.kind === 'switch') {
      setActive(reg, decision.to);
      settings.lastAutoSwitchAt = Date.now();
      saveSettings(settings);
      refresh();
      new Notification({ title: 'Switchboard switched the default', body: `${decision.reason}. New terminals and apps now use it; running processes are unchanged.` }).show();
      return;
    }
    if (decision.kind === 'suggest') {
      const target = reg.accounts.find((a) => a.id === decision.to);
      new Notification({ title: 'Switchboard', body: `${decision.reason}. Click to switch new terminals to ${target?.label}.` })
        .on('click', () => {
          const fresh = registry();
          setActive(fresh, decision.to);
          const s = loadSettings();
          s.lastAutoSwitchAt = Date.now();
          saveSettings(s);
          refresh();
        })
        .show();
    }
  } catch { /* the watch must never take the app down; it tries again next tick */ }
}

app.whenReady().then(() => {
  // First run: register vendor folders that already exist, generically labeled.
  const reg = registry();
  const found = detectDefaults(reg);
  if (found.length) {
    for (const f of found) addAccount(reg, f);
    saveRegistry(reg);
  }

  const trayIcon = nativeImage.createFromPath(path.join(here, '..', 'assets', 'tray.png'));
  tray = new Tray(trayIcon);
  tray.setContextMenu(buildTrayMenu());
  tray.setToolTip(trayTooltip());
  tray.on('click', () => showWindow());

  createWindow();

  // Quota watch: first pass shortly after startup, then every five minutes.
  setTimeout(runQuotaWatch, 20 * 1000);
  setInterval(runQuotaWatch, 5 * 60 * 1000);
});

app.on('window-all-closed', () => { /* stay in the tray */ });
app.on('before-quit', () => { quitting = true; });

// ---- IPC: the renderer only ever talks to the core through these. ----

ipcMain.handle('sb:state', () => stateSnapshot());

ipcMain.handle('sb:setActive', (_e, id) => {
  const reg = registry();
  const account = setActive(reg, id);
  refresh();
  return { ok: true, account };
});

ipcMain.handle('sb:addAccount', async (_e, provider) => {
  const def = PROVIDERS[provider];
  if (!def) throw new Error(`unknown provider: ${provider}`);
  const picked = await dialog.showOpenDialog(win, {
    title: `Choose (or create) a config folder for a ${def.name} account`,
    defaultPath: path.dirname(def.defaultHome()),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (picked.canceled || !picked.filePaths[0]) return { ok: false };
  const home = picked.filePaths[0];
  const reg = registry();
  const account = addAccount(reg, { provider, label: path.basename(home), home });
  saveRegistry(reg);
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

ipcMain.handle('sb:removeAccount', (_e, id) => {
  const reg = registry();
  const removed = removeAccount(reg, id);
  saveRegistry(reg);
  refresh();
  return { ok: true, removed };
});

ipcMain.handle('sb:providers', () => detectAll());

ipcMain.handle('sb:updates', async () => checkAllUpdates(await detectAll()));

ipcMain.handle('sb:detectOne', (_e, toolId) => detectToolById(toolId));

ipcMain.handle('sb:candidates', () => detectCandidates(registry()));

ipcMain.handle('sb:register', (_e, candidate) => {
  const reg = registry();
  const account = addAccount(reg, candidate);
  saveRegistry(reg);
  refresh();
  return { ok: true, account };
});

ipcMain.handle('sb:fix', (_e, action, args) => {
  const result = applyFix(action, args);
  refresh();
  return result;
});

ipcMain.handle('sb:signin', (_e, accountId) => {
  const account = registry().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account: ${accountId}`);
  const def = PROVIDERS[account.provider];
  // A visible terminal with the account's folder preselected, so the vendor's own
  // login flow lands in the right home.
  const inner = account.provider === 'codex'
    ? `$env:${def.envVar}='${account.home}'; Write-Host 'Codex login for account: ${account.label}' -ForegroundColor Cyan; codex login`
    : `$env:${def.envVar}='${account.home}'; Write-Host 'Claude sign-in for account: ${account.label}. Use /login for interactive use, or run: claude setup-token (for automation tokens).' -ForegroundColor Cyan; claude`;
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', inner], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true };
});

ipcMain.handle('sb:install', (_e, toolId, mode = 'install') => {
  const tool = TOOLS.find((t) => t.id === toolId);
  if (!tool) throw new Error(`unknown tool: ${toolId}`);
  const cmd = installCmdFor(tool, mode);
  if (!cmd) throw new Error(`${tool.name} has no automated ${mode}; use the vendor site`);
  // Vendor installers run in a visible terminal the user can watch and answer.
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', cmd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  }).unref();
  return { ok: true, cmd };
});

ipcMain.handle('sb:doctor', () => runChecks({ accounts: registry().accounts }));

ipcMain.handle('sb:apps', async () => {
  const startApps = await getStartApps();
  const builtin = detectApps(startApps);
  const custom = loadSettings().customApps.map((c) => ({ id: `custom:${c.appId}`, name: c.label, installed: true, appId: c.appId, exePath: null, custom: true }));
  return [...builtin, ...custom];
});

ipcMain.handle('sb:appLaunch', async (_e, id) => {
  if (id.startsWith('custom:')) {
    return { ok: launchApp({ appId: id.slice('custom:'.length) }) };
  }
  const detected = detectApps(await getStartApps()).find((a) => a.id === id);
  if (!detected?.installed) throw new Error('not installed');
  return { ok: launchApp(detected) };
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

ipcMain.handle('sb:antigravity', () => antigravityPresence());

ipcMain.handle('sb:presence', () => detectPresence());

ipcMain.handle('sb:openTerminal', (_e, bin) => {
  if (!['claude', 'codex', 'agy', 'junie', 'copilot', 'gemini'].includes(bin)) throw new Error('unknown terminal target');
  // Inherits the machine defaults, which is the whole point: the terminal opens on
  // whatever account is currently active.
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', bin], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  return { ok: true };
});

ipcMain.handle('sb:quota', (_e, accountId) => {
  const account = registry().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account: ${accountId}`);
  if (account.provider !== 'claude') return { error: 'unsupported' };
  const settings = loadSettings();
  return accountQuota(account.home, fetch, settings.usageSources[accountId] ?? null);
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
  const settings = loadSettings();
  settings.usageSources[accountId] = picked.filePaths[0];
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:openExternal', (_e, url) => {
  if (!/^https:\/\//.test(url)) throw new Error('https URLs only');
  return shell.openExternal(url);
});

ipcMain.handle('sb:openPath', (_e, p) => shell.openPath(p));
