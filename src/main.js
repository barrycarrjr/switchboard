import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadRegistry, saveRegistry, addAccount, removeAccount, renameAccount, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, normalizeHome, accountScopedEnv, configuredClaudeCredentialOverrides, PROVIDERS } from '../core/accounts.js';
import { detectAll, detectInstalled, detectToolById, checkAllUpdates, uninstallCmdFor, installCmdFor, toolExecutable, TOOLS } from '../core/providers.js';
import { runChecks, accountLoginState, verifiedAccountLoginState } from '../core/doctor.js';
import { providerQuota, readClaudeAccountIdentity, readDesktopUsage } from '../core/quota.js';
import { applyFix } from '../core/fixes.js';
import { signinTerminal } from '../core/signin.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { detectApps, getStartApps, launchApp, orderApps, antigravityPresence, resolvePackagedExe, APPS } from '../core/apps.js';
import { appProfileDef, chooseOpenProfile, describeProfiles, discoverProfileDirs, profileFolderProblem, profileLaunchArgs } from '../core/appprofiles.js';
import { detectPresence } from '../core/presence.js';
import { terminalRows, terminalChips } from '../core/terminals.js';
import { checkAppUpdate, downloadUpdate, validRepoSlug } from '../core/updatecheck.js';
import { CLIENTS as MCP_CLIENTS, activeServers, browseServers, resolveServerByName, searchCatalog, categoriesOf, loadServers, saveServers, addServer, removeServer, registerServer, unregisterServer, listRegistered, clientAvailable, registrationMatrix } from '../core/mcp.js';
import { createRequire } from 'node:module';

// CI stamps updateRepo into the packaged package.json (extraMetadata); the committed
// source carries no repository name. Local settings, when set, win over the stamp.
const pkgMeta = createRequire(import.meta.url)('../package.json');
function effectiveUpdateRepo() {
  return loadSettings().updateRepo ?? pkgMeta.updateRepo ?? null;
}
import { decideDefaultSwitch } from '../core/watch.js';
import { accountNote, trayModel } from '../core/tray.js';
import { readUserEnv, readMachineEnv } from '../core/env.js';
import { dataDir, samePath, writeJsonAtomic } from '../core/paths.js';
import { configSummary, createSwitchboardConfig, parseSwitchboardConfig, settingsFromConfig } from '../core/config.js';

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

function currentConfig() {
  const reg = registry();
  const activeAccounts = {};
  for (const provider of Object.keys(PROVIDERS)) {
    const active = activeAccount(reg, provider);
    if (active) activeAccounts[provider] = active.id;
  }
  return createSwitchboardConfig({
    registry: reg,
    settings: loadSettings(),
    mcp: loadServers(),
    activeAccounts,
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
  const providers = {};
  for (const p of Object.values(PROVIDERS)) {
    providers[p.id] = {
      id: p.id,
      name: p.name,
      envVar: p.envVar,
      activeAccountId: activeAccount(reg, p.id)?.id ?? null,
      activeHome: activeHome(p.id),
      hasQuota: Boolean(p.quota),
      quotaNote: p.quotaNote ?? null,
      note: p.note ?? null,
      usageUrl: p.usageUrl ?? null,
    };
  }
  // Login state travels with each account so the Accounts page can say why its
  // sign-in link is there, rather than offering it identically in every state.
  const accounts = await Promise.all(reg.accounts.map(async (a) => ({
    ...a,
    login: await cachedLoginState(a, a.id === forceAuthAccountId),
  })));
  return { accounts, providers, version: app.getVersion() };
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

/**
 * What the tray shows that cannot be read without waiting.
 *
 * Building a menu is synchronous, and finding the installed CLIs or reading a sign-in
 * means spawning processes, so the menu reads this and never fetches. It is refreshed at
 * startup and at the end of every quota-watch pass, which is also when the account
 * readings it reports were taken.
 */
let trayFacts = { terminals: [], alsoSignedIn: [], notes: {}, update: null };

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
    }
    trayFacts.alsoSignedIn = rows;
  } catch (e) {
    console.error('refreshTrayFacts error', e);
  } finally {
    factsInFlight = false;
  }
  refresh();
}

/**
 * The tray menu: `core/tray.js` decides what it says, this turns each row into a menu
 * item and attaches what it does.
 */
