import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification, screen } from 'electron';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRegistry, saveRegistry, addAccount, removeAccount, renameAccount, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, PROVIDERS } from '../core/accounts.js';
import { detectAll, detectInstalled, detectToolById, checkAllUpdates, uninstallCmdFor, installCmdFor, TOOLS } from '../core/providers.js';
import { runChecks } from '../core/doctor.js';
import { accountQuota } from '../core/quota.js';
import { applyFix } from '../core/fixes.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { detectApps, getStartApps, launchApp, orderApps, antigravityPresence, APPS } from '../core/apps.js';
import { detectPresence } from '../core/presence.js';
import { terminalRows, terminalChips } from '../core/terminals.js';
import { checkAppUpdate, downloadUpdate, validRepoSlug } from '../core/updatecheck.js';
import { CLIENTS as MCP_CLIENTS, allServers, yourServers, browseServers, searchCatalog, categoriesOf, loadServers, saveServers, addServer, removeServer, registerServer, unregisterServer, listRegistered, clientAvailable, registrationMatrix } from '../core/mcp.js';
import { createRequire } from 'node:module';

// CI stamps updateRepo into the packaged package.json (extraMetadata); the committed
// source carries no repository name. Local settings, when set, win over the stamp.
const pkgMeta = createRequire(import.meta.url)('../package.json');
function effectiveUpdateRepo() {
  return loadSettings().updateRepo ?? pkgMeta.updateRepo ?? null;
}
import { decideDefaultSwitch } from '../core/watch.js';
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
    autoHideMenuBar: true,
    icon: path.join(here, '..', 'assets', 'icon-256.png'),
    webPreferences: {
      preload: path.join(here, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
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
  items.push({ label: 'About Switchboard', click: () => showWindow('about') });
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
    // The watch shares the render cache, so it never burns the rate-limit allowance.
    const snapshots = {};
    for (const a of reg.accounts.filter((x) => x.provider === 'claude')) {
      snapshots[a.id] = await cachedQuota(a);
    }
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

  // Update check: shortly after startup, then twice a day. Renderer shows the button.
  const updateCheck = async () => {
    try {
      const r = await checkAppUpdate({ repo: effectiveUpdateRepo(), currentVersion: app.getVersion() });
      if (r.available) win?.webContents.send('sb:updateAvailable', { tag: r.tag, assetUrl: r.assetUrl ?? null });
    } catch { /* checked again next interval */ }
  };
  setTimeout(updateCheck, 30 * 1000);
  setInterval(updateCheck, 12 * 60 * 60 * 1000);
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

/**
 * MCP servers. Switchboard keeps the definition (a name and an https url) and asks each
 * client's own CLI to register it. No token passes through here and nothing is proxied:
 * every client still signs in for itself and keeps its own credentials.
 */
ipcMain.handle('sb:mcpState', async () => {
  const reg = loadServers();
  const clients = await Promise.all(
    Object.values(MCP_CLIENTS).map(async (c) => ({
      id: c.id,
      name: c.name,
      available: await clientAvailable(c.id),
      // File-edited clients can always undo; CLI-driven ones only if they ship a remove verb.
      canRemove: c.via === 'file' || Boolean(c.removeArgs),
      canList: Boolean(c.listArgs),
      // Whether this client can say if a server is actually signed in, or only registered.
      reportsAuth: Boolean(c.authFile && c.parseAuth),
      site: c.site ?? null,
    })),
  );
  // Only ask about clients that are actually here; reading a config for a tool that is
  // not installed would report nothing anyway and just muddies the panel.
  const usable = clients.filter((c) => c.available).map((c) => c.id);
  return { servers: registrationMatrix(yourServers(reg, usable), usable), local: reg.servers, clients };
});

/** The browse screen: the whole catalogue, filtered, with the categories to filter by. */
ipcMain.handle('sb:mcpBrowse', async (_e, { query = '', category = '' } = {}) => {
  const reg = loadServers();
  const all = browseServers(reg);
  const usable = (await Promise.all(
    Object.values(MCP_CLIENTS).map(async (c) => ((await clientAvailable(c.id)) ? c.id : null)),
  )).filter(Boolean);
  const matched = searchCatalog(all, { query, category });
  return {
    total: all.length,
    matched: matched.length,
    categories: categoriesOf(all),
    // Cap what crosses the wire; nobody scrolls past this, and the search box is right there.
    servers: registrationMatrix(matched.slice(0, 60), usable),
  };
});

ipcMain.handle('sb:mcpAdd', (_e, { name, url, label }) => {
  const reg = loadServers();
  const server = addServer(reg, { name, url, label });
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
// here from the catalogue or the local registry, so a renderer cannot invent one.
function resolveServer(name) {
  const found = allServers(loadServers()).find((s) => s.name === name);
  if (!found) throw new Error(`no such server: ${name}`);
  return found;
}

ipcMain.handle('sb:mcpRegister', (_e, clientId, name) => registerServer(clientId, resolveServer(name)));

ipcMain.handle('sb:mcpUnregister', (_e, clientId, name) => unregisterServer(clientId, resolveServer(name)));

ipcMain.handle('sb:mcpList', (_e, clientId) => listRegistered(clientId));

ipcMain.handle('sb:apps', async () => {
  const startApps = await getStartApps();
  const settings = loadSettings();
  const builtin = detectApps(startApps);
  const custom = settings.customApps.map((c) => ({ id: `custom:${c.appId}`, name: c.label, installed: true, appId: c.appId, exePath: null, custom: true }));
  return orderApps([...builtin, ...custom], settings.appOrder);
});

ipcMain.handle('sb:setAppOrder', (_e, ids) => {
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new Error('order must be a list of app ids');
  const settings = loadSettings();
  settings.appOrder = ids;
  saveSettings(settings);
  return { ok: true };
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

ipcMain.handle('sb:terminals', async () => {
  const activeHomes = {};
  for (const id of Object.keys(PROVIDERS)) activeHomes[id] = activeHome(id);
  const rows = terminalRows({ tools: await detectInstalled(), accounts: registry().accounts, activeHomes });
  return terminalChips(rows);
});

ipcMain.handle('sb:openTerminal', (_e, bin, accountId = null) => {
  // Only a bin from the tool table can ever be run, and only an account that belongs
  // to that tool: the renderer names things, it never supplies a command or a path.
  const tool = TOOLS.find((t) => t.bin === bin);
  if (!tool) throw new Error('unknown terminal target');
  // No account named: inherit the machine defaults, so the terminal opens on whatever
  // account is currently active. Named: point THIS terminal at that account's folder
  // through its own environment, leaving the machine default alone.
  const env = { ...process.env };
  if (accountId) {
    const account = registry().accounts.find((a) => a.id === accountId);
    if (!account) throw new Error(`no such account: ${accountId}`);
    if (account.provider !== tool.id) throw new Error(`${account.label} is not a ${tool.name} account`);
    env[PROVIDERS[account.provider].envVar] = account.home;
  }
  spawn('cmd.exe', ['/c', 'start', 'powershell', '-NoExit', '-Command', bin], { detached: true, stdio: 'ignore', windowsHide: false, env }).unref();
  return { ok: true };
});

/**
 * Quota cache. The usage endpoint rate-limits per token aggressively, so the app
 * asks at most once per account per interval and otherwise serves the last good
 * answer (marked stale) rather than burning the allowance on every render.
 */
const QUOTA_TTL_MS = 90 * 1000;
const quotaCache = new Map(); // accountId -> { at, result }

async function cachedQuota(account) {
  const hit = quotaCache.get(account.id);
  const now = Date.now();
  if (hit && now - hit.at < QUOTA_TTL_MS) return { ...hit.result, staleAt: hit.at };
  const settings = loadSettings();
  const result = await accountQuota(account.home, fetch, settings.usageSources[account.id] ?? null);
  if (!result.error) {
    quotaCache.set(account.id, { at: now, result });
    return result;
  }
  // Old truth labeled as such beats a fresh shrug.
  if (hit) return { ...hit.result, staleAt: hit.at };
  return result;
}

ipcMain.handle('sb:quota', (_e, accountId) => {
  const account = registry().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account: ${accountId}`);
  if (account.provider !== 'claude') return { error: 'unsupported' };
  return cachedQuota(account);
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
  // A short hold so the "restarting" state is legible even on a connection fast
  // enough to finish the download in a blink; then the installer closes the app,
  // upgrades in place, and relaunches.
  win?.webContents.send('sb:updateProgress', { received: 1, total: 1 });
  await new Promise((resolve) => setTimeout(resolve, 1000));
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  return { ok: true };
});

ipcMain.handle('sb:getUpdateRepo', () => effectiveUpdateRepo());

ipcMain.handle('sb:setUpdateRepo', (_e, slug) => {
  if (slug !== null && !validRepoSlug(slug)) throw new Error('use the owner/name form');
  const settings = loadSettings();
  settings.updateRepo = slug;
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:openPath', (_e, p) => shell.openPath(p));
