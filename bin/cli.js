#!/usr/bin/env node
// The scriptable core. Everything the tray can do, headless.
import { spawn } from 'node:child_process';
import { loadRegistry, saveRegistry, addAccount, removeAccount, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, normalizeHome, PROVIDERS, accountScopedEnv } from '../core/accounts.js';
import { detectAll, TOOLS, toolExecutable } from '../core/providers.js';
import { runChecks, accountLoginState } from '../core/doctor.js';
import { providerQuota } from '../core/quota.js';
import { collectStatus, formatStatus } from '../core/status.js';
import { loadSettings } from '../core/settings.js';
import { selectLane } from '../core/lanes.js';

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
      quotas[account.id] = await providerQuota(account.provider, account.home, { fetchImpl: fetch, usageSource: usageSources[account.id] ?? null, now });
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

function parseRunArgs(rawArgs) {
  const parsed = { provider: null, account: null, noFallback: false, commandArgs: [] };
  let i = 0;
  while (i < rawArgs.length) {
    const arg = rawArgs[i];
    if (arg === '--') {
      parsed.commandArgs.push(...rawArgs.slice(i + 1));
      break;
    }
    if (arg === '--provider' && i + 1 < rawArgs.length) {
      parsed.provider = rawArgs[++i];
    } else if (arg === '--account' && i + 1 < rawArgs.length) {
      parsed.account = rawArgs[++i];
    } else if (arg === '--no-fallback') {
      parsed.noFallback = true;
    } else {
      parsed.commandArgs.push(arg);
    }
    i++;
  }
  return parsed;
}

async function main() {
  const registry = loadRegistry();

  switch (cmd) {
    case 'dry-run': {
      const settings = loadSettings();
      const parsed = parseRunArgs(args);
      const { pool, context } = await prepareLanesContext(settings, registry, {
        provider: parsed.provider,
      });

      if (parsed.account) {
        context.requirements.accountId = parsed.account; // Not natively in selectLane, but conceptually overrides
        // Actually selectLane doesn't filter by accountId yet, let's filter the pool manually
      }
      
      const filteredPool = parsed.account ? pool.filter(l => l.accountId === parsed.account) : pool;
      
      if (filteredPool.length === 0) {
        out('No configured lanes match the criteria.');
        process.exitCode = 1;
        return;
      }

      const selected = selectLane(filteredPool, context);
      
      if (!selected) {
        out('No lane is currently available.');
        process.exitCode = 1;
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
      let currentPool = parsed.account ? settings.lanes.filter(l => l.accountId === parsed.account) : settings.lanes;
      let { context } = await prepareLanesContext(settings, registry, {
        provider: parsed.provider,
      });

      let selected = selectLane(currentPool, context);

      if (!selected) {
        out('No configured lane is available to run this task.');
        process.exitCode = 1;
        return;
      }

      const { isLimitError } = await import('../core/errors.js');

      async function runInLane(lane) {
        const account = registry.accounts.find(a => a.id === lane.accountId);
        if (!account) {
          out(`Account ${lane.accountId} not found in registry.`);
          return { code: 1, limitHit: false };
        }

        const executable = await toolExecutable(lane.harness);
        if (!executable) {
          out(`Tool for harness '${lane.harness}' is not installed or not found on PATH.`);
          return { code: 1, limitHit: false };
        }

        const childEnv = accountScopedEnv(account, process.env);
        out(`[switchboard] Running via lane ${lane.id} (${account.label})`);

        let spawnFile = executable;
        let spawnArgs = parsed.commandArgs;
        let spawnOptions = {
          stdio: ['inherit', 'inherit', 'pipe'],
          env: childEnv,
          windowsHide: false
        };

        if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
          if (/[\u0000-\u001f"%]/.test(executable)) {
            out(`[switchboard] Unsafe batch-shim path: ${executable}`);
            return { code: 1, limitHit: false };
          }
          spawnFile = 'cmd.exe';
          spawnArgs = ['/d', '/s', '/v:off', '/c', executable, ...parsed.commandArgs];
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

          child.on('error', (err) => {
            out(`\n[switchboard] Failed to launch ${executable}: ${err.message}`);
            done({ code: 1, limitHit: false });
          });

          child.on('close', (code) => {
            if (code !== 0 && isLimitError(stderrOutput)) {
              out(`\n[switchboard] Provider limit error detected in lane ${lane.id}.`);
              done({ code, limitHit: true });
            } else {
              if (code !== 0) {
                out(`\n[switchboard] Process exited with code ${code}. Ambiguous failure, not falling back.`);
              }
              done({ code, limitHit: false });
            }
          });
        });
      }

      while (selected) {
        const result = await runInLane(selected.lane);
        
        if (result.limitHit && !parsed.noFallback) {
          // Remove the exhausted lane from the pool
          currentPool = currentPool.filter(l => l.id !== selected.lane.id);
          
          // Re-evaluate context in case quotas updated or cooldowns triggered
          const nextContext = (await prepareLanesContext(loadSettings(), registry, {
            provider: parsed.provider,
          })).context;
          
          // Phase 2 constraint: only auto-resume in same harness
          nextContext.requirements.harness = selected.lane.harness;

          selected = selectLane(currentPool, nextContext);
          if (selected) {
            out(`[switchboard] Falling back to next available lane for harness ${selected.lane.harness}: ${selected.lane.id}`);
          } else {
            out(`[switchboard] No more available lanes for harness ${nextContext.requirements.harness} to fall back to.`);
            process.exitCode = result.code;
            return;
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
        const q = await providerQuota(a.provider, a.home, { usageSource: settings.usageSources[a.id] ?? null });
        if (q.error === 'no-credentials') out('  usage unavailable: no access credential or matching Claude Desktop sample');
        else if (q.error === 'auth') out('  quota unavailable: stored token needs a refresh (run the CLI once on this account)');
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
    default:
      out(`switchboard <status|accounts|add|remove|use|detect|providers|doctor|quota|dry-run|run>`);
      out('  status [--json]             full breakdown: active account, sign-in and usage');
      out('  accounts                    registered accounts (* = active)');
      out(`  add <${providerList}> <label> <folder>`);
      out('  remove <id>                 unregister (never deletes the folder)');
      out('  use <id>                    switch the machine default');
      out('  detect                      register existing vendor folders');
      out('  providers                   installed AI tools and versions');
      out('  doctor                      health checks');
      out('  quota                       per-account usage');
      out('  dry-run [--provider <p>] [--account <id>]   explain which lane would be selected');
      out('  run [--provider <p>] [--account <id>] [--no-fallback] <args...>   launch in the selected lane');
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
