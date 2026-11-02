#!/usr/bin/env node
// The scriptable core. Everything the tray can do, headless.
import { spawn } from 'node:child_process';
import { loadRegistry, saveRegistry, addAccount, createAccount, envValueForHome, removeAccount, setAccountColor, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, normalizeHome, PROVIDERS, accountScopedEnv, configuredClaudeCredentialOverrides } from '../core/accounts.js';
import { detectAll, detectInstalled, TOOLS, toolExecutable } from '../core/providers.js';
import { runChecks, accountLoginState } from '../core/doctor.js';
import { lastSharedQuota, sharedProviderQuota } from '../core/quota-cache.js';
import { collectStatus, formatStatus } from '../core/status.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { addLane, removeLane, reorderLanes, setLaneBudget, unknownLaneIds, setLaneToken, removeLaneToken, BILLING_KINDS, resolveAllAccounts } from '../core/lane-admin.js';
import { laneTokenFor, laneTokenIdentityMatches, validateLaneTokens, mergeLaneTokenResults, extractSetupToken, probeSetupToken, laneTokenState, claudeLanesWithoutToken } from '../core/lane-tokens.js';
import { readClaudeAccountIdentity } from '../core/quota.js';
import { planDefaultSwitches, freshNotices } from '../core/watch.js';
import { readUserEnv, readMachineEnv } from '../core/env.js';
import { selectLaneAsNeeded, narrowPool, lanesCallerCannotDrive, selectionFailure, defaultFollowsLanes, switchedAgainstLanesNote, ordersBySoonestReset, ranksByReset } from '../core/lanes.js';
import { readHandoff, writeHandoff, fitHandoff, derivedHandoffData, removeHandoff, handoffOrigin, generateHandoffPrompt, generateHandoffNote } from '../core/handoff.js';
import { CARRYABLE_HARNESSES, callerManagesSession, namedSession, sessionToCarry, resumedSession, newSessionId, withSessionId, resumeArgs, carryTranscript, syncSessionInto, carryNote, sessionDigest, transcriptSupport } from '../core/transcripts.js';
import { parseRunArgs, loadRunSpec, resolveSpecArgv, drivableHarnesses, childStdio, childWindowsHide, parseLaneAddArgs, parseWatchArgs, parseNotifyArgs } from '../core/runargs.js';
import { checkThresholds, dispatchNotification, buildNotificationPayload, formatNotificationText, DEFAULT_THRESHOLDS, loadAlertMemory, saveAlertMemory } from '../core/hooks.js';
import { recordPipedInput } from '../core/piped-input.js';
import { matchT3Colors, readT3Instances } from '../core/t3colors.js';
import { CLIENTS as MCP_CLIENTS, activeServers, loadServers, saveServers, addServer, removeServer, resolveServerByName, registerServer, unregisterServer, disableServer, enableServer, registrationMatrix, registeredNames, clientAvailable, syncClientAccountMirrors, parseMcpAddArgs, supportsClient } from '../core/mcp.js';
import {
  customizationsSnapshot,
  loadMarketplaceCatalog,
  searchMarketplace,
  installMarketplaceItem,
  installFromGitHub,
  setSkillClientState,
  setAgentClientState,
} from '../core/customizations.js';
import {
  loadAutomations,
  saveAutomations,
  addAutomation,
  removeAutomation,
  toggleAutomation,
} from '../core/automations.js';
import { createGatewayServer, provisionLocalAndWslClient } from '../core/gateway.js';
import { runT3Setup, resolveTargets as resolveT3Targets, currentT3Status, currentLeaseSha, forgetT3, runT3SignIn, liveT3Status } from '../core/t3env-run.js';
import { createGatewayKey, updateGatewayKey, revokeGatewayKey, listGatewayKeys, normalizeGatewayPort, normalizeGatewayScope, normalizeGatewaySettings, GATEWAY_SCOPE_LABELS, chooseProvisionKey, gatewayEnabledSettings } from '../core/gateway-keys.js';
import readline from 'node:readline/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const [cmd, ...args] = process.argv.slice(2);
const out = (s) => process.stdout.write(s + '\n');
const here = path.dirname(fileURLToPath(import.meta.url));
// The value name Electron registers the tray under in the user's Run key: the app id from
// package.json (`build.appId`), which is also the AppUserModelId. test/gateway.test.js
// holds the two equal.
const LOGIN_ITEM_NAME = 'io.switchboard.app';
const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const providerList = Object.keys(PROVIDERS).join('|');

function fmtWindow(w) {
  const pct = w.usedPercent == null ? (w.valueLabel ?? 'n/a') : `${w.usedPercent}%`;
  const reset = w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : '';
  return `  ${w.label}: ${pct}${w.valueLabel && w.usedPercent != null ? ` (${w.valueLabel})` : ''}${reset}`;
}

/**
 * What lane selection starts from: the settings every lane is judged by, and a reader for
 * one account's sign-in and usage. selectLaneAsNeeded calls the reader only for accounts
 * it actually reaches, which is what keeps `dry-run` quick; see there for why.
 */
async function laneSelection(settings, registry, overrides = {}) {
  const { lanes = [], spendPolicies = {}, cooldowns = {}, usageSources = {} } = settings;
  const accounts = await resolveAllAccounts(registry);
  const now = Date.now();

  const readAccount = async (accountId) => {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return {};
    const login = accountLoginState(account);
    const def = PROVIDERS[account.provider];
    if (!((def && def.quota) || account.provider === 'antigravity')) return { login };
    // Through the shared cache: `dry-run` is what Paperclip and the Slack bridge
    // invoke before every spawn, so uncached live calls here multiplied across
    // every automation on the machine.
    const quota = await sharedProviderQuota(account, { fetchImpl: fetch, usageSource: usageSources[account.id] ?? null, now });
    return { login, quota };
  };

  // What ranking by reset looks at: the sign-in, and the last reading the shared cache
  // holds at any age, never the vendor. Only the turnover time matters for ranking, and it
  // stays true until it passes. See selectLaneAsNeeded.
  const peekAccount = (accountId) => {
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return {};
    return { login: accountLoginState(account), quota: lastSharedQuota(account.id) ?? undefined };
  };

  return {
    pool: lanes,
    context: { now, loginStates: {}, quotas: {}, spendPolicies, cooldowns, requirements: overrides },
    readAccount,
    peekAccount,
  };
}

async function promptUser(query) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(query);
    return answer.trim().toLowerCase();
  } finally {
    rl.close();
  }
}

/**
 * A yes/no question for the person at the terminal. `yes` (the --yes flag) answers yes
 * without asking; no terminal, or `quiet` (--json), answers no, so nothing waits on a
 * prompt nobody sees.
 */
async function askYes(question, { yes = false, quiet = false } = {}) {
  if (yes) return true;
  if (quiet || !process.stdin.isTTY) return false;
  const answer = await promptUser(`${question} [y/N] `);
  return answer === 'y' || answer === 'yes';
}

/**
 * Whether the running tray's broker answers at `url` with `key`: ready (200), rejected
 * (401 or 403: the key is not in the list the tray loaded), or down. The CLI's own
 * server object is not the tray's, so the only honest check is over HTTP.
 */
async function probeBrokerInfo(url, key, { fetchImpl = fetch, timeoutMs = 3000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: controller.signal });
    if (res.status === 200) return 'ready';
    if (res.status === 401 || res.status === 403) return 'rejected';
    return 'down';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One line per distro for `gateway provision-client`, from provisionLocalAndWslClient's
 * `distros` entry. Never the key.
 */
function describeDistroProvision(d) {
  if (d.key !== 'written') return 'could not write the key file (is the distro running, and is its default user a normal user?)';
  switch (d.wrapper) {
    case 'installed': return `key file written; wrapper installed at ${d.path}`;
    case 'updated': return `key file written; wrapper updated at ${d.path}`;
    case 'unchanged': return `key file written; wrapper already current at ${d.path}`;
    case 'replaced': return `key file written; the symlink at ${d.path} was replaced with a copy`;
    case 'symlink-kept': return `key file written; ${d.path} is a symlink to ${d.target} and was left alone (--replace-symlink replaces it with a copy)`;
    case 'not-provided': return 'key file written; no wrapper file to install';
    default: return 'key file written; the wrapper could not be installed';
  }
}

/**
 * Whether the tray is registered to start with Windows, read from the Run key Electron
 * writes. null when the question has no answer here (not Windows, or reg.exe failed).
 */