function buildTrayMenu() {
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

  const rows = trayModel({
    providers: Object.values(PROVIDERS),
    accounts: reg.accounts,
    activeIds,
    notes: trayFacts.notes,
    alsoSignedIn: trayFacts.alsoSignedIn,
    terminals: trayFacts.terminals,
    watchMode: settings.quotaWatch,
    overrideBlocking: configuredClaudeOverrides().length > 0,
    strandedProviders: stranded,
    update: trayFacts.update,
    startWithWindows: app.getLoginItemSettings().openAtLogin,
  });

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
          click: () => switchDefaultTo(row.accountId),
        };
      case 'submenu':
        return {
          label: row.label,
          submenu: row.items.map((item) => ({
            label: item.label,
            click: () => openTerminal(item.bin, item.accountId),
          })),
        };
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
            : () => open(row.action),
        };
    }
  });
  return Menu.buildFromTemplate(items);
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
    setActive(registry(), accountId);
    refresh();
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

function trayTooltip() {
  const reg = registry();
  const parts = [];
  for (const p of Object.values(PROVIDERS)) {
    const a = activeAccount(reg, p.id);
    if (a) parts.push(`${p.name}: ${a.label}`);
  }
  return parts.length ? `Switchboard\n${parts.join('\n')}` : 'Switchboard';
}

let factsSignature = null;
let factsInFlight = false;

/** Which accounts exist, cheaply, so a change to them can be noticed. */
function accountSignature() {
  return registry().accounts.map((a) => `${a.id}:${a.home}`).sort().join('|');
}

function refresh() {
  if (tray) {
    tray.setContextMenu(buildTrayMenu());
    tray.setToolTip(trayTooltip());
  }
  if (win) win.webContents.send('sb:refresh');
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
  refresh();
  if (mode !== 'off') runQuotaWatch();
}

