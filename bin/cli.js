#!/usr/bin/env node
// The scriptable core. Everything the tray can do, headless.
import { spawn } from 'node:child_process';
import { loadRegistry, saveRegistry, addAccount, removeAccount, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, normalizeHome, PROVIDERS, accountScopedEnv, configuredClaudeCredentialOverrides } from '../core/accounts.js';
import { detectAll, TOOLS, toolExecutable } from '../core/providers.js';
import { runChecks, accountLoginState } from '../core/doctor.js';
import { sharedProviderQuota } from '../core/quota-cache.js';
import { collectStatus, formatStatus } from '../core/status.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { addLane, removeLane, reorderLanes, setLaneBudget, unknownLaneIds, BILLING_KINDS } from '../core/lane-admin.js';
import { planDefaultSwitches } from '../core/watch.js';
import { readUserEnv, readMachineEnv } from '../core/env.js';
import { selectLane, laneAnswersTo, selectionFailure } from '../core/lanes.js';
import { readHandoff, generateHandoffPrompt } from '../core/handoff.js';
import { parseRunArgs, loadRunSpec, resolveSpecArgv, childStdio, childWindowsHide, parseLaneAddArgs, parseWatchArgs } from '../core/runargs.js';
import readline from 'node:readline/promises';

const [cmd, ...args] = process.argv.slice(2);
const out = (s) => process.stdout.write(s + '\n');
const providerList = Object.keys(PROVIDERS).join('|');

function fmtWindow(w) {
  const pct = w.usedPercent == null ? (w.valueLabel ?? 'n/a') : `${w.usedPercent}%`;
  const reset = w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : '';
  return `  ${w.label}: ${pct}${w.valueLabel && w.usedPercent != null ? ` (${w.valueLabel})` : ''}${reset}`;
}