async function loginItemPresent() {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    const child = spawn('reg.exe', ['query', RUN_KEY, '/v', LOGIN_ITEM_NAME], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(null));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function addLoginItem(exePath) {
  return new Promise((resolve) => {
    const child = spawn('reg.exe', ['add', RUN_KEY, '/v', LOGIN_ITEM_NAME, '/t', 'REG_SZ', '/d', `"${exePath}"`, '/f'], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Whether changing the machine default actually outlives this command.
 *
 * setUserEnv writes the user-scope environment through setx on Windows. Everywhere else
 * it falls back to setting this process's own environment, which dies with the command,
 * so an unattended watch would report a switch that never happened. It says so instead.
 */
const DEFAULT_SWITCH_PERSISTS = process.platform === 'win32';

/** One line describing one watch decision, and what was done about it. */
function formatDecision(decision, accounts) {
  const label = (id) => accounts.find((a) => a.id === id)?.label ?? id;
  switch (decision.kind) {
    case 'pin-blocked':
      return `${decision.provider}: the default account ${decision.spent ? 'is out of quota' : 'is nearly out of quota'}, but a machine-wide authentication override makes folder switching unreliable. Run "switchboard doctor".`;
    case 'exhausted': {
      const when = decision.resetsAt ? ` Earliest reset: ${new Date(decision.resetsAt).toLocaleString()}.` : '';
      return `${decision.provider}: no signed-in account with readable quota has room.${when}`;
    }
    case 'switch':
      return decision.applied
        ? `${decision.provider}: ${decision.reason}. Switched the default to ${label(decision.to)}; new processes use it and running ones are unchanged.`
        : `${decision.provider}: ${decision.reason}. Not switched: ${decision.note}`;
    case 'suggest':
      return `${decision.provider}: ${decision.reason}. Switch with: switchboard use ${decision.to}`;
    default:
      return `${decision.provider}: ${decision.kind}`;
  }
}

/**
 * One watch pass. Reads where every account stands and takes the same decision the tray
 * app takes, because both call planDefaultSwitches. Settings and the registry are read
 * fresh every pass: this is meant to run for days, and the desktop app or another
 * terminal can change either while it does.
 */
async function watchPass({ mode, apply }) {
  const reg = loadRegistry();
  const stored = loadSettings();
  // The mode override applies to this pass only and is never written back, so a
  // scheduled task cannot quietly change what the desktop app does.
  const settings = { ...stored, quotaWatch: mode };
  const now = Date.now();

  // Only accounts that a decision could actually name. Claude is always read because it
  // is the one tool that can be decided about without a configured pool.
  const wanted = new Set(['claude']);
  for (const lane of settings.lanes) wanted.add(lane.harness);

  const snapshots = {};
  const loginStates = {};
  await Promise.all(reg.accounts.filter((a) => wanted.has(a.provider)).map(async (a) => {
    loginStates[a.id] = accountLoginState(a);
    if (!PROVIDERS[a.provider]?.quota) return;
    // Through the shared cache, so a watch running every five minutes leaves readings
    // behind for `dry-run` rather than competing with it for the same rate limit.
    snapshots[a.id] = await sharedProviderQuota(a, { usageSource: settings.usageSources[a.id] ?? null, now });
  }));

  const pinPresent = configuredClaudeCredentialOverrides({
    user: readUserEnv,
    machine: readMachineEnv,
    processEnv: process.env,
  }).length > 0;

  const decisions = planDefaultSwitches({ settings, registry: reg, snapshots, loginStates, pinPresent, now });

  // What the hooks have already been told, by this process or any other (the tray, or an
  // earlier `watch --once`), so an alert goes out once rather than on every run. Worked
  // out and saved before anything is sent: sending can take seconds on the network, and
  // a record written after it would overwrite whatever the tray saved in the meantime.
  // "No account has room" is said once for each time it happens, as the tray says it.
  const told = loadAlertMemory().hooks;
  const { events: thresholdEvents, memory: nextThresh } = checkThresholds({
    accounts: reg.accounts,
    snapshots,
    thresholds: settings.thresholds,
    memory: told.thresholds,
    now,
  });
  const activeIds = Object.fromEntries(Object.keys(PROVIDERS).map((id) => [id, activeAccount(reg, id)?.id ?? null]));
  const { notices, memory: nextNotices } = freshNotices(decisions, told.notices, activeIds);
  saveAlertMemory('hooks', { thresholds: nextThresh, notices: nextNotices });

  for (const event of thresholdEvents) {
    await dispatchNotification(settings, buildNotificationPayload(event, now));
  }

  for (const decision of decisions) {
    if (decision.kind !== 'switch') continue;
    if (!apply) {
      decision.applied = false;
      decision.note = 'this pass is read-only';
      continue;
    }
    if (!DEFAULT_SWITCH_PERSISTS) {
      decision.applied = false;
      decision.note = `changing the machine default is not supported on ${process.platform}; "switchboard run" still routes by lane`;
      continue;
    }
    // The reading that chose this account can be up to five minutes old, and a sign-out
    // in between would send every new terminal at an account that cannot work.
    const target = reg.accounts.find((a) => a.id === decision.to);
    if (accountLoginState(target ?? {}).signedIn !== true) {
      decision.applied = false;
      decision.note = 'that account is no longer signed in';
      continue;
    }
    setActive(reg, decision.to);
    saveSettings({ ...loadSettings(), lastAutoSwitchAt: Date.now() });
    decision.applied = true;
    await dispatchNotification(settings, buildNotificationPayload({
      kind: 'switch',
      event: 'default_switched',
      provider: decision.provider,
      to: decision.to,
      from: decision.from,
      reason: decision.reason,
    }, now));
  }

  for (const decision of decisions) {
    if (decision.kind === 'exhausted' && notices.includes(decision)) {
      await dispatchNotification(settings, buildNotificationPayload({
        kind: 'exhausted',
        event: 'quota_exhausted',
        provider: decision.provider,
        resetsAt: decision.resetsAt,
      }, now));
    }
  }

  // Lane tokens ride the same schedule. One probe run per stored live token is the only
  // honest test of whether the vendor still honours it, and it costs nothing for a lane
  // without one. A token that died stops being handed out the moment this is saved, and
  // the doctor check names it; automation just reverts to folder mode in the meantime.
  // The freshness window matches the tray's: about one small Claude run per token per hour,
  // however often the passes themselves run. An explicit --check stays unthrottled.
  const tokenCheck = await validateLaneTokens(stored, { now: Date.now(), maxAgeMs: 60 * 60 * 1000 });
  if (tokenCheck.changed) {
    // Settings are re-read for the merge: the pass above may have written its own
    // lastAutoSwitchAt, and another process may have written anything else during the
    // network window. The merge applies only the lanes this pass checked, and only
    // while each still holds the very token that was validated, so a mint, removal or
    // dead-mark that landed mid-pass wins over this pass's stale snapshot.
    saveSettings(mergeLaneTokenResults(loadSettings(), tokenCheck));
  }

  return { decisions, thresholdEvents, accounts: reg.accounts };
}

/**
 * The interactive mint for one lane, shared by `lane-token <laneId>` and `lane-token
 * --missing`: runs `claude setup-token` in the lane's own account folder, takes the
 * pasted token, checks it with a small real Claude run, and stores it. Prints what
 * happened and answers true only when a token was stored. The caller decides the
 * exit code, because `--missing` goes on to the next lane.
 */
async function mintLaneToken({ laneId, registry, settings, fromEnv = false }) {
  const lane = settings.lanes.find((l) => l.id === laneId);
  if (!lane) { out(`no lane with id "${laneId}"`); return false; }
  if (lane.harness !== 'claude') {
    out(`lane ${laneId} runs ${lane.harness}; only Claude lanes can carry a setup token`);
    return false;
  }
  const account = registry.accounts.find((a) => a.id === lane.accountId);
  if (!account) { out(`lane ${laneId} names an unregistered account (${lane.accountId})`); return false; }

  // --from-env: the Health panel's token window already ran `claude setup-token` and read
  // the paste itself, because this process cannot (below). Only checking and storing is left.
  if (fromEnv) {
    return storeLaneToken({ laneId, account, pasted: process.env.SWITCHBOARD_NEW_LANE_TOKEN || '' });
  }

  // Run as Node by the packaged app (switchboard.cmd), this process gets no console for its
  // input: stdin.isTTY is undefined even in a real terminal window, so the sign-in tool it
  // starts with that input draws nothing and waits forever, and the paste prompt cannot
  // read. Probed in a console window on 2026-11-02 after the browser said "all set" and no
  // token ever appeared. Say where minting does work instead of hanging.
  if (!process.stdin.isTTY) {
    out('This terminal cannot run Claude\'s sign-in tool through Switchboard, so nothing was minted.');
    out('Open Switchboard, go to Health, and click "Get new token" on this lane.');
    return false;
  }

  const executable = await toolExecutable(lane.harness);
  if (!executable) {
    out(`Tool for harness '${lane.harness}' is not installed or not found on PATH.`);
    return false;
  }

  // Same launch shape as `run`: cmd.exe for the batch shims npm writes on Windows,
  // with the same unsafe-path guard.
  let spawnFile = executable;
  let spawnArgs = ['setup-token'];
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
    if (/[\u0000-\u001f"%]/.test(executable)) {
      out(`Unsafe batch-shim path: ${executable}`);
      return false;
    }
    spawnFile = 'cmd.exe';
    spawnArgs = ['/d', '/s', '/v:off', '/c', executable, 'setup-token'];
  }

  // accountScopedEnv strips any inherited CLAUDE_CODE_OAUTH_TOKEN and pins
  // CLAUDE_CONFIG_DIR to this lane's account folder, which structurally prevents
  // the known trap where setup-token silently mints for whatever account the
  // calling shell was already carrying.
  const childEnv = accountScopedEnv(account, process.env);
  out(`Minting a token for ${account.label} (${lane.accountId}). Complete the browser approval when asked.`);

  out(`Claude's own sign-in tool runs next, in this terminal. Complete the browser`);
  out(`approval; the tool then prints the minted token here. Copy it, and paste it`);
  out(`at the prompt that follows. Switchboard checks it before storing anything.`);

  const minted = await new Promise((resolve) => {
    // The tool is interactive all the way through and renders its prompts only on
    // a real console, so it gets the terminal unfiltered and Switchboard captures
    // nothing. Capturing was tried and shipped in 0.16.0, and it HANGS: with
    // stdout piped, the tool draws nothing and waits forever on a prompt nobody
    // can see. The token therefore appears once on screen, printed by the
    // vendor's own tool exactly as it would if run by hand; Switchboard itself
    // still never prints it.
    const child = spawn(spawnFile, spawnArgs, { stdio: 'inherit', env: childEnv });
    child.on('error', (err) => resolve({ code: 1, launchError: err.message }));
    child.on('close', (code) => resolve({ code }));
  });

  if (minted.launchError) {
    out(`Failed to launch ${executable}: ${minted.launchError}`);
    return false;
  }
  if (minted.code !== 0) {
    out(`setup-token exited with code ${minted.code}, so nothing was stored`);
    return false;
  }

  // Not promptUser: that helper lowercases its answer for y/N questions, and a
  // token is case sensitive. Pasting echoes on screen, which adds nothing new,
  // since the tool printed the same value directly above.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let pasted;
  try {
    pasted = await rl.question('Paste the token that was just printed: ');
  } finally {
    rl.close();
  }
  return storeLaneToken({ laneId, account, pasted });
}

/**
 * The second half of a mint: take the token out of what was pasted, check it with a real
 * Claude run, and store it stamped with the folder's sign-in identity. Answers true only
 * when a token was stored.
 */
async function storeLaneToken({ laneId, account, pasted }) {
  const token = extractSetupToken(pasted);
  if (!token) {
    out('That did not contain a token, so nothing was stored. Run this command again to re-mint.');
    return false;
  }

  // The minting login's identity is stamped into the stored entry, so dry-run can
  // refuse to hand the token out after the folder is re-signed into a different
  // account. No identity means nothing to stamp, and an unstamped fresh token
  // would outlive any later re-sign-in unnoticed, so it is refused instead.
  const identity = readClaudeAccountIdentity(account.home);
  if (!identity) {
    out(`No readable sign-in identity in ${account.home}, so nothing was stored. The lane's folder must be signed in; sign it in and mint again.`);
    return false;
  }

  // One validation before anything is written: a real, minimal Claude run using
  // the token, because that is the only thing that honestly answers whether the
  // vendor honours it. The account usage endpoint refuses setup tokens outright
  // even seconds after a successful mint (learned on the first real one), and
  // auth status reports loggedIn for any well-shaped value. A token the vendor
  // refuses must not be stored: automation would trust it and fail every run.
  out('Checking the token with a small real Claude run; this can take a minute...');
  const verdict = await probeSetupToken(token);
  if (verdict === 'dead') {
    out('Claude refused the pasted token, so nothing was stored. Check that the whole token was copied, and mint again.');
    return false;
  }
  if (verdict === 'unreachable') {
    out('The check could not run (network or tool failure), so the token is stored unverified; "lane-token --check" can retry the check later.');
  }
  // Settings are re-read here: the browser approval can take minutes, and the tray
  // or another terminal may have written settings.json while we waited.
  saveSettings(setLaneToken(loadSettings(), laneId, {
    token,
    accountId: account.id,
    mintedAt: Date.now(),
    organizationUuid: identity.organizationUuid,
    accountUuid: identity.accountUuid,
  }));
  out(`Stored a lane token for ${account.label} (${token.length} characters; the value itself is never printed).`);
  if (verdict === 'unknown') {
    out(`The validation call could not run (network or endpoint failure); the token is stored anyway. Confirm later with: switchboard lane-token ${laneId} --check`);
  }
  return true;
}

async function main() {
  const registry = loadRegistry();

  switch (cmd) {
    case 'dry-run': {
      const settings = loadSettings();
      const parsed = parseRunArgs(args);
      // A caller has to know which harness it will get BEFORE it builds a command line,
      // so the same selection is available as one machine-readable line.
      const asJson = args.includes('--json');
      // Opt-in, because the Slack bridge also calls `dry-run --json` and must not start
      // receiving secrets on stdout it never asked for.
      const withToken = args.includes('--with-token');

      // A spec given here is read for one thing only: which tools it covers. That is what
      // makes this answer the same one `run --spec` will act on, rather than naming a lane
      // the run would then pass over.
      let spec = null;
      if (parsed.spec) {
        try {
          spec = loadRunSpec(parsed.spec);
        } catch (e) {
          out(asJson ? JSON.stringify({ available: false, reason: e.message }) : e.message);
          process.exitCode = 1;
          return;
        }
      }

      const { pool, context, readAccount, peekAccount } = await laneSelection(settings, registry, { provider: parsed.provider });

      if (parsed.account) {
        context.requirements.accountId = parsed.account; // Not natively in selectLane, but conceptually overrides
        // Actually selectLane doesn't filter by accountId yet, let's filter the pool manually
      }

      // A lane is named by its harness ("claude") or by its vendor ("anthropic"), and
      // --provider takes either. Filtering here rather than leaving it to selectLane is
      // what separates "nothing matched what you asked for" from "everything that matched
      // is busy", which are different problems with different fixes. The same goes for
      // the tools the caller can drive: see narrowPool.
      const harnesses = drivableHarnesses(parsed, spec);
      const filteredPool = narrowPool(pool, {
        account: parsed.account,
        provider: parsed.provider,
        harnesses,
      });

      // The answer says which tools it was narrowed to, in both its forms. A version from
      // before --harnesses existed ignores the flag and answers for every lane, and the two
      // answers look identical unless this one says what question it answered. A caller
      // that named its tools and does not get them back knows its order still matters on
      // this machine.
      const narrowedTo = harnesses ? { harnesses } : {};

      // Taken in the order the tray shows: soonest weekly reset first on "Switch
      // automatically", as set otherwise. See ordersBySoonestReset.
      const selected = filteredPool.length
        ? await selectLaneAsNeeded(filteredPool, context, readAccount, { bySoonestReset: ordersBySoonestReset(settings), peekAccount })
        : null;

      if (!selected) {
        const reason = selectionFailure(pool, filteredPool);
        out(asJson ? JSON.stringify({ available: false, reason, ...narrowedTo }) : reason);
        process.exitCode = 1;
        return;
      }

      // laneTokenFor decides whether the stored token is live; the identity gate on
      // top refuses it once the lane's folder is signed in as a different account.
      // Re-signing a folder does not touch the stored token, so without this the
      // automation fleet would keep billing the account the token was minted for.
      // Refusing only reverts automation to folder mode, today's working behaviour,
      // which is also why an unreadable identity refuses rather than trusts.
      const emittableLaneToken = (laneId) => {
        const token = laneTokenFor(settings, laneId);
        if (!token) return null;
        const home = registry.accounts.find((a) => a.id === selected.lane.accountId)?.home;
        const identity = home ? readClaudeAccountIdentity(home) : null;
        return laneTokenIdentityMatches(settings.laneTokens?.[laneId], identity) ? token : null;
      };

      if (asJson) {
        const answer = {
          laneId: selected.lane.id,
          harness: selected.lane.harness,
          provider: selected.lane.provider,
          accountId: selected.lane.accountId,
          billing: selected.lane.billing,
          reason: selected.status.reason,
          available: true,
          ...narrowedTo
        };
        // emittableLaneToken answers a non-empty string or null, so the field is
        // either a usable token or absent, never null or "".
        const token = withToken ? emittableLaneToken(selected.lane.id) : null;
        if (token) answer.token = token;
        out(JSON.stringify(answer));
        return;
      }

      out(`Selected lane: ${selected.lane.id}`);
      out(`  Harness: ${selected.lane.harness}`);
      out(`  Provider: ${selected.lane.provider}`);
      out(`  Account: ${selected.lane.accountId}`);
      out(`  Billing: ${selected.lane.billing}`);
      out(`  Reason: ${selected.status.reason}`);
      // The human form never prints the value itself, only whether automation would
      // receive one; a terminal is the easiest place to leak a secret into a screenshot.
      if (withToken) out(`  Token: ${emittableLaneToken(selected.lane.id) ? 'available' : 'none'}`);
      return;
    }
    case 'run': {
      const settings = loadSettings();
      const parsed = parseRunArgs(args);
      // With --quiet switchboard's own lines go to stderr, so a caller parsing the child's
      // stdout as JSON is never handed a status line it did not ask for.
      const say = (msg) => parsed.quiet ? process.stderr.write(msg + '\n') : out(msg);

      // The spec is validated before anything is spawned: a bad spec must not be discovered
      // half way through a run, when a lane has already been consumed.
      let spec = null;
      if (parsed.spec) {
        try {
          spec = loadRunSpec(parsed.spec);
        } catch (e) {
          say(`[switchboard] ${e.message}`);
          process.exitCode = 1;
          return;
        }
      }

      // Narrowed once, here, so the first pick and every later failover walk the same
      // lanes. A lane whose tool the caller cannot drive is left out rather than reached
      // and refused: see narrowPool for what that used to cost.
      const narrowing = {
        account: parsed.account,
        provider: parsed.provider,
        harnesses: drivableHarnesses(parsed, spec),
      };
      let currentPool = narrowPool(settings.lanes, narrowing);

      const { context, readAccount, peekAccount } = await laneSelection(settings, registry, {
        provider: parsed.provider,
      });

      // The same order dry-run answers with, so a caller that asked first gets what it was told.
      let selected = currentPool.length
        ? await selectLaneAsNeeded(currentPool, context, readAccount, { bySoonestReset: ordersBySoonestReset(settings), peekAccount })
        : null;

      if (!selected) {
        say(selectionFailure(settings.lanes, currentPool));
        process.exitCode = 1;
        return;
      }

      const leftOut = lanesCallerCannotDrive(settings.lanes, narrowing);
      if (leftOut.length) {
        say(`[switchboard] Leaving out ${leftOut.map((l) => `${l.id} (${l.harness})`).join(', ')}: this caller has no command line for ${leftOut.length === 1 ? 'that tool' : 'those tools'}.`);
      }

      const { classifyRunFailure } = await import('../core/errors.js');

      // A long run must not balloon memory, and a limit notice always sits at the end of
      // the output, so only the tail is retained for classification.
      const STDOUT_TAIL_BYTES = 64 * 1024;

      // Whatever the caller piped in is recorded from the first byte, so a run that moves
      // to another lane can hand the same prompt to the tool there. A person at a keyboard
      // is left alone: an interactive tool needs the real terminal, not a copy of it.
      //
      // Only when the output is not a terminal either. That is the same test that already
      // decides whether this is an automated caller (see childStdio), and it keeps this
      // well away from anybody typing: a session at a real console must never be handed a
      // pipe where it expected the keyboard, whatever this process is told about its input.
      let pipedInput = null;
      try {
        // Inside the try from the first touch: a process started with no standard input at
        // all can throw on the property itself. The child then inherits whatever there is,
        // which is what it always did.
        if (!process.stdin.isTTY && !process.stdout.isTTY) {
          pipedInput = recordPipedInput(process.stdin);
        }
      } catch {
        pipedInput = null;
      }

      async function runInLane(lane, executionArgs, handoffNote = null) {
        const allAccounts = await resolveAllAccounts(registry);
        const account = allAccounts.find(a => a.id === lane.accountId);
        if (!account) {
          say(`Account ${lane.accountId} not found in registry.`);
          return { code: 1, limitHit: false, authFailed: false };
        }

        const executable = await toolExecutable(lane.harness);
        if (!executable) {
          say(`Tool for harness '${lane.harness}' is not installed or not found on PATH.`);
          return { code: 1, limitHit: false, authFailed: false };
        }

        const childEnv = accountScopedEnv(account, process.env);
        say(`[switchboard] Running via lane ${lane.id} (${account.label})`);

        // A conversation resumed by name follows the work: if another Claude account has
        // gone further with it, that copy is brought here first. See syncSessionInto.
        const resuming = lane.harness === 'claude' ? resumedSession(executionArgs) : null;
        if (resuming && account.home) {
          const sync = syncSessionInto({
            toHome: account.home,
            otherHomes: registry.accounts.filter((a) => a.provider === 'claude' && a.id !== account.id).map((a) => a.home),
            cwd: runCwd,
            sessionId: resuming,
          });
          if (sync.synced) {
            const from = registry.accounts.find((a) => a.home === sync.from)?.label ?? 'another account';
            say(`[switchboard] Brought the latest copy of that conversation over from ${from}.`);
          }
        }

        let spawnFile = executable;
        let spawnArgs = executionArgs;
        let spawnOptions = {
          // stdout is piped only when this is not a terminal, because a headless harness can
          // report an exhausted subscription as an ordinary assistant message on stdout and
          // never on stderr. Every chunk is forwarded on immediately and unchanged, so a
          // streaming caller still sees the same bytes at the same time.
          stdio: childStdio(Boolean(process.stdout.isTTY), Boolean(pipedInput)),
          env: childEnv,
          windowsHide: childWindowsHide(Boolean(process.stdout.isTTY))
        };

        if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
          if (/[\u0000-\u001f"%]/.test(executable)) {
            say(`[switchboard] Unsafe batch-shim path: ${executable}`);
            return { code: 1, limitHit: false, authFailed: false };
          }
          spawnFile = 'cmd.exe';
          spawnArgs = ['/d', '/s', '/v:off', '/c', executable, ...executionArgs];
        }
        
        return new Promise((resolve) => {
          let resolved = false;
          function done(result) {
            if (resolved) return;
            resolved = true;
            resolve(result);
          }

          const child = spawn(spawnFile, spawnArgs, spawnOptions);
          pipedInput?.attach(child.stdin, handoffNote);

          let stderrOutput = '';
          child.stderr?.on('data', (data) => {
            process.stderr.write(data);
            stderrOutput += data.toString();
          });

          let stdoutTail = '';
          child.stdout?.on('data', (data) => {
            process.stdout.write(data);
            stdoutTail = (stdoutTail + data.toString()).slice(-STDOUT_TAIL_BYTES);
          });

          child.on('error', (err) => {
            say(`\n[switchboard] Failed to launch ${executable}: ${err.message}`);
            done({ code: 1, limitHit: false, authFailed: false, serverError: false });
          });

          child.on('close', (code) => {
            const verdict = classifyRunFailure(code, stderrOutput + '\n' + stdoutTail);
            if (verdict === 'limit') {
              say(`\n[switchboard] Provider limit error detected in lane ${lane.id}.`);
              done({ code, limitHit: true, authFailed: false, serverError: false });
            } else if (verdict === 'auth') {
              // Said out loud even though the run carries on elsewhere. A spent lane comes
              // back by itself when its window resets; a lane that cannot sign in does not,
              // and without this line every later run would quietly start one lane lower
              // with nobody ever told why.
              say(`\n[switchboard] Lane ${lane.id} (${account.label}) could not authenticate, so it is out for this run.`);
              say(`[switchboard] A run uses the account's own sign-in, so sign ${account.label} back in to bring the lane back.`);
              done({ code, limitHit: false, authFailed: true, serverError: false });
            } else if (verdict === 'server') {
              say(`\n[switchboard] Provider server error detected in lane ${lane.id} (${account.label}).`);
              done({ code, limitHit: false, authFailed: false, serverError: true });
            } else {
              if (code !== 0) {
                say(`\n[switchboard] Process exited with code ${code}. Ambiguous failure, not falling back.`);
              }
              done({ code, limitHit: false, authFailed: false, serverError: false });
            }
          });
        });
      }

      // A spec argv belongs to a harness, not to the invocation, so it is looked up again
      // for every lane. Without a spec the caller's own arguments are used, as before.
      function argsForLane(lane, handoffPrompt = null) {
        const argv = resolveSpecArgv(spec, lane.harness, handoffPrompt);
        if (!argv) {
          // Guessing here would hand one harness's flags to another harness's binary.
          say(`[switchboard] The spec has no harnessArgs entry for harness '${lane.harness}'. Refusing to guess.`);
          return null;
        }
        return argv;
      }

      const runCwd = process.cwd();

      // Naming the session up front is what makes carrying it possible later: on a
      // failover Switchboard has to know which transcript belongs to this run, and the
      // newest file in the folder is the wrong answer whenever two agents share a
      // working directory. Done for every Claude start, spec or not, unless the command
      // line already steers the session; then the caller's own name is used instead
      // (sessionToCarry). Each fresh start gets a fresh name, so an account that already
      // holds some other conversation under an earlier name is never asked to reuse it.
      const namedForCarry = (lane, argv) => (
        CARRYABLE_HARNESSES.includes(lane.harness) && !callerManagesSession(argv)
          ? withSessionId(argv, newSessionId())
          : argv
      );

      let currentArgs = spec ? argsForLane(selected.lane) : [...parsed.commandArgs];
      if (!currentArgs) {
        process.exitCode = 1;
        return;
      }
      currentArgs = namedForCarry(selected.lane, currentArgs);

      // The sentence pointing a lane at the handoff, when it travels on the lane's standard
      // input rather than its command line. Set by one hop for the lane after it.
      let handoffNote = null;

      // What the last hop handed the lane it moved to: the session carried into it, or the
      // handoff it was pointed at. A lane that then cannot sign in never started, so the
      // lane after it is handed the same thing rather than nothing.
      // `workFrom` is the last lane that actually ran, whose work is what is being handed on.
      // `workArgs` is the command line that lane ran with, which names its session.
      let handedOn = { carriedId: null, pointAt: null, workFrom: null, told: false, workArgs: null };

      // What marks a handoff as derived by THIS run. See handoffOrigin for why it matters.
      const runId = newSessionId();
      let tidiesHandoff = false;
      // What this run last wrote into its handoff, kept here so the next one can build on
      // it exactly (see derivedHandoffData), plus the session it was written from.
      let lastDerived = null;

      /**
       * Put a handoff in place for the lane about to take over, from the session that just
       * ran out, and say whose handoff the workspace now holds:
       *
       *   'ours'    this run derived it, so it describes the work being handed over
       *   'theirs'  somebody wrote one on purpose; it is left exactly as it is
       *   'none'    there is nothing to hand over
       *
       * One that an EARLIER run derived describes a different task. It is replaced when
       * this run has something to say, and removed when it has not, so a run is never
       * pointed at another run's work. This run's own is removed when the process ends.
       */
      function deriveHandoff(previousLane, laneStartedAt, ranWith) {
        const existing = readHandoff(runCwd);
        if (existing && !handoffOrigin(existing).derived) return 'theirs';

        let digest = null;
        // Not the parent of a fork: that conversation is not what this run added to.
        const sessionId = previousLane.harness === 'claude' ? sessionToCarry(ranWith) : null;
        if (transcriptSupport(previousLane.harness)) {
          const spentHome = registry.accounts.find((a) => a.id === previousLane.accountId)?.home;
          // A Claude session is named on the command line the spent lane ran with, by
          // Switchboard or by the caller, so it is read from there. Codex has no such flag
          // at all, so its session is recognized afterwards by the directory it recorded
          // and the fact this run touched it: hence `since`.
          digest = sessionDigest({
            harness: previousLane.harness,
            home: spentHome,
            cwd: runCwd,
            sessionId,
            since: laneStartedAt,
          });
        }
        if (digest) {
          try {
            // Built on this run's own earlier handoff when there is one: see
            // derivedHandoffData for why it is never simply replaced.
            const earlier = existing && handoffOrigin(existing).runId === runId ? lastDerived : null;
            const fitted = fitHandoff(derivedHandoffData({
              earlier,
              runId,
              objective: digest.objective,
              state: digest.state,
              sessionId,
              harness: previousLane.harness,
            }));
            if (fitted.trimmed) digest.truncated = true;
            writeHandoff(runCwd, fitted.data);
            lastDerived = { objective: fitted.data.objective, state: fitted.data.state, before: fitted.data.before, sessionId };
            if (!tidiesHandoff) {
              tidiesHandoff = true;
              process.once('exit', () => {
                if (handoffOrigin(readHandoff(runCwd)).runId === runId) removeHandoff(runCwd);
              });
            }
            say(`[switchboard] Wrote a handoff from the spent ${previousLane.harness} session${digest.truncated ? ' (its most recent work; the run was too long to record in full)' : ''}.`);
            return 'ours';
          } catch (e) {
            // Includes the writer's own size limit.
            say(`[switchboard] Could not write a handoff from the spent session: ${String(e.message || e)}`);
          }
        }
        if (existing && handoffOrigin(existing).runId !== runId) removeHandoff(runCwd);
        return existing && handoffOrigin(existing).runId === runId ? 'ours' : 'none';
      }

      /**
       * Ask before moving the work to a different vendor's tool. Only a person can be
       * asked. With the input piped there is nobody at a terminal, and what is in the pipe
       * is the caller's prompt, not an answer: the question used to be printed anyway and
       * the process then ended at it with a clean exit and nothing done. An automated
       * caller says `--yes` up front, and one that did not is told so.
       */
      async function confirmHop(question) {
        if (parsed.yes) return true;
        if (!process.stdin.isTTY) {
          say('[switchboard] Not moving this run to another tool: nobody is at a terminal to confirm it. Pass --yes to allow it.');
          return false;
        }
        const answer = await promptUser(question);
        return answer === 'y' || answer === 'yes';
      }

      while (selected) {
        // When this lane started, so a vendor whose session cannot be named up front can
        // still be recognised afterwards: its transcript has to have been touched during
        // this run, not left behind by earlier work in the same directory. A second early,
        // because a file written in the same tick as the spawn would otherwise look older
        // than the run that wrote it.
        const laneStartedAt = Date.now() - 1000;
        const result = await runInLane(selected.lane, currentArgs, handoffNote);
        handoffNote = null;

        if ((result.limitHit || result.authFailed || result.serverError) && !parsed.noFallback) {
          const previousLane = selected.lane;
          currentPool = currentPool.filter(l => l.id !== selected.lane.id);
          
          const nextSettings = loadSettings();
          const next = await laneSelection(nextSettings, registry, {
            provider: parsed.provider,
          });

          selected = await selectLaneAsNeeded(currentPool, next.context, next.readAccount, { bySoonestReset: ordersBySoonestReset(nextSettings), peekAccount: next.peekAccount });
          
          if (!selected) {
            say(`[switchboard] No more available lanes to fall back to.`);
            process.exitCode = result.code;
            return;
          }

          const changesTool = previousLane.harness !== selected.lane.harness || previousLane.provider !== selected.lane.provider;

          // What the spent lane actually ran with: the session it was working in is named
          // there, by Switchboard or by the caller, and the handoff is read from it.
          const ranWith = currentArgs;
          // Which handoff the next lane is pointed at: 'ours' (this run derived it),
          // 'theirs' (somebody wrote it on purpose) or null for none.
          let pointAt = null;
          // The session the next lane resumes, when it could be carried across.
          let carriedId = null;

          // A lane that could not sign in never ran, and that changes what the hop has to
          // do rather than only where it goes. It wrote nothing of its own, so there is no
          // new work to carry or hand off, and the digest below would have nothing to read
          // but somebody else's earlier work in the same directory. The next lane is given
          // whatever this one was given: the handoff it was pointed at, if any. A session
          // carried into it is the exception, handled as an ordinary failover below: the
          // failed lane holds an exact copy of that conversation, which can be carried on
          // or handed off from just as well as from the lane before it.
          const failedLaneHeldSession = result.authFailed && Boolean(handedOn.carriedId);
          // The lane whose work is being handed on: the one that just stopped, unless it
          // never started, in which case whichever ran before it (or none).
          const workFrom = result.authFailed && !failedLaneHeldSession ? handedOn.workFrom : previousLane;
          // Whether the tool changes from the one whose work is handed on. After a refused
          // sign-in that is not the lane that just failed, which never ran; with nothing
          // run yet, it is that lane.
          const workTool = workFrom ?? previousLane;
          const toolChanged = workTool.harness !== selected.lane.harness || workTool.provider !== selected.lane.provider;
          // Whether this hop is the run's first move onto this tool. Past a refused lane of
          // the same tool, the move was already asked about and announced when the run went
          // to that lane, so it is not asked or said again.
          const newTool = toolChanged && changesTool;
          // Whether the lane that just stopped was itself pointed at the handoff it hands on.
          const failedLaneWasTold = Boolean(handedOn.told);
          // The command line the carried session is resumed with: what the lane whose work
          // it is ran with, so it is always that tool's own arguments.
          let carryBase = ranWith;
          if (result.authFailed && !failedLaneHeldSession) {
            // A handoff somebody wrote by hand is only ever followed by a different tool,
            // as on a direct hop; back on the work's own tool it is not.
            pointAt = handedOn.pointAt === 'theirs' && !toolChanged ? null : handedOn.pointAt;
            say(`[switchboard] Falling back to next available lane: ${selected.lane.id}. Nothing new was carried, because the lane that failed never started.`);
            // Work that already started on one tool is only ever moved to another with
            // leave, as on any other hop. Only when nothing has run yet is there nothing to
            // move: the request simply goes to the next lane.
            if (newTool && workFrom && !(await confirmHop(`Move this run to ${selected.lane.id}, a different tool? (y/N): `))) {
              process.exitCode = result.code || 1;
              return;
            }
            // Back on the tool whose work this is, the conversation itself can follow, as
            // it would have on a direct hop from that lane.
            const sameAsWork = workFrom && workFrom.harness === selected.lane.harness && workFrom.provider === selected.lane.provider;
            const sessionId = sameAsWork ? sessionToCarry(handedOn.workArgs ?? []) : null;
            if (sessionId && CARRYABLE_HARNESSES.includes(selected.lane.harness)) {
              const fromHome = registry.accounts.find((a) => a.id === workFrom.accountId)?.home;
              const toHome = registry.accounts.find((a) => a.id === selected.lane.accountId)?.home;
              const carry = carryTranscript({ fromHome, toHome, cwd: runCwd, sessionId });
              if (carry.carried) {
                carriedId = sessionId;
                carryBase = handedOn.workArgs;
                pointAt = null;
                say('[switchboard] Carried the session over from the lane before it; this lane continues where that one stopped.');
              }
            }
          } else if (changesTool) {
            // A Claude session file means nothing to another vendor, so this hop cannot
            // carry the session itself. What it can carry is a written account of it, and
            // the spent session already wrote one: an agent narrates its work as it goes,
            // so the text turns of its transcript hold the objective, what was done and
            // the decisions taken. Extracted, never summarised by a model, so nothing here
            // can invent a decision that was never made.
            //
            // A handoff somebody wrote for this workspace on purpose is left exactly as it
            // is. It may be better than anything derivable, and it is not Switchboard's to
            // overwrite. One an earlier run derived is another matter: see deriveHandoff.
            const handoff = deriveHandoff(previousLane, laneStartedAt, ranWith);

            if (handoff === 'none') {
              say(`[switchboard] Warning: Cross-provider failover to ${selected.lane.harness} (${selected.lane.provider}) requires a handoff document, but none was found for this workspace.`);
              if (!parsed.yes) {
                say(`[switchboard] Please provide the missing objective manually or start a fresh session.`);
              }
              if (!(await confirmHop(`Start a fresh session in ${selected.lane.id}? (y/N): `))) {
                process.exitCode = result.code || 1;
                return;
              }
              if (parsed.yes) say(`[switchboard] Proceeding without handoff due to --yes flag.`);
            } else {
              say(`[switchboard] Valid task handoff found for workspace.`);
              if (!(await confirmHop(`Cross-provider failover to ${selected.lane.id}. Start new session? (y/N): `))) {
                process.exitCode = result.code || 1;
                return;
              }
              pointAt = handoff;
            }
          } else {
            say(`[switchboard] Falling back to next available lane for harness ${selected.lane.harness}: ${selected.lane.id}`);

            // Same harness, so the outgoing session can come with us. Copy its
            // transcript into the incoming account's folder and resume it there: the new
            // account continues the actual conversation rather than starting over, and
            // the spent account keeps its own copy. This works whoever named the session,
            // so a caller with its own command line gets the same continuation as one
            // that left it to Switchboard. Every failure falls through to a fresh start.
            const sessionId = sessionToCarry(ranWith);
            if (sessionId && CARRYABLE_HARNESSES.includes(selected.lane.harness)) {
              const fromHome = registry.accounts.find((a) => a.id === previousLane.accountId)?.home;
              const toHome = registry.accounts.find((a) => a.id === selected.lane.accountId)?.home;
              const carry = carryTranscript({ fromHome, toHome, cwd: runCwd, sessionId });
              if (carry.carried) {
                carriedId = sessionId;
                say('[switchboard] Carried the session over; this lane continues where the last one stopped.');
              } else {
                say(`[switchboard] ${carryNote(carry.reason)}.`);
              }
            }

            // The session itself could not travel, but a written account of it still can.
            // This is what covers a tool whose sessions are not portable, Codex being the
            // one that is not: two Codex lanes would otherwise get neither the session nor
            // a handoff, and start from nothing. No confirmation here, unlike the
            // cross-tool path: the same tool is taking over, so there is no vendor
            // surprise to warn anybody about.
            //
            // Only a handoff this run derived is used here. One somebody wrote on purpose is
            // left alone and not pointed at.
            if (!carriedId && deriveHandoff(previousLane, laneStartedAt, ranWith) === 'ours') pointAt = 'ours';
          }

          // The next lane's command line, built from what the caller gave for that tool,
          // never from the one the spent lane ran with: that one can hold a --resume naming
          // a session this account never had, or a Claude-only flag another tool rejects.
          //
          // Where the pointer to the handoff goes depends on how the caller gave its
          // prompt. A caller that piped it in has it replayed to this lane, and the pointer
          // follows it on standard input. That is the only safe place on a command line
          // somebody else built: there it lands after Claude's list-valued flags, which
          // swallow it as one more tool name, and Codex and Antigravity reject a stray
          // argument outright. A caller that piped nothing gets it appended to the command
          // line, because there is nowhere else to put it.
          //
          // A caller that piped its prompt is only ever pointed at a handoff THIS run
          // derived. Its prompt is the whole request, replayed in full, and a handoff
          // somebody left in the folder on purpose was written for something else.
          //
          // Without a spec, a lane pointed at a handoff is started with that one sentence
          // alone: after a change of tool the caller's arguments belong to another tool, and
          // on the same tool they can already hold a prompt, which a second would clash with.
          const cmdPointer = pointAt ? generateHandoffPrompt(runCwd) : null;
          let nextArgs;
          let told = false;
          handoffNote = null;
          if (carriedId) {
            // With a spec, the tool's own command line from it; without one, the line the
            // lane whose session this is ran with. Never the caller's raw arguments, which
            // after a change of tool belong to a different tool.
            nextArgs = resumeArgs(spec ? argsForLane(selected.lane) ?? [] : carryBase, carriedId);
          } else if (spec) {
            const replayed = Boolean(pipedInput?.replayable());
            // Worded for a tool that has the request in front of it as well: see
            // generateHandoffNote for why it cannot be the command-line sentence.
            const onStdin = replayed && pointAt === 'ours' && pipedInput.acceptsNote();
            // The command line only when the caller piped nothing at all, and only for a
            // different tool. Input still arriving, or too big to keep, is not "nothing",
            // and a stream of JSON messages must not get a sentence by another route. A
            // lane of the same tool runs the same spec, which already holds the request as
            // an argument, and a second one is refused outright by Codex.
            const nothingPiped = !pipedInput || pipedInput.nothingArrived();
            const onCommandLine = nothingPiped && toolChanged && Boolean(cmdPointer);
            nextArgs = argsForLane(selected.lane, onCommandLine ? cmdPointer : null);
            if (onStdin) handoffNote = generateHandoffNote(runCwd);
            told = onStdin || onCommandLine;
          } else {
            // A caller resuming a conversation by name on the same tool keeps its own
            // command line: it holds the request being asked now, which the handoff (whose
            // objective is that conversation's FIRST request) does not.
            const keepsOwnLine = !toolChanged && Boolean(resumedSession(parsed.commandArgs));
            const pointerOnly = Boolean(cmdPointer) && !keepsOwnLine;
            nextArgs = pointerOnly ? [cmdPointer] : [...parsed.commandArgs];
            told = pointerOnly;
          }
          if (!nextArgs) {
            process.exitCode = result.code || 1;
            return;
          }
          currentArgs = carriedId ? nextArgs : namedForCarry(selected.lane, nextArgs);
          handedOn = { carriedId, pointAt, workFrom, told, workArgs: workFrom === previousLane ? ranWith : handedOn.workArgs };

          if (pointAt && told && result.authFailed && !failedLaneHeldSession) {
            say(failedLaneWasTold
              ? '[switchboard] It is pointed at the same handoff the failed lane was given.'
              : '[switchboard] It is pointed at the handoff written earlier in this run.');
          }
          else if (pointAt === 'ours' && told && !changesTool) say('[switchboard] This lane picks up from that handoff.');
          if (pointAt === 'ours' && !told) {
            say('[switchboard] A handoff was written, but this caller\'s input leaves no safe place to point the next lane at it, so that lane starts from the request alone.');
          }

          // Said on every hop that changes tool, in these words, whichever branch above
          // handled it. A caller that handed over one process has nowhere else to learn
          // that the answer came from a different tool, and it matters to them: the new
          // tool does not have the conversation the old one was holding. The wording is a
          // contract, because the Slack bridge reads it to tell people a reply lost its
          // thread. It used to be printed only where no handoff was found, so the usual hop
          // (a handoff written from the spent session, then --yes) and a hop after a
          // refused sign-in both changed tool without ever saying so. It is said here, last,
          // so that it is only ever said about a hop that is really going to happen.
          //
          // Judged against the tool whose work it is, not a lane that never started: work
          // carried back to its own tool past a refused lane has not lost its thread. And
          // said once: a lane of the same tool after a refused one is no further change.
          if (newTool) {
            say(`[switchboard] Cross-provider failover: ${workTool.harness} to ${selected.lane.harness} (lane ${selected.lane.id}).`);
          }
        } else {
          process.exitCode = result.code;
          return;
        }
      }

      return;
    }
    // The whole picture in one screen: what each tool will use next, whether that
    // account is signed in, and how much of its allowance is left. This is the only
    // view of the machine available from somewhere else, so it errs towards detail.
    case 'status': {
      const settings = loadSettings();
      const status = await collectStatus({ registry, settings });
      if (args.includes('--json')) {
        // One word per lane for scripts (live, dead, unreadable, none). Never the value.
        status.laneTokens = Object.fromEntries((settings.lanes ?? []).map((lane) => [lane.id, laneTokenState(settings, lane.id)]));
        out(JSON.stringify(status, null, 2));
        return;
      }
      out(formatStatus(status));
      return;
    }
    case 'accounts': {
      if (registry.accounts.length === 0) { out(`No accounts registered. Add one: switchboard add <${providerList}> <label> [folder]`); return; }
      for (const a of registry.accounts) {
        const active = activeAccount(registry, a.provider)?.id === a.id;
        out(`${active ? '*' : ' '} ${a.id}  [${a.provider}] ${a.label}  ${a.home}${a.color ? `  ${a.color}` : ''}`);
      }
      return;
    }
    case 'add': {
      const [provider, label, home] = args;
      if (!PROVIDERS[provider]) { out(`Unknown provider. Use one of: ${providerList}`); process.exitCode = 1; return; }
      // Tools whose variable names the folder ABOVE the config folder get it appended,
      // so a person can pass the folder they think of as the account.
      // No folder means an account that has never signed in here, so one is made for it.
      const account = home
        ? addAccount(registry, { provider, label, home: normalizeHome(provider, home) })
        : createAccount(registry, { provider, label });
      saveRegistry(registry);
      out(`registered ${account.id} (${account.home})`);
      if (!home) out(`Sign it in: run ${PROVIDERS[provider].loginHint} with ${PROVIDERS[provider].envVar} set to ${envValueForHome(PROVIDERS[provider], account.home)}`);
      return;
    }
    case 'remove': {
      const removed = removeAccount(registry, args[0]);
      saveRegistry(registry);
      out(`removed ${removed.id} (the folder was not touched)`);
      return;
    }
    case 'use': {
      const wanted = args[0];
      const account = registry.accounts.find((a) => a.id === wanted)
        || registry.accounts.find((a) => a.provider === args[0] && a.label.toLowerCase() === String(args[1] || '').toLowerCase());
      if (!account) { out('No matching account. See: switchboard accounts'); process.exitCode = 1; return; }
      setActive(registry, account.id);
      out(`New terminals and apps will use ${PROVIDERS[account.provider].name} account "${account.label}". Running processes are unchanged.`);
      const current = loadSettings();
      if (defaultFollowsLanes(current, account.provider)) out(switchedAgainstLanesNote(PROVIDERS[account.provider].name, ranksByReset(current, account.provider, registry.accounts), Boolean(PROVIDERS[account.provider].quota)));
      return;
    }
    // The color the window and tray show an account in. Here as well as in the window so a
    // machine set up from a script can match T3 Code without opening anything.
    case 'color': {
      if (args[0] === '--from-t3') {
        const colors = matchT3Colors(registry, readT3Instances());
        const ids = Object.keys(colors);
        if (!ids.length) { out('T3 Code has no color for any registered account folder.'); return; }
        for (const id of ids) {
          setAccountColor(registry, id, colors[id]);
          out(`${id}  ${colors[id]}`);
        }
        saveRegistry(registry);
        return;
      }
      const [id, value] = args;
      // The # is optional because a shell reads "#2563eb" after a space as a comment, so
      // the color never arrives. The usage line says so, since that is where it bites.
      if (!id || value == null) { out('Usage: switchboard color <id> <hex|none>, for example: switchboard color claude-work 2563eb. Or: switchboard color --from-t3'); process.exitCode = 1; return; }
      const account = setAccountColor(registry, id, value === 'none' ? null : value);
      saveRegistry(registry);
      out(account.color ? `${account.id} is shown in ${account.color}` : `${account.id} has no color now`);
      return;
    }
    case 'detect': {
      const found = [...detectDefaults(registry), ...detectCandidates(registry)];
      if (found.length === 0) { out('Nothing new to register.'); return; }
      for (const f of found) {
        const account = addAccount(registry, f);
        out(`registered ${account.id} (${account.home})`);
      }
      saveRegistry(registry);
      return;
    }
    case 'providers': {
      for (const t of await detectAll()) {
        out(`${t.installed ? 'installed  ' : 'missing    '} ${t.name}${t.version ? `  ${t.version}` : ''}${t.installed && t.bin && !t.onPath ? '  (not on PATH)' : ''}`);
        if (!t.installed) out(`             ${t.install.via === 'manual' ? 'get it at: ' + t.install.url : 'install: ' + t.install.cmd}`);
      }
      return;
    }
    case 'doctor': {
      const installedIds = new Set((await detectInstalled()).filter((t) => t.installed).map((t) => t.id));
      const checks = await runChecks({ accounts: registry.accounts, settings: loadSettings(), isInstalled: (id) => installedIds.has(id), t3LeaseSha: currentLeaseSha() });
      const mark = { ok: 'OK  ', info: 'INFO', warn: 'WARN', bad: 'FAIL' };
      for (const c of checks) out(`${mark[c.level]}  ${c.title}\n      ${c.detail}`);
      if (checks.some((c) => c.level === 'bad')) process.exitCode = 1;
      return;
    }
    case 'quota': {
      const settings = loadSettings();
      const allAccounts = await resolveAllAccounts(registry);
      for (const a of allAccounts) {
        const def = PROVIDERS[a.provider];
        if (!def?.quota && a.provider !== 'antigravity') continue;
        out(`${a.label} (${a.home})`);
        const q = await sharedProviderQuota(a, { usageSource: settings.usageSources[a.id] ?? null });
        if (q.error === 'no-credentials') out('  usage unavailable: no access credential or matching Claude Desktop sample');
        else if (q.error === 'auth') out('  quota unavailable: the sign-in needs a refresh (run this account once, or re-authenticate it in Switchboard)');
        else if (q.error === 'no-usage-data') out('  no usage recorded yet: run this account once and the figures appear');
        else if (q.error) out('  quota unavailable right now');
        else {
          q.windows.forEach((w) => out(fmtWindow(w)));
          if (q.source === 'session-log') out(`  (from this account's last session, ${new Date(q.sampledAt).toLocaleString()})`);
        }
      }
      for (const def of Object.values(PROVIDERS)) {
        if (def.quota || !registry.accounts.some((a) => a.provider === def.id)) continue;
        out(`${def.name}: ${def.quotaNote}`);
      }
      return;
    }
    // Editing the failover pool. The Lanes tab is the only other way to do this, and a
    // machine with no desktop has no Lanes tab.
    case 'lanes': {
      const [sub, ...rest] = args;
      const settings = loadSettings();
      const allAccounts = await resolveAllAccounts(registry);

      if (!sub || sub === 'list' || sub === '--json') {
        if (args.includes('--json')) {
          // setupToken is one word per lane (live, dead, unreadable, none), never the value.
          out(JSON.stringify({ lanes: settings.lanes.map((lane) => ({ ...lane, setupToken: laneTokenState(settings, lane.id) })), spendPolicies: settings.spendPolicies }, null, 2));
          return;
        }
        if (!settings.lanes.length) {
          out('No lanes configured. Add one: switchboard lanes add <accountId>');
          out('Account ids come from: switchboard accounts');
          return;
        }
        // The list is the order as set, which is not the order a run takes on "Switch
        // automatically", so the heading says which one applies rather than correcting
        // itself on the line after.
        out(ordersBySoonestReset(settings)
          ? 'Lanes in the order as set. The watch is set to switch automatically, so the subscription accounts of a tool whose usage Switchboard reads are taken soonest weekly reset first; this order decides everything else, including which tool comes first.'
          : 'Lanes in priority order; the first healthy one gets the work.');
        settings.lanes.forEach((lane, i) => {
          const account = allAccounts.find((a) => a.id === lane.accountId);
          const budget = settings.spendPolicies?.[lane.id]?.budget ?? null;
          // A lane that can never be selected is called out here rather than left to be
          // discovered by a run that quietly skips it.
          const money = lane.billing !== 'metered' ? 'subscription'
            : budget ? `metered, budget ${budget}`
            : 'metered, NO BUDGET so it can never be selected';
          const who = account ? account.label : 'UNREGISTERED ACCOUNT, so it can never be selected';
          out(`${String(i + 1).padStart(2)}. ${lane.id}`);
          out(`    ${lane.harness} / ${lane.provider}  ${who} (${lane.accountId})  ${money}`);
        });
        return;
      }

      if (sub === 'add') {
        let wanted;
        try {
          wanted = parseLaneAddArgs(rest);
        } catch (e) {
          out(String(e.message || e));
          process.exitCode = 1;
          return;
        }
        try {
          const added = addLane(settings, wanted, allAccounts);
          const withBudget = wanted.budget === null
            ? added.settings
            : setLaneBudget(added.settings, added.lane.id, wanted.budget);
          saveSettings(withBudget);
          out(`added ${added.lane.id} (${added.lane.harness} / ${added.lane.provider}, ${added.lane.billing}) at the end of the pool`);
          if (wanted.budget !== null) out(`  budget ${Number(wanted.budget)}`);
          return;
        } catch (e) {
          out(String(e.message || e));
          process.exitCode = 1;
          return;
        }
      }

      if (sub === 'remove') {
        try {
          saveSettings(removeLane(settings, rest[0]));
          out(`removed ${rest[0]} (the account itself is untouched)`);
          return;
        } catch (e) {
          out(String(e.message || e));
          process.exitCode = 1;
          return;
        }
      }

      if (sub === 'order') {
        // A typo must not silently reorder nothing, so unknown ids are refused before
        // anything is written. Ids left out keep their order at the end.
        if (!rest.length) { out('name the lane ids in the order you want them'); process.exitCode = 1; return; }
        const missing = unknownLaneIds(settings, rest);
        if (missing.length) { out(`no lane with id: ${missing.join(', ')}`); process.exitCode = 1; return; }
        const next = reorderLanes(settings, rest);
        saveSettings(next);
        next.lanes.forEach((lane, i) => out(`${String(i + 1).padStart(2)}. ${lane.id}  ${lane.accountId}`));
        return;
      }

      if (sub === 'budget') {
        const [laneId, amount] = rest;
        try {
          const value = amount === 'none' || amount === undefined ? null : amount;
          saveSettings(setLaneBudget(settings, laneId, value));
          out(value === null
            ? `cleared the budget on ${laneId}, which blocks a metered lane`
            : `${laneId} may spend up to ${Number(value)}`);
          return;
        } catch (e) {
          out(String(e.message || e));
          process.exitCode = 1;
          return;
        }
      }

      out('switchboard lanes <list|add|remove|order|budget>');
      out('  lanes [--json]                        the pool, in the order as set');
      out(`  lanes add <accountId> [--metered] [--budget <n>]   append a lane (billing: ${BILLING_KINDS.join('|')})`);
      out('  lanes remove <laneId>                 take a lane out of the pool');
      out('  lanes order <laneId>...               reorder; ids left out keep their order at the end');
      out('  lanes budget <laneId> <amount|none>   what a metered lane may spend');
      process.exitCode = 1;
      return;
    }
    // The token a lane hands to automation. It rides ALONGSIDE the folder sign-in,
    // never instead of it: selection still needs the folder signed in, and a token that
    // dies only reverts automation to folder mode, which is today's working behaviour.
    case 'lane-token': {
      const settings = loadSettings();
      const laneId = args.find((a) => !a.startsWith('--'));

      // Every Claude lane without a live token, one mint after another. Each mint waits
      // on a browser approval and a paste, so it stays interactive, and settings are
      // re-read per lane because each mint saves.
      if (args.includes('--missing')) {
        const missing = claudeLanesWithoutToken(settings);
        if (!missing.length) { out('Every Claude lane holds a live setup token.'); return; }
        out(`${missing.length} Claude lane${missing.length === 1 ? '' : 's'} without a live setup token: ${missing.map((l) => l.id).join(', ')}. Each mint opens a browser approval, and the token is pasted back here.`);
        const failed = [];
        for (const [i, lane] of missing.entries()) {
          out('');
          out(`Lane ${i + 1} of ${missing.length}: ${lane.id}`);
          const ok = await mintLaneToken({ laneId: lane.id, registry, settings: loadSettings() });
          if (!ok) failed.push(lane.id);
        }
        out('');
        if (failed.length) {
          out(`Not stored for: ${failed.join(', ')}. Run switchboard lane-token --missing again for those.`);
          process.exitCode = 1;
        } else {
          out('Every Claude lane now holds a setup token.');
        }
        return;
      }

      if (!laneId) {
        out('switchboard lane-token <laneId> [--remove|--check]');
        out('switchboard lane-token --missing');
        out('  with no flag, mints a token for the lane\'s account via "claude setup-token" and stores it');
        out('  --remove   delete the stored token (the account sign-in is untouched)');
        out('  --check    ask the vendor whether the stored token is still honoured');
        out('  --missing  mint for every Claude lane that holds no live token, one after another');
        out('  --from-env store the token in SWITCHBOARD_NEW_LANE_TOKEN instead of minting (used by the Health panel window)');
        process.exitCode = 1;
        return;
      }

      if (args.includes('--remove')) {
        try {
          saveSettings(removeLaneToken(settings, laneId));
          out(`removed the lane token for ${laneId} (the account sign-in is untouched)`);
        } catch (e) {
          out(String(e.message || e));
          process.exitCode = 1;
        }
        return;
      }

      if (args.includes('--check')) {
        const entry = settings.laneTokens?.[laneId];
        if (!entry) { out(`no lane token for "${laneId}"`); process.exitCode = 1; return; }
        if (entry.dead) {
          out(`the token for ${laneId} is already marked dead (${entry.deadReason ?? 'no reason recorded'}). Mint a new one with: switchboard lane-token ${laneId}`);
          process.exitCode = 1;
          return;
        }
        // A malformed entry (a non-string or empty token, from settings edited by
        // hand) would be skipped by validateLaneTokens as unusable, and the empty
        // result would then fall through to the network-failure line below with exit
        // 0, claiming a check ran when no request was ever made.
        if (typeof entry.token !== 'string' || entry.token.length === 0) {
          out(`no usable token is stored for ${laneId}. Mint one with: switchboard lane-token ${laneId}`);
          process.exitCode = 1;
          return;
        }
        const checked = await validateLaneTokens(settings, { laneIds: [laneId] });
        // Settings are re-read and merged per lane: the check spends time on the
        // network, and a concurrent mint or removal must not be reverted by saving
        // this command's stale snapshot over it.
        if (checked.changed) saveSettings(mergeLaneTokenResults(loadSettings(), checked));
        const outcome = checked.results.find((r) => r.laneId === laneId)?.outcome;
        if (outcome === 'dead') {
          out(`the token for ${laneId} was revoked or expired, so the lease broker and automation get no token from this lane (terminals on this machine still use its folder sign-in). Mint a new one with: switchboard lane-token ${laneId}`);
          process.exitCode = 1;
          return;
        }
        if (outcome === 'ok') { out(`the token for ${laneId} is still honoured`); return; }
        out('the check could not run (network or endpoint failure). Failing to read the meter is not an empty tank, so the token is kept.');
        return;
      }

      const ok = await mintLaneToken({ laneId, registry, settings, fromEnv: args.includes('--from-env') });
      if (!ok) process.exitCode = 1;
      return;
    }
    // The quota watch, without the tray. Reads every account a decision could name, then
    // either reports the switch or performs it.
    case 'watch': {
      let parsed;
      try {
        parsed = parseWatchArgs(args);
      } catch (e) {
        out(String(e.message || e));
        process.exitCode = 1;
        return;
      }

      const mode = parsed.mode ?? loadSettings().quotaWatch;
      if (mode !== 'notify' && mode !== 'auto') {
        out('The quota watch is off. Run one pass with: switchboard watch --once --mode notify');
        out('  notify reports what "Tell me" would suggest; auto switches the machine default as "Switch automatically" does.');
        process.exitCode = 1;
        return;
      }
      if (mode === 'auto' && !DEFAULT_SWITCH_PERSISTS) {
        out(`Note: on ${process.platform} a changed default cannot outlive this command, so auto mode reports rather than switches.`);
      }

      const runPass = async () => {
        const { decisions, thresholdEvents, accounts } = await watchPass({
          mode,
          apply: mode === 'auto',
        });
        if (parsed.json) {
          out(JSON.stringify({ at: new Date().toISOString(), mode, decisions, thresholdEvents }));
          return;
        }
        const stamp = new Date().toLocaleString();
        for (const ev of (thresholdEvents || [])) {
          out(`${stamp}  ${formatNotificationText(ev)}`);
        }
        if (!decisions.length && !(thresholdEvents || []).length) { out(`${stamp}  nothing to do`); return; }
        for (const decision of decisions) out(`${stamp}  ${formatDecision(decision, accounts)}`);
      };

      await runPass();
      if (parsed.once) return;

      // Deliberately a plain timer rather than a service, so Task Scheduler or cron can
      // run --once instead if that suits better. A pass that throws must not end the
      // watch: the next one may well succeed.
      out(`Watching every ${parsed.intervalMinutes} minute${parsed.intervalMinutes === 1 ? '' : 's'}. Stop with Ctrl-C.`);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, parsed.intervalMinutes * 60 * 1000));
        try {
          await runPass();
        } catch (e) {
          process.stderr.write(`${new Date().toLocaleString()}  watch pass failed: ${String(e.message || e)}\n`);
        }
      }
    }
    // Notification hooks: configure or test webhook / command alerts for threshold crossings.
    case 'notify': {
      let parsed;
      try {
        parsed = parseNotifyArgs(args);
      } catch (e) {
        out(String(e.message || e));
        process.exitCode = 1;
        return;
      }

      let settings = loadSettings();
      let changed = false;

      if (parsed.webhook !== undefined) {
        settings.notifyWebhookUrl = parsed.webhook;
        changed = true;
      }
      if (parsed.command !== undefined) {
        settings.notifyCommand = parsed.command;
        changed = true;
      }
      if (parsed.thresholds && Object.keys(parsed.thresholds).length > 0) {
        settings.thresholds = { ...settings.thresholds, ...parsed.thresholds };
        changed = true;
      }

      if (changed) {
        saveSettings(settings);
      }

      if (parsed.test) {
        const testPayload = buildNotificationPayload({
          kind: 'test',
          event: 'test_notification',
          provider: 'claude',
          accountId: 'test',
          accountLabel: 'Test Account',
          window: 'session',
          windowLabel: 'Session (5h)',
          usedPercent: 82,
          threshold: settings.thresholds?.session ?? DEFAULT_THRESHOLDS.session,
          resetsAt: Date.now() + 2 * 3600 * 1000,
        });
        const result = await dispatchNotification(settings, testPayload);
        if (parsed.json) {
          out(JSON.stringify({ test: true, result, settings: { webhook: settings.notifyWebhookUrl, command: settings.notifyCommand, thresholds: settings.thresholds } }, null, 2));
        } else {
          out('Dispatched test notification:');
          out(`  Message: ${testPayload.text}`);
          if (result.webhook) {
            out(`  Webhook: ${result.webhook.ok ? `OK (${result.webhook.status})` : `FAILED (${result.webhook.error || result.webhook.status})`}`);
          } else {
            out('  Webhook: not configured');
          }
          if (result.command) {
            out(`  Command: ${result.command.ok ? 'OK (spawned)' : `FAILED (${result.command.error})`}`);
          } else {
            out('  Command: not configured');
          }
        }
        return;
      }

      if (parsed.json) {
        out(JSON.stringify({
          webhook: settings.notifyWebhookUrl,
          command: settings.notifyCommand,
          thresholds: settings.thresholds ?? DEFAULT_THRESHOLDS,
        }, null, 2));
        return;
      }

      out('Switchboard notification hooks:');
      out(`  Webhook:    ${settings.notifyWebhookUrl || '(none)'}`);
      out(`  Command:    ${settings.notifyCommand || '(none)'}`);
      out(`  Thresholds: session=${settings.thresholds?.session ?? DEFAULT_THRESHOLDS.session}% week=${settings.thresholds?.week ?? DEFAULT_THRESHOLDS.week}%`);
      out('');
      out('Configure with:');
      out('  switchboard notify --webhook <url|none>');
      out('  switchboard notify --command <cmd|none>');
      out('  switchboard notify --threshold session=80 --threshold week=85');
      out('  switchboard notify --test');
      return;
    }
    case 'mcp': {
      const sub = args[0] ?? 'list';
      const reg = loadServers();
      // Sharing servers across accounts runs before anything reads the lists, the same as
      // opening the MCP tab, so the terminal and the tray report the same thing. A file it
      // had to leave alone is said out loud rather than skipped in silence.
      const share = () => {
        const res = syncClientAccountMirrors(reg);
        // On standard error under --json, so a script parsing the answer gets only JSON.
        const tell = args.includes('--json') ? (msg) => process.stderr.write(msg + '\n') : out;
        for (const s of res.skipped) tell(`Left alone: ${s.file} (${s.reason})`);
        return res;
      };
      if (sub === 'sync') {
        const res = share();
        if (args.includes('--json')) {
          out(JSON.stringify(res, null, 2));
          return;
        }
        const changed = [...res.claude, ...res.antigravity];
        out(changed.length ? changed.map((f) => `Updated ${f} (backup kept beside it)`).join('\n') : 'Every list already had every server.');
        return;
      }
      if (sub === 'list' || sub === '--json') {
        share();
        const clients = await Promise.all(
          Object.values(MCP_CLIENTS).map(async (c) => ({ id: c.id, name: c.name, available: await clientAvailable(c.id) })),
        );
        const usable = clients.filter((c) => c.available).map((c) => c.id);
        const rows = registrationMatrix(activeServers(reg, usable), usable);
        if (args.includes('--json')) {
          out(JSON.stringify({ clients, servers: rows }, null, 2));
          return;
        }
        out(`Clients: ${clients.map((c) => `${c.id}(${c.available ? 'ready' : 'missing'})`).join(', ')}`);
        for (const r of rows) {
          const states = usable.map((id) => `${id}:${r.state[id]}`).join(' ');
          const target = r.url || (r.command ? `stdio:${r.command}` : '');
          out(`  ${r.name.padEnd(20)} ${states}  ${target}`);
        }
        return;
      }
      if (sub === 'add') {
        const parsed = parseMcpAddArgs(args.slice(1));
        const server = addServer(reg, { ...parsed, label: parsed.name });
        saveServers(reg);
        out(`Added MCP server ${server.name}`);
        return;
      }
      if (sub === 'remove') {
        const name = args[1];
        if (!name) throw new Error('usage: switchboard mcp remove <name>');
        removeServer(reg, name);
        saveServers(reg);
        out(`Removed MCP server ${name} from Switchboard registry`);
        return;
      }
      if (sub === 'register') {
        const name = args[1];
        const target = args[2] ?? 'all';
        if (!name) throw new Error('usage: switchboard mcp register <name> [client|all]');
        const server = resolveServerByName(name, reg);
        const ids = target === 'all'
          ? (await Promise.all(Object.keys(MCP_CLIENTS).map(async (id) => ((await clientAvailable(id)) ? id : null)))).filter(Boolean)
          : [target];
        // With `all`, one client refusing (Slack outside Claude, a CLI that fails to sign
        // in) is reported and the rest still get the server; the command then fails, so a
        // script calling it can tell.
        const failures = [];
        for (const id of ids) {
          if (target === 'all' && registeredNames(id).includes(server.name)) {
            out(`${id}: already has ${server.name}`);
            continue;
          }
          if (target === 'all' && !supportsClient(server, id)) {
            out(`${id}: skipped, ${server.name} cannot be used from it`);
            continue;
          }
          try {
            const res = await registerServer(id, server);
            out(`${id}: registered ${res.server}`);
          } catch (e) {
            if (target !== 'all') throw e;
            failures.push(`${id}: ${e.message}`);
          }
        }
        share();
        if (failures.length) throw new Error(failures.join('; '));
        return;
      }
      if (sub === 'unregister') {
        const name = args[1];
        const target = args[2] ?? 'all';
        if (!name) throw new Error('usage: switchboard mcp unregister <name> [client|all]');
        const ids = target === 'all' ? Object.keys(MCP_CLIENTS) : [target];
        for (const id of ids) {
          if (target === 'all' && !registeredNames(id).includes(name)) continue;
          await unregisterServer(id, { name });
          out(`${id}: unregistered ${name}`);
        }
        return;
      }
      if (sub === 'disable') {
        const res = await disableServer(args[1]);
        out(`Disabled ${res.name} in ${res.clients.join(', ')}`);
        for (const f of res.failed) out(`  not changed: ${f}`);
        return;
      }
      if (sub === 'enable') {
        const res = enableServer(args[1]);
        out(`Enabled ${res.name} in ${res.clients.join(', ')}`);
        for (const f of res.failed) out(`  not changed: ${f}`);
        return;
      }
      throw new Error(`unknown mcp subcommand: ${sub}. Use list|add|remove|register|unregister|disable|enable|sync`);
    }
    case 'customizations':
    case 'skills':
    case 'plugins': {
      const sub = args[0] ?? 'list';
      const installedIds = (await detectInstalled()).filter((t) => t.installed).map((t) => t.id);

      if (sub === 'list' || sub === '--json') {
        const snap = customizationsSnapshot({ installedToolIds: installedIds });
        if (args.includes('--json')) {
          const { mcpServerTools, ...serializable } = snap;
          out(JSON.stringify(serializable, null, 2));
          return;
        }
        const avail = snap.clients.filter((c) => c.available);
        out(`Eligible Providers (${avail.length}): ${avail.map((c) => `${c.id}${c.accountCount > 1 ? `*${c.accountCount}` : ''}`).join(', ')}`);
        out(`Installed Plugins (${snap.plugins.length}):`);
        for (const p of snap.plugins) {
          const active = avail.filter((c) => p.state[c.id] === 'on').map((c) => c.id).join(', ') || 'off';
          out(`  ${p.name.padEnd(28)} [${active}]  ${p.description.slice(0, 72)}`);
        }
        out(`Installed Skills (${snap.skills.length}):`);
        for (const s of snap.skills) {
          const active = avail.filter((c) => s.state[c.id] === 'on').map((c) => c.id).join(', ') || 'off';
          out(`  ${(`/${s.name}`).padEnd(28)} [${active}]  ${s.description.slice(0, 72)}`);
        }
        out(`Global Rules (${snap.rules.instructionFiles.length} provider files, ${snap.rules.snippets.length} snippets):`);
        for (const r of snap.rules.instructionFiles) {
          out(`  ${(`${r.clientId}:${r.fileName}`).padEnd(28)} ${r.exists ? `${r.sizeBytes}B` : 'missing'}`);
        }
        out(`Custom Agents (${snap.agents.length}):`);
        for (const a of snap.agents) {
          const active = avail.filter((c) => a.state[c.id] === 'on').map((c) => c.id).join(', ') || 'off';
          out(`  ${a.name.padEnd(28)} [${active}]  model=${a.model}`);
        }
        out(`Trusted Marketplace Catalog: ${snap.marketplaceCount} items available`);
        return;
      }

      if (sub === 'marketplace' || sub === 'browse') {
        const query = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
        const items = searchMarketplace(loadMarketplaceCatalog(), { query });
        if (args.includes('--json')) {
          out(JSON.stringify(items, null, 2));
          return;
        }
        out(`Marketplace (${items.length} matching items):`);
        for (const item of items.slice(0, 40)) {
          const badges = (item.sources ?? []).join('+');
          out(`  ${item.name.padEnd(30)} [${item.kind} | ${badges}]  ${(item.description || '').slice(0, 65)}`);
        }
        return;
      }

      if (sub === 'install') {
        const target = args[1];
        if (!target) throw new Error('usage: switchboard customizations install <name|owner/repo> [client|all]');
        const clientArg = args[2];
        const clients = clientArg && clientArg !== 'all' ? [clientArg] : [];
        if (target.includes('/') || target.startsWith('http')) {
          const res = await installFromGitHub(target, { clients, installedToolIds: installedIds });
          out(`Installed ${res.name} from ${res.repository} into ${res.clients.join(', ')}`);
        } else {
          const res = installMarketplaceItem(target, { clients, installedToolIds: installedIds });
          out(`Installed ${res.name} (${res.kind}) into ${res.clients.join(', ')}`);
        }
        return;
      }

      if (sub === 'enable-skill' || sub === 'disable-skill') {
        const skillName = args[1];
        const clientId = args[2];
        if (!skillName || !clientId) {
          throw new Error(`usage: switchboard customizations ${sub} <skillName> <clientId>`);
        }
        const enabled = sub === 'enable-skill';
        const res = setSkillClientState(skillName, clientId, enabled, { installedToolIds: installedIds });
        out(`${enabled ? 'Enabled' : 'Disabled'} skill /${res.skill} for ${res.client}`);
        return;
      }

      if (sub === 'enable-agent' || sub === 'disable-agent') {
        const agentName = args[1];
        const clientId = args[2];
        if (!agentName || !clientId) {
          throw new Error(`usage: switchboard customizations ${sub} <agentName> <clientId>`);
        }
        const enabled = sub === 'enable-agent';
        const res = setAgentClientState(agentName, clientId, enabled, { installedToolIds: installedIds });
        out(`${enabled ? 'Enabled' : 'Disabled'} agent ${res.agent} for ${res.client}`);
        return;
      }

      throw new Error(`unknown customizations subcommand: ${sub}. Use list|marketplace|install|enable-skill|disable-skill|enable-agent|disable-agent`);
    }
    case 'automations': {
      const sub = args[0] ?? 'list';
      const state = loadAutomations();
      if (sub === 'list' || sub === '--json') {
        if (args.includes('--json')) {
          out(JSON.stringify(state.automations, null, 2));
          return;
        }
        out(`Automations (${state.automations.length} low-level provider-agnostic routines):`);
        for (const a of state.automations) {
          out(`  ${a.enabled ? '*' : '-'} ${a.id.padEnd(26)} every ${a.intervalMinutes}m  ${a.name}  [${a.lastStatus || 'never-run'}]`);
        }
        return;
      }
      if (sub === 'add') {
        const name = args[1];
        const prompt = args[2];
        const intervalMinutes = Number(args[3]) || 1440;
        const item = addAutomation(state, { name, prompt, intervalMinutes });
        saveAutomations(state);
        out(`Added automation ${item.id} (${item.name}, every ${item.intervalMinutes}m)`);
        return;
      }
      if (sub === 'remove') {
        const id = args[1];
        if (!id) throw new Error('usage: switchboard automations remove <id>');
        removeAutomation(state, id);
        saveAutomations(state);
        out(`Removed automation ${id}`);
        return;
      }
      if (sub === 'toggle') {
        const id = args[1];
        if (!id) throw new Error('usage: switchboard automations toggle <id>');
        const item = toggleAutomation(state, id);
        saveAutomations(state);
        out(`Automation ${item.id} is now ${item.enabled ? 'enabled' : 'disabled'}`);
        return;
      }
      throw new Error(`unknown automations subcommand: ${sub}. Use list|add|remove|toggle`);
    }
    case 'gateway': {
      const sub = args[0] ?? 'status';
      const asJson = args.includes('--json');
      const gwServer = createGatewayServer();
      if (sub === 'status' || sub === '--json') {
        const st = await gwServer.status();
        if (asJson) {
          out(JSON.stringify(st, null, 2));
          return;
        }
        out(`Gateway: ${st.enabled ? 'enabled' : 'disabled'} (${st.endpointUrl})`);
        out(`  Scope: ${GATEWAY_SCOPE_LABELS[st.scope] ?? st.scope}`);
        out(`  Claude route: ${st.routes.claude.primary ? `${st.routes.claude.primary.accountLabel} (+${st.routes.claude.standbyCount} standby)` : 'no signed-in account'}`);
        out(`  Codex route:  ${st.routes.codex.primary ? `${st.routes.codex.primary.accountLabel} (+${st.routes.codex.standbyCount} standby)` : 'no signed-in account'}`);
        out(`  Issued keys:  ${st.keys.length}`);
        return;
      }
      // One command for what the Gateway tab does in clicks: broker on, a key with the
      // gateway's scope, the key file here and in every WSL distro, the wrapper there.
      // Then the two things only a person may decide, each asked (or --yes): the tray
      // starting with Windows, and a lane for each Claude account without one. Prints
      // one line per step and never the key.
      if (sub === 'provision-client') {
        const yes = args.includes('--yes') || args.includes('-y');
        const replaceSymlink = args.includes('--replace-symlink');
        const labelAt = args.indexOf('--label');
        const label = labelAt >= 0 ? String(args[labelAt + 1] ?? '').trim() : '';
        const say = (line) => { if (!asJson) out(line); };
        const report = { gateway: null, key: null, localKeyPath: null, distros: [], broker: null, lanesWithoutToken: [], notes: [] };

        const enabled = gatewayEnabledSettings(loadSettings());
        const chosen = chooseProvisionKey(enabled.settings, { label, scope: enabled.scope });
        saveSettings(chosen.settings);
        report.gateway = { enabled: true, wasEnabled: enabled.wasEnabled, fresh: enabled.fresh, scope: enabled.scope, port: enabled.port };
        report.key = { ...chosen.key, created: chosen.created, scopeChanged: chosen.scopeChanged, previousScope: chosen.previousScope };
        say(`Gateway: ${enabled.wasEnabled ? 'already on' : 'turned on'} (scope ${enabled.scope}, port ${enabled.port}; ${enabled.fresh ? 'never configured before, so the default scope' : 'the scope was left as it was'})`);
        say(`Key: ${chosen.key.label} (${chosen.key.id}) ${chosen.created ? 'created' : 'reused'} with scope ${chosen.key.scope}${chosen.scopeChanged ? `, was ${chosen.previousScope}. A key is checked against its own scope, so it now matches the gateway.` : ''}`);

        const provisioned = await provisionLocalAndWslClient({ token: chosen.secret, leaseScriptPath: path.join(here, 'switchboard-lease'), replaceSymlink });
        report.localKeyPath = provisioned.localKeyPath;
        report.distros = provisioned.distros;
        say(`Key file here: ${provisioned.localKeyPath}`);
        if (process.platform === 'win32' && !provisioned.distros.length) say('WSL: no distro found (wsl --list --quiet), so nothing was installed there.');
        for (const d of provisioned.distros) say(`  ${d.name}: ${describeDistroProvision(d)}`);

        const brokerBase = `http://127.0.0.1:${enabled.port}`;
        const broker = await probeBrokerInfo(`${brokerBase}/v1/info`, chosen.secret);
        report.broker = { url: brokerBase, state: broker };
        if (broker === 'ready') say(`Broker: answers at ${brokerBase} with this key.`);
        else if (broker === 'rejected') say(`Broker: answers at ${brokerBase} but refused this key, so the tray still holds an older key list. Restart Switchboard.`);
        else say(`Broker: nothing answers at ${brokerBase} yet. A running tray applies the setting within seconds; otherwise start Switchboard.`);

        // The broker lives in the tray, so a tray that does not start with Windows leaves
        // every caller without lanes after a restart. Asked, never assumed. Only the
        // packaged app has an exe to register; a checkout run with node has not.
        if (process.platform === 'win32' && /switchboard\.exe$/i.test(process.execPath) && (await loginItemPresent()) === false) {
          say('Switchboard does not start with Windows yet, and the broker runs inside the tray, so every caller loses its lanes after a restart.');
          if (await askYes('Start Switchboard with Windows?', { yes, quiet: asJson })) {
            const added = await addLoginItem(process.execPath);
            say(added ? 'Switchboard now starts with Windows.' : 'Could not write the Run entry; turn on "Start with Windows" in the tray menu.');
            report.notes.push(added ? 'start-with-windows: enabled' : 'start-with-windows: failed');
          } else {
            report.notes.push('start-with-windows: declined');
          }
        }

        // An account without a lane cannot be lent. Optional, asked per account.
        const allAccounts = await resolveAllAccounts(registry);
        for (const a of allAccounts.filter((x) => x.provider === 'claude' && !(loadSettings().lanes ?? []).some((l) => l.accountId === x.id))) {
          if (!(await askYes(`Claude account "${a.label}" (${a.id}) has no lane, so the broker cannot lend it. Add a subscription lane for it?`, { yes, quiet: asJson }))) continue;
          try {
            const added = addLane(loadSettings(), { accountId: a.id }, allAccounts);
            saveSettings(added.settings);
            say(`  added lane ${added.lane.id} for ${a.label}`);
            report.notes.push(`lane-added: ${added.lane.id}`);
          } catch (e) {
            say(`  could not add a lane for ${a.id}: ${String(e.message || e)}`);
          }
        }

        const missing = claudeLanesWithoutToken(loadSettings());
        report.lanesWithoutToken = missing.map((l) => l.id);
        if (missing.length) say(`Lanes without a live setup token, which the broker cannot lend yet: ${missing.map((l) => l.id).join(', ')}. Mint them with: switchboard lane-token --missing`);
        if (asJson) out(JSON.stringify(report, null, 2));
        return;
      }
      if (sub === 'scope') {
        const wanted = args[1];
        if (!wanted) throw new Error('usage: switchboard gateway scope <localhost|localhost-wsl|lan>');
        const clean = normalizeGatewayScope(wanted);
        const s = loadSettings();
        s.gateway = { ...normalizeGatewaySettings(s.gateway), scope: clean };
        saveSettings(s);
        out(`Gateway scope set to ${clean} (${GATEWAY_SCOPE_LABELS[clean]})`);
        return;
      }
      if (sub === 'port') {
        const wanted = args[1];
        if (!wanted) throw new Error('usage: switchboard gateway port <1024-65535>');
        const clean = normalizeGatewayPort(wanted);
        const s = loadSettings();
        s.gateway = { ...normalizeGatewaySettings(s.gateway), port: clean };
        saveSettings(s);
        out(`Gateway port set to ${clean}`);
        return;
      }
      if (sub === 'enable' || sub === 'disable') {
        const enabled = sub === 'enable';
        const s = loadSettings();
        s.gateway = { ...normalizeGatewaySettings(s.gateway), enabled };
        saveSettings(s);
        out(`Gateway ${enabled ? 'enabled' : 'disabled'} in settings.`);
        return;
      }
      if (sub === 'serve' || sub === 'start') {
        const s = loadSettings();
        s.gateway = { ...normalizeGatewaySettings(s.gateway), enabled: true };
        saveSettings(s);
        const st = await gwServer.start();
        out(`Switchboard Gateway listening on ${st.endpointUrl} (scope: ${st.scope}). Press Ctrl+C to stop.`);
        await new Promise((resolve) => {
          process.once('SIGINT', resolve);
          process.once('SIGTERM', resolve);
        });
        await gwServer.stop();
        return;
      }
      throw new Error(`unknown gateway subcommand: ${sub}. Use status|serve|enable|disable|scope|port|provision-client`);
    }
    // Point T3 Code environments (WSL distros, other machines over ssh) at the Claude
    // accounts the broker lends, so they need no sign-in of their own. See core/t3env.js.
    case 't3': {
      // A bare `switchboard t3`, or one with only flags, is the status.
      const sub = !args[0] || args[0].startsWith('--') ? 'status' : args[0];
      const asJson = args.includes('--json');
      if (sub === 'status') {
        // Asks each machine live unless --saved; a machine that does not answer shows its saved
        // reading with its age.
        const list = args.includes('--saved') ? currentT3Status() : await liveT3Status();
        if (asJson) { out(JSON.stringify(list, null, 2)); return; }
        if (!list.length) { out('No T3 environment set up yet. Run: switchboard t3 setup [wsl:<distro>|ssh:<host> ...]'); return; }
        for (const e of list) out(`${e.id}  ${e.state}  ${e.detail}`);
        if (list.some((e) => e.state !== 'ok')) out('Run "switchboard t3 setup --all" to bring them up to date.');
        return;
      }
      if (sub === 'sign-in') {
        const id = args[1];
        if (!id || id.startsWith('--')) throw new Error('usage: switchboard t3 sign-in <wsl:<distro>|ssh:<host>>');
        if (asJson) throw new Error('t3 sign-in is interactive (Codex shows a code to enter in your browser), so it has no --json form');
        const res = await runT3SignIn(id, { onProgress: out });
        // Only the Codex sign-ins are this command's to do; Antigravity's is done in T3.
        if (res.codex.some((x) => x.state !== 'signed-in')) process.exitCode = 1;
        return;
      }
      if (sub === 'forget') {
        const id = args[1];
        if (!id || id.startsWith('--')) throw new Error('usage: switchboard t3 forget <wsl:<distro>|ssh:<host>>');
        forgetT3(id);
        out(`Forgot ${id}. Nothing on that machine was changed.`);
        return;
      }
      if (sub === 'setup') {
        const specs = args.slice(1).filter((a) => !a.startsWith('--'));
        const all = args.includes('--all');
        const targets = await resolveT3Targets(specs, { all });
        if (!targets.length) {
          const why = all ? 'No T3 environment has been set up before, so --all has nothing to do.' : 'No WSL distro found. Name a target: switchboard t3 setup ssh:<host>';
          out(asJson ? JSON.stringify({ ok: false, error: why, reports: [] }, null, 2) : why);
          process.exitCode = 1;
          return;
        }
        const reports = await runT3Setup(targets, {
          replaceSymlink: args.includes('--replace-symlink'),
          prove: !args.includes('--no-proof'),
          onProgress: (line) => { if (!asJson) out(line); },
        });
        if (reports.some((r) => !r.ok)) process.exitCode = 1;
        if (asJson) { out(JSON.stringify(reports, null, 2)); return; }
        for (const r of reports) {
          out('');
          out(`${r.target}: ${r.ok ? 'ready' : 'NOT ready'}${r.error ? ` (${r.error})` : ''}`);
          for (const p of r.proof ?? []) out(`  ${p.ok ? 'ok    ' : p.cooling ? 'COOLING' : 'FAILED'} ${p.label}${p.ok ? '' : p.cooling ? ' (out of allowance right now; not a setup fault)' : `: exit ${p.code ?? '?'} ${p.detail.split(/\r?\n/).filter(Boolean).pop() ?? ''}`}`);
          for (const s of r.skipped ?? []) out(`  not added: ${s.label} (${s.reason})`);
          for (const l of r.leftovers ?? []) out(`  left alone: ${l.displayName} (${l.note})`);
          for (const s of (r.signIns ?? []).filter((x) => x.state !== 'signed-in')) out(`  still to sign in: ${s.what}: ${s.how}`);
          for (const n of r.notes ?? []) out(`  ${n}`);
        }
        if (reports.some((r) => !r.ok)) process.exitCode = 1;
        return;
      }
      throw new Error(`unknown t3 subcommand: ${sub}. Use status|setup|sign-in|forget`);
    }
    case 'keys': {
      const sub = args[0] ?? 'list';
      const asJson = args.includes('--json');
      if (sub === 'list' || sub === '--json') {
        const keys = listGatewayKeys(loadSettings());
        if (asJson) {
          out(JSON.stringify(keys, null, 2));
          return;
        }
        if (keys.length === 0) {
          out('No gateway client keys issued. Create one: switchboard keys create <label> [--scope localhost|localhost-wsl|lan]');
          return;
        }
        for (const k of keys) {
          out(`  ${k.id.padEnd(24)} ${k.hint.padEnd(22)} [${k.scope}]  ${k.label}  (${k.requestsToday} req today)`);
        }
        return;
      }
      if (sub === 'create' || sub === 'add') {
        const rest = args.slice(1);
        let scope = undefined;
        const labelParts = [];
        for (let i = 0; i < rest.length; i += 1) {
          if (rest[i] === '--scope') {
            scope = rest[i + 1];
            i += 1;
          } else if (rest[i] !== '--json') {
            labelParts.push(rest[i]);
          }
        }
        const label = labelParts.join(' ').trim();
        const { settings, key, secret } = createGatewayKey(loadSettings(), { label, scope });
        saveSettings(settings);
        if (asJson) {
          out(JSON.stringify({ key, secret }, null, 2));
          return;
        }
        out(`Created client key ${key.id} (${key.label}, scope: ${key.scope})`);
        out(`  Secret (copy now, shown once): ${secret}`);
        return;
      }
      if (sub === 'update' || sub === 'edit' || sub === 'rename' || sub === 'scope') {
        const keyId = args[1];
        if (!keyId) throw new Error('usage: switchboard keys update <id> [--label <new label>] [--scope localhost|localhost-wsl|lan]');
        const rest = args.slice(2);
        let scope = undefined;
        let label = undefined;
        if (sub === 'scope' && rest[0] && !rest[0].startsWith('--')) {
          scope = rest[0];
        } else if (sub === 'rename' && rest.length > 0 && !rest[0].startsWith('--')) {
          label = rest.filter((a) => a !== '--json').join(' ').trim();
        } else {
          const labelParts = [];
          for (let i = 0; i < rest.length; i += 1) {
            if (rest[i] === '--scope') {
              scope = rest[i + 1];
              i += 1;
            } else if (rest[i] === '--label') {
              label = rest[i + 1];
              i += 1;
            } else if (rest[i] !== '--json') {
              labelParts.push(rest[i]);
            }
          }
          if (label === undefined && labelParts.length > 0) {
            label = labelParts.join(' ').trim();
          }
        }
        if (label === undefined && scope === undefined) {
          throw new Error('usage: switchboard keys update <id> [--label <new label>] [--scope localhost|localhost-wsl|lan]');
        }
        const { settings, key } = updateGatewayKey(loadSettings(), keyId, { label, scope });
        saveSettings(settings);
        if (asJson) {
          out(JSON.stringify({ key }, null, 2));
          return;
        }
        out(`Updated client key ${key.id} (${key.label}, scope: ${key.scope})`);
        return;
      }
      if (sub === 'revoke' || sub === 'remove') {
        const keyId = args[1];
        if (!keyId) throw new Error('usage: switchboard keys revoke <id>');
        saveSettings(revokeGatewayKey(loadSettings(), keyId));
        out(`Revoked client key ${keyId}`);
        return;
      }
      throw new Error(`unknown keys subcommand: ${sub}. Use list|create|update|rename|scope|revoke`);
    }
    default:
      out(`switchboard <status|accounts|add|remove|use|color|detect|providers|doctor|quota|lanes|lane-token|gateway|t3|keys|watch|notify|mcp|customizations|automations|dry-run|run>`);
      out('  status [--json]             full breakdown: active account, sign-in and usage');
      out('  accounts                    registered accounts (* = active)');
      out(`  add <${providerList}> <label> [folder]   leave out the folder for a brand-new account`);
      out('  remove <id>                 unregister (never deletes the folder)');
      out('  use <id>                    switch the current account');
      out('  color <id> <hex|none>       the color an account is shown in (2563eb, no #); --from-t3 copies T3 Code colors');
      out('  detect                      register existing vendor folders');
      out('  providers                   installed AI tools and versions');
      out('  doctor                      health checks');
      out('  quota                       per-account usage');
      out('  lanes [...]                 the failover pool: list, add, remove, order, budget');
      out('  lane-token <laneId> [--remove|--check] | --missing   mint, delete or validate the token a lane hands to automation; --missing mints for every Claude lane without one');
      out('  gateway [status|serve|enable|disable|scope|port]   manage the local pass-through API gateway and lease broker');
      out('  gateway provision-client [--label <text>] [--replace-symlink] [--yes] [--json]   broker on, a key with the gateway scope, key file and wrapper here and in every WSL distro');
      out('  t3 setup [wsl:<distro>|ssh:<host> ...] [--all] [--replace-symlink] [--no-proof] [--json]   give T3 Code there one provider per Claude account, borrowed from the broker (no target: every WSL distro)');
      out('  t3 status [--saved] [--json]   the T3 environments set up so far, their sign-ins asked of each machine now (--saved: last reading, no network)');
      out('  t3 sign-in <wsl:<distro>|ssh:<host>>   sign each Codex account in on that machine (once; Codex shows a code for your browser)');
      out('  t3 forget <wsl:<distro>|ssh:<host>>   stop listing and checking one (nothing on it is changed)');
      out('  keys [list|create|update|revoke]   manage client keys (sb-key-...) for the gateway');
      out('  watch [--once] [--interval <minutes>] [--mode notify|auto] [--json]   the quota watch, without the tray');
      out('  notify [--webhook <url>] [--command <cmd>] [--threshold <w=pct>] [--test] [--json]   manage notification hooks');
      out('  mcp [list|add|remove|register|unregister|disable|enable|sync]   manage MCP servers across clients and accounts');
      out('    mcp add <name> <https url>  |  mcp add <name> [-e KEY=VALUE ...] --stdio <command> [args...]');
      out('    mcp register <name> [client|all]   mcp unregister <name> [client|all]   mcp disable|enable <name>');
      out('  customizations [list|marketplace|install|enable-skill|disable-skill]   manage plugins, skills, rules, agents & MCPs');
      out('  automations [list|add|remove|toggle]   manage low-level provider-agnostic scheduled routines');
      out('  dry-run [--provider <p>] [--account <id>] [--harnesses <a,b>] [--spec <file>] [--json] [--with-token]   explain which lane would be selected');
      out('  run [--provider <p>] [--account <id>] [--harnesses <a,b>] [--no-fallback] [--yes] [--quiet] [--spec <file>] <args...>   launch in the selected lane');
      out(`  <p> is a harness (${providerList}) or the vendor behind it (anthropic|openai|google)`);
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