let pinNotified = false;

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
    if (settings.quotaWatch === 'off') return;
    const reg = registry();

    // The watch shares the render cache, so it never burns the rate-limit allowance.
    const snapshots = {};
    const loginStates = {};

    // Only fetch for Claude or accounts that are actually in lanes to avoid spamming
    const providersToFetch = new Set(['claude']);
    settings.lanes.forEach(l => providersToFetch.add(l.harness));

    await Promise.all(reg.accounts.filter((x) => providersToFetch.has(x.provider)).map(async (a) => {
      [snapshots[a.id], loginStates[a.id]] = await Promise.all([
        cachedQuota(a),
        cachedLoginState(a),
      ]);
    }));

    // The watch has just read sign-in and usage for these accounts; the menu says what
    // they mean, without a reading of its own.
    const notes = {};
    for (const a of reg.accounts) {
      if (!(a.id in loginStates) && !(a.id in snapshots)) continue;
      notes[a.id] = accountNote(loginStates[a.id], snapshots[a.id]);
    }
    trayFacts.notes = notes;

    const pinPresent = configuredClaudeOverrides().length > 0;

    // Unify decision: per provider
    // If lanes exist, use lanes as absolute priority. If no lanes, fallback to legacy Claude logic.
    let switchDecisions = [];
    const providers = new Set(reg.accounts.map(a => a.provider));
    
    for (const p of providers) {
      const active = activeAccount(reg, p);
      const providerLanes = settings.lanes.filter(l => l.harness === p);
      
      if (providerLanes.length > 0) {
        // Lane-driven routing
        const { selectLane, worthSwitchingTo } = await import('../core/lanes.js');
        const context = {
          now: Date.now(),
          loginStates,
          quotas: snapshots,
          spendPolicies: settings.spendPolicies,
          cooldowns: settings.cooldowns,
          requirements: { harness: p }
        };
        const selected = selectLane(providerLanes, context);

        // Only a lane we can actually vouch for may take over the machine default. A
        // last-resort lane is one whose usage could not be read, and pointing every new
        // terminal on the machine at an account on that basis is far more than the one
        // run the last-resort slot was meant to cover.
        if (worthSwitchingTo(selected) && active && selected.lane.accountId !== active.id) {
          // The top healthy lane doesn't match the current active default. Switch it.
          if (p === 'claude' && pinPresent) {
             switchDecisions.push({ kind: 'pin-blocked', provider: p });
          } else {
             const activeLane = providerLanes.find(l => l.accountId === active.id);
             // Avoid rapid switching if recently switched
             if (Date.now() - settings.lastAutoSwitchAt > (10 * 60 * 1000)) {
               switchDecisions.push({ 
                 kind: settings.quotaWatch === 'auto' ? 'switch' : 'suggest',
                 provider: p,
                 to: selected.lane.accountId,
                 from: active.id,
                 reason: `Lane priority dictates ${selected.lane.id} is the highest healthy ${p} account`
               });
             }
          }
        }
      } else if (p === 'claude') {
        // Legacy Claude-only logic when no lanes configured
        const decision = decideDefaultSwitch({
          mode: settings.quotaWatch,
          accounts: reg.accounts,
          activeId: active?.id ?? null,
          snapshots,
          loginStates,
          lastSwitchAt: settings.lastAutoSwitchAt,
          pinPresent,
        });
        if (decision.kind !== 'none') {
           decision.provider = 'claude';
           switchDecisions.push(decision);
        }
      }
    }

    for (const decision of switchDecisions) {
      if (decision.kind === 'pin-blocked') {
        if (!pinNotified) {
          pinNotified = true;
          new Notification({ title: 'Switchboard', body: `The default ${decision.provider} account is out of quota, but a machine-wide authentication override makes folder switching unreliable. Open Health to inspect it.` })
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
        settings.lastAutoSwitchAt = Date.now();
        saveSettings(settings);
        refresh();
        new Notification({ title: 'Switchboard switched the default', body: `${decision.reason}. New terminals and apps now use it; running processes are unchanged.` }).show();
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
app.on('before-quit', () => { quitting = true; });

// ---- IPC: the renderer only ever talks to the core through these. ----

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
  if (fs.statSync(filePath).size > 2 * 1024 * 1024) throw new Error('the selected config is too large');
  const imported = parseSwitchboardConfig(fs.readFileSync(filePath, 'utf8'));
  const summary = configSummary(imported);
  const answer = await dialog.showMessageBox(win, {
    type: 'warning',
    title: 'Import Switchboard configuration?',
    message: `Replace this machine's Switchboard configuration with ${path.basename(filePath)}?`,
    detail: `${summary.accounts} account registration(s), ${summary.customApps} custom app(s), and ${summary.mcpServers} custom MCP server(s) will be imported.\n\nThis does not copy, delete, or change vendor credential folders. MCP client registrations and sign-ins also remain untouched.`,
    buttons: ['Import', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    noLink: true,
  });
  if (answer.response !== 0) return { ok: false };

  // Keep a known-good, importable snapshot before changing any of the three data files.
  const backupPath = saveRecoveryConfig('before-import');

  const oldRegistry = registry();
  const oldSettings = loadSettings();
  const oldMcp = loadServers();
  const nextRegistry = { accounts: imported.accounts };
  const nextSettings = settingsFromConfig(imported, oldSettings);
  const nextMcp = { servers: imported.mcpServers };
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
  return { ok: true, filePath, backupPath, summary, warnings };
});

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

ipcMain.handle('sb:updates', async () => checkAllUpdates(await detectAll()));

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

ipcMain.handle('sb:fix', (_e, action, args) => {
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

ipcMain.handle('sb:doctor', async () => {
  const accounts = registry().accounts;
  const loginStates = {};
  await Promise.all(accounts.map(async (account) => {
    loginStates[account.id] = await cachedLoginState(account);
  }));
  return runChecks({ accounts, loginStates });
});

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
  return { servers: registrationMatrix(activeServers(reg, usable), usable), local: reg.servers, clients };
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
    // The catalogue ships with the application and is a few dozen rows, so it is sent
    // whole. It was once capped at sixty, which hid four servers behind a search box on a
    // screen whose whole job is to show what is available.
    servers: registrationMatrix(matched, usable),
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
// from the catalogue, the local registry, or the clients' own configs, so a renderer
// cannot invent one.
const resolveServer = (name) => resolveServerByName(name);

ipcMain.handle('sb:mcpRegister', (_e, clientId, name) => registerServer(clientId, resolveServer(name)));

ipcMain.handle('sb:mcpUnregister', (_e, clientId, name) => unregisterServer(clientId, resolveServer(name)));

ipcMain.handle('sb:mcpList', (_e, clientId) => listRegistered(clientId));

ipcMain.handle('sb:apps', async () => {
  const startApps = await getStartApps();
  const settings = loadSettings();
  // An installed app carries the accounts it can open on, so the panel can name the
  // one its button opens without a second round trip and a visible correction.
  const builtin = detectApps(startApps).map((a) => (a.installed ? { ...a, ...appProfilesFor(a.id) } : a));
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
    .map((a) => ({ id: a.id, label: a.label, organizationUuid: def.accountOrganization(a.home) }));
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
const QUOTA_TTL_MS = 90 * 1000;
const quotaCache = new Map(); // accountId -> { key, at, lastAttemptAt, result }
const quotaInflight = new Map(); // accountId -> { key, pending }

async function cachedQuota(account, force = false) {
  const key = accountCacheKey(account);
  const cached = quotaCache.get(account.id);
  const hit = cached?.key === key ? cached : null;
  const now = Date.now();
  const lastAttemptAt = hit?.lastAttemptAt ?? hit?.at ?? 0;
  if (!force && hit && now - lastAttemptAt < QUOTA_TTL_MS) {
    if (!hit.result) return { error: hit.lastError, cached: true, checkedAt: lastAttemptAt };
    return {
      ...hit.result,
      observedAt: hit.at,
      cached: true,
      ...(hit.lastError ? { refreshError: hit.lastError } : {}),
    };
  }
  const inFlight = quotaInflight.get(account.id);
  if (inFlight?.key === key) return inFlight.pending;

  let flight;
  const pending = (async () => {
    const settings = loadSettings();
    const reg = registry();
    const result = await providerQuota(account.provider, account.home, {
      usageSource: settings.usageSources[account.id] ?? null,
      allowDesktopFallback: desktopFallbackIsUnambiguous(account, reg.accounts),
    });
    const completedAt = Date.now();
    const isCurrent = quotaInflight.get(account.id) === flight;
    if (!result.error) {
      if (isCurrent) quotaCache.set(account.id, { key, at: completedAt, lastAttemptAt: completedAt, lastError: null, result });
      return { ...result, observedAt: completedAt, cached: false };
    }
    // A failed forced refresh must not erase the last known good reading.
    if (hit?.result) {
      if (isCurrent) quotaCache.set(account.id, { ...hit, key, lastAttemptAt: completedAt, lastError: result.error });
      return { ...hit.result, observedAt: hit.at, cached: true, refreshError: result.error };
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

ipcMain.handle('sb:quota', (_e, accountId, force = false) => {
  const account = registry().accounts.find((a) => a.id === accountId);
  if (!account) throw new Error(`no such account: ${accountId}`);
  if (!PROVIDERS[account.provider]?.quota) return { error: 'unsupported' };
  return cachedQuota(account, force === true);
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

ipcMain.handle('sb:addLane', (_e, lane) => {
  const settings = loadSettings();
  if (!lane.id) lane.id = `lane-${Date.now()}`;
  settings.lanes.push(lane);
  saveSettings(settings);
  return { ok: true, lane };
});

ipcMain.handle('sb:removeLane', (_e, laneId) => {
  const settings = loadSettings();
  settings.lanes = settings.lanes.filter(l => l.id !== laneId);
  delete settings.spendPolicies[laneId];
  delete settings.cooldowns[laneId];
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:updateLaneOrder', (_e, laneIds) => {
  const settings = loadSettings();
  const newLanes = [];
  for (const id of laneIds) {
    const found = settings.lanes.find(l => l.id === id);
    if (found) newLanes.push(found);
  }
  // Append any missing ones that were somehow omitted
  for (const l of settings.lanes) {
    if (!newLanes.some(n => n.id === l.id)) newLanes.push(l);
  }
  settings.lanes = newLanes;
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:setLaneBudget', (_e, laneId, budget) => {
  const settings = loadSettings();
  if (budget === null || budget === undefined) {
    delete settings.spendPolicies[laneId];
  } else {
    settings.spendPolicies[laneId] = { budget: Number(budget) };
  }
  saveSettings(settings);
  return { ok: true };
});

ipcMain.handle('sb:openPath', (_e, p) => shell.openPath(p));