async function prepareLanesContext(settings, registry, overrides = {}) {
  const { lanes = [], spendPolicies = {}, cooldowns = {}, usageSources = {} } = settings;
  const accounts = registry.accounts;
  
  const loginStates = {};
  const quotas = {};
  const now = Date.now();

  for (const account of accounts) {
    if (!lanes.some(l => l.accountId === account.id)) continue;
    loginStates[account.id] = await accountLoginState(account);
    const def = PROVIDERS[account.provider];
    if (def && def.quota) {
      // Through the shared cache: `dry-run` is what Paperclip and the Slack bridge
      // invoke before every spawn, so uncached live calls here multiplied across
      // every automation on the machine.
      quotas[account.id] = await sharedProviderQuota(account, { fetchImpl: fetch, usageSource: usageSources[account.id] ?? null, now });
    }
  }

  return {
    pool: lanes,
    context: {
      now,
      loginStates,
      quotas,
      spendPolicies,
      cooldowns,
      requirements: overrides
    }
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
      return `${decision.provider}: the default account is out of quota, but a machine-wide authentication override makes folder switching unreliable. Run "switchboard doctor".`;
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
  }

  return { decisions, accounts: reg.accounts };
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
      const { pool, context } = await prepareLanesContext(settings, registry, {
        provider: parsed.provider,
      });

      if (parsed.account) {
        context.requirements.accountId = parsed.account; // Not natively in selectLane, but conceptually overrides
        // Actually selectLane doesn't filter by accountId yet, let's filter the pool manually
      }
      
      // A lane is named by its harness ("claude") or by its vendor ("anthropic"), and
      // --provider takes either. Filtering here rather than leaving it to selectLane is
      // what separates "nothing matched what you asked for" from "everything that matched
      // is busy", which are different problems with different fixes.
      const filteredPool = pool
        .filter((l) => !parsed.account || l.accountId === parsed.account)
        .filter((l) => laneAnswersTo(l, parsed.provider));
      
      const selected = filteredPool.length ? selectLane(filteredPool, context) : null;

      if (!selected) {
        const reason = selectionFailure(pool, filteredPool);
        out(asJson ? JSON.stringify({ available: false, reason }) : reason);
        process.exitCode = 1;
        return;
      }

      if (asJson) {
        out(JSON.stringify({
          laneId: selected.lane.id,
          harness: selected.lane.harness,
          provider: selected.lane.provider,
          accountId: selected.lane.accountId,
          billing: selected.lane.billing,
          reason: selected.status.reason,
          available: true
        }));
        return;
      }

      out(`Selected lane: ${selected.lane.id}`);
      out(`  Harness: ${selected.lane.harness}`);
      out(`  Provider: ${selected.lane.provider}`);
      out(`  Account: ${selected.lane.accountId}`);
      out(`  Billing: ${selected.lane.billing}`);
      out(`  Reason: ${selected.status.reason}`);
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

      let currentPool = settings.lanes
        .filter((l) => !parsed.account || l.accountId === parsed.account)
        .filter((l) => laneAnswersTo(l, parsed.provider));

      let { context } = await prepareLanesContext(settings, registry, {
        provider: parsed.provider,
      });

      let selected = currentPool.length ? selectLane(currentPool, context) : null;

      if (!selected) {
        say(selectionFailure(settings.lanes, currentPool));
        process.exitCode = 1;
        return;
      }

      const { isLimitError } = await import('../core/errors.js');

      // A long run must not balloon memory, and a limit notice always sits at the end of
      // the output, so only the tail is retained for classification.
      const STDOUT_TAIL_BYTES = 64 * 1024;

      async function runInLane(lane, executionArgs) {
        const account = registry.accounts.find(a => a.id === lane.accountId);
        if (!account) {
          say(`Account ${lane.accountId} not found in registry.`);
          return { code: 1, limitHit: false };
        }

        const executable = await toolExecutable(lane.harness);
        if (!executable) {
          say(`Tool for harness '${lane.harness}' is not installed or not found on PATH.`);
          return { code: 1, limitHit: false };
        }

        const childEnv = accountScopedEnv(account, process.env);
        say(`[switchboard] Running via lane ${lane.id} (${account.label})`);

        let spawnFile = executable;
        let spawnArgs = executionArgs;
        let spawnOptions = {
          // stdout is piped only when this is not a terminal, because a headless harness can
          // report an exhausted subscription as an ordinary assistant message on stdout and
          // never on stderr. Every chunk is forwarded on immediately and unchanged, so a
          // streaming caller still sees the same bytes at the same time.
          stdio: childStdio(Boolean(process.stdout.isTTY)),
          env: childEnv,
          windowsHide: childWindowsHide(Boolean(process.stdout.isTTY))
        };

        if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
          if (/[\u0000-\u001f"%]/.test(executable)) {
            say(`[switchboard] Unsafe batch-shim path: ${executable}`);
            return { code: 1, limitHit: false };
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
            done({ code: 1, limitHit: false });
          });

          child.on('close', (code) => {
            if (code !== 0 && isLimitError(stderrOutput + '\n' + stdoutTail)) {
              say(`\n[switchboard] Provider limit error detected in lane ${lane.id}.`);
              done({ code, limitHit: true });
            } else {
              if (code !== 0) {
                say(`\n[switchboard] Process exited with code ${code}. Ambiguous failure, not falling back.`);
              }
              done({ code, limitHit: false });
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

      let currentArgs = parsed.commandArgs;
      if (spec) {
        currentArgs = argsForLane(selected.lane);
        if (!currentArgs) {
          process.exitCode = 1;
          return;
        }
      }

      while (selected) {
        const result = await runInLane(selected.lane, currentArgs);
        
        if (result.limitHit && !parsed.noFallback) {
          const previousLane = selected.lane;
          currentPool = currentPool.filter(l => l.id !== selected.lane.id);
          
          const nextContext = (await prepareLanesContext(loadSettings(), registry, {
            provider: parsed.provider,
          })).context;
          
          selected = selectLane(currentPool, nextContext);
          
          if (!selected) {
            say(`[switchboard] No more available lanes to fall back to.`);
            process.exitCode = result.code;
            return;
          }

          let handoffPrompt = null;

          // Cross-provider/cross-harness transition handling
          if (previousLane.harness !== selected.lane.harness || previousLane.provider !== selected.lane.provider) {
            const handoffExists = !!readHandoff(process.cwd());
            
            if (!handoffExists) {
              say(`[switchboard] Warning: Cross-provider failover to ${selected.lane.harness} (${selected.lane.provider}) requires a handoff document, but none was found for this workspace.`);
              if (!parsed.yes) {
                say(`[switchboard] Please provide the missing objective manually or start a fresh session.`);
                const proceed = await promptUser(`Start a fresh session in ${selected.lane.id}? (y/N): `);
                if (proceed !== 'y' && proceed !== 'yes') {
                  process.exitCode = result.code;
                  return;
                }
              } else {
                say(`[switchboard] Proceeding without handoff due to --yes flag.`);
              }
              // If proceeding without a handoff, we just pass the original args (or none if it was interactive)
            } else {
              say(`[switchboard] Valid task handoff found for workspace.`);
              if (!parsed.yes) {
                const proceed = await promptUser(`Cross-provider failover to ${selected.lane.id}. Start new session? (y/N): `);
                if (proceed !== 'y' && proceed !== 'yes') {
                  process.exitCode = result.code;
                  return;
                }
              }
              // Inject the single-sentence handoff prompt into the args
              handoffPrompt = generateHandoffPrompt(process.cwd());
              if (!spec) currentArgs = [handoffPrompt];
            }
          } else {
            say(`[switchboard] Falling back to next available lane for harness ${selected.lane.harness}: ${selected.lane.id}`);
          }

          // The new lane can be a different harness, so a spec is re-read for it and the
          // handoff prompt appended rather than replacing a command line that needs its
          // own subcommand and flags.
          if (spec) {
            const nextArgs = argsForLane(selected.lane, handoffPrompt);
            if (!nextArgs) {
              process.exitCode = result.code || 1;
              return;
            }
            currentArgs = nextArgs;
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
      const status = await collectStatus({ registry, settings: loadSettings() });
      out(args.includes('--json') ? JSON.stringify(status, null, 2) : formatStatus(status));
      return;
    }
    case 'accounts': {
      if (registry.accounts.length === 0) { out(`No accounts registered. Add one: switchboard add <${providerList}> <label> <folder>`); return; }
      for (const a of registry.accounts) {
        const active = activeAccount(registry, a.provider)?.id === a.id;
        out(`${active ? '*' : ' '} ${a.id}  [${a.provider}] ${a.label}  ${a.home}`);
      }
      return;
    }
    case 'add': {
      const [provider, label, home] = args;
      if (!PROVIDERS[provider]) { out(`Unknown provider. Use one of: ${providerList}`); process.exitCode = 1; return; }
      // Tools whose variable names the folder ABOVE the config folder get it appended,
      // so a person can pass the folder they think of as the account.
      const account = addAccount(registry, { provider, label, home: normalizeHome(provider, home) });
      saveRegistry(registry);
      out(`registered ${account.id} (${account.home})`);
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
      const checks = await runChecks({ accounts: registry.accounts });
      const mark = { ok: 'OK  ', info: 'INFO', warn: 'WARN', bad: 'FAIL' };
      for (const c of checks) out(`${mark[c.level]}  ${c.title}\n      ${c.detail}`);
      if (checks.some((c) => c.level === 'bad')) process.exitCode = 1;
      return;
    }
    case 'quota': {
      const settings = loadSettings();
      for (const a of registry.accounts) {
        const def = PROVIDERS[a.provider];
        if (!def.quota) continue;
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

      if (!sub || sub === 'list' || sub === '--json') {
        if (args.includes('--json')) {
          out(JSON.stringify({ lanes: settings.lanes, spendPolicies: settings.spendPolicies }, null, 2));
          return;
        }
        if (!settings.lanes.length) {
          out('No lanes configured. Add one: switchboard lanes add <accountId>');
          out('Account ids come from: switchboard accounts');
          return;
        }
        out('Lanes in priority order; the first healthy one gets the work.');
        settings.lanes.forEach((lane, i) => {
          const account = registry.accounts.find((a) => a.id === lane.accountId);
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
          const added = addLane(settings, wanted, registry.accounts);
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
      out('  lanes [--json]                        the pool, in priority order');
      out(`  lanes add <accountId> [--metered] [--budget <n>]   append a lane (billing: ${BILLING_KINDS.join('|')})`);
      out('  lanes remove <laneId>                 take a lane out of the pool');
      out('  lanes order <laneId>...               reorder; ids left out keep their order at the end');
      out('  lanes budget <laneId> <amount|none>   what a metered lane may spend');
      process.exitCode = 1;
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
        out('  notify reports what it would do; auto switches the machine default.');
        process.exitCode = 1;
        return;
      }
      if (mode === 'auto' && !DEFAULT_SWITCH_PERSISTS) {
        out(`Note: on ${process.platform} a changed default cannot outlive this command, so auto mode reports rather than switches.`);
      }

      const runPass = async () => {
        const { decisions, accounts } = await watchPass({ mode, apply: mode === 'auto' });
        if (parsed.json) {
          out(JSON.stringify({ at: new Date().toISOString(), mode, decisions }));
          return;
        }
        const stamp = new Date().toLocaleString();
        if (!decisions.length) { out(`${stamp}  nothing to do`); return; }
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
    default:
      out(`switchboard <status|accounts|add|remove|use|detect|providers|doctor|quota|lanes|watch|dry-run|run>`);
      out('  status [--json]             full breakdown: active account, sign-in and usage');
      out('  accounts                    registered accounts (* = active)');
      out(`  add <${providerList}> <label> <folder>`);
      out('  remove <id>                 unregister (never deletes the folder)');
      out('  use <id>                    switch the current account');
      out('  detect                      register existing vendor folders');
      out('  providers                   installed AI tools and versions');
      out('  doctor                      health checks');
      out('  quota                       per-account usage');
      out('  lanes [...]                 the failover pool: list, add, remove, order, budget');
      out('  watch [--once] [--interval <minutes>] [--mode notify|auto] [--json]   the quota watch, without the tray');
      out('  dry-run [--provider <p>] [--account <id>] [--json]   explain which lane would be selected');
      out('  run [--provider <p>] [--account <id>] [--no-fallback] [--yes] [--quiet] [--spec <file>] <args...>   launch in the selected lane');
      out(`  <p> is a harness (${providerList}) or the vendor behind it (anthropic|openai|google)`);
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
