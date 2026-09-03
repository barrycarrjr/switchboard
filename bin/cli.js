#!/usr/bin/env node
// The scriptable core. Everything the tray can do, headless.
import { spawn } from 'node:child_process';
import { loadRegistry, saveRegistry, addAccount, removeAccount, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, normalizeHome, PROVIDERS, accountScopedEnv, configuredClaudeCredentialOverrides } from '../core/accounts.js';
import { detectAll, TOOLS, toolExecutable } from '../core/providers.js';
import { runChecks, accountLoginState } from '../core/doctor.js';
import { sharedProviderQuota } from '../core/quota-cache.js';
import { collectStatus, formatStatus } from '../core/status.js';
import { loadSettings, saveSettings } from '../core/settings.js';
import { addLane, removeLane, reorderLanes, setLaneBudget, unknownLaneIds, setLaneToken, removeLaneToken, BILLING_KINDS } from '../core/lane-admin.js';
import { laneTokenFor, laneTokenIdentityMatches, validateLaneTokens, mergeLaneTokenResults, extractSetupToken, probeSetupToken } from '../core/lane-tokens.js';
import { readClaudeAccountIdentity } from '../core/quota.js';
import { planDefaultSwitches } from '../core/watch.js';
import { readUserEnv, readMachineEnv } from '../core/env.js';
import { selectLane, laneAnswersTo, selectionFailure } from '../core/lanes.js';
import { readHandoff, writeHandoff, generateHandoffPrompt } from '../core/handoff.js';
import { CARRYABLE_HARNESSES, callerManagesSession, newSessionId, withSessionId, resumeArgs, carryTranscript, carryNote, sessionDigest } from '../core/transcripts.js';
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
      // Opt-in, because the Slack bridge also calls `dry-run --json` and must not start
      // receiving secrets on stdout it never asked for.
      const withToken = args.includes('--with-token');
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
          available: true
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

      // Naming the session up front is what makes carrying it possible later: on a
      // failover Switchboard has to know which transcript belongs to this run, and the
      // newest file in the folder is the wrong answer whenever two agents share a
      // working directory. Only when Switchboard owns the command line (no spec) and the
      // caller has not named a session themselves. `sessionId` staying null is the
      // signal that no carry will be attempted.
      const runCwd = process.cwd();
      let sessionId = null;
      if (!spec
        && CARRYABLE_HARNESSES.includes(selected.lane.harness)
        && !callerManagesSession(parsed.commandArgs)) {
        sessionId = newSessionId();
      }

      let currentArgs = parsed.commandArgs;
      if (sessionId) currentArgs = withSessionId(currentArgs, sessionId);
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
            // A Claude session file means nothing to another vendor, so this hop cannot
            // carry the session itself. What it can carry is a written account of it, and
            // the spent session already wrote one: an agent narrates its work as it goes,
            // so the text turns of its transcript hold the objective, what was done and
            // the decisions taken. Extracted, never summarised by a model, so nothing here
            // can invent a decision that was never made.
            //
            // A handoff already written for this workspace is left exactly as it is. It
            // may be better than anything derivable, and it is not Switchboard's to
            // overwrite.
            let handoffExists = !!readHandoff(process.cwd());
            if (!handoffExists && sessionId && CARRYABLE_HARNESSES.includes(previousLane.harness)) {
              const spentHome = registry.accounts.find((a) => a.id === previousLane.accountId)?.home;
              const digest = sessionDigest({ home: spentHome, cwd: runCwd, sessionId });
              if (digest) {
                try {
                  writeHandoff(runCwd, {
                    objective: digest.objective,
                    state: digest.state,
                    nextActions: 'Pick up from the state above and finish the objective. Do not redo work that is already done.',
                  });
                  handoffExists = true;
                  say(`[switchboard] Wrote a handoff from the spent ${previousLane.harness} session${digest.truncated ? ' (its most recent work; the run was too long to record in full)' : ''}.`);
                } catch (e) {
                  // Includes the writer's own size limit. Falls through to the ask below,
                  // which is what used to happen every time.
                  say(`[switchboard] Could not write a handoff from the spent session: ${String(e.message || e)}`);
                }
              }
            }

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

            // Same harness, so the outgoing session can come with us. Copy its
            // transcript into the incoming account's folder and resume it there: the new
            // account continues the actual conversation rather than starting over, and
            // the spent account keeps its own copy. Every failure here falls through to
            // the fresh start this path has always done.
            if (sessionId && CARRYABLE_HARNESSES.includes(selected.lane.harness)) {
              const fromHome = registry.accounts.find((a) => a.id === previousLane.accountId)?.home;
              const toHome = registry.accounts.find((a) => a.id === selected.lane.accountId)?.home;
              const carry = carryTranscript({ fromHome, toHome, cwd: runCwd, sessionId });
              if (carry.carried) {
                currentArgs = resumeArgs(parsed.commandArgs, sessionId);
                say('[switchboard] Carried the session over; this lane continues where the last one stopped.');
              } else {
                // Back to a plain named start. Rebuilt from the original arguments rather
                // than left as they are, because a third lane would otherwise inherit the
                // previous hop's --resume and ask this account to open a session it has
                // never held. Still named, so a later failover can carry this one.
                currentArgs = withSessionId(parsed.commandArgs, sessionId);
                say(`[switchboard] ${carryNote(carry.reason)}.`);
              }
            }
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
      const checks = await runChecks({ accounts: registry.accounts, settings: loadSettings() });
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
    // The token a lane hands to automation. It rides ALONGSIDE the folder sign-in,
    // never instead of it: selection still needs the folder signed in, and a token that
    // dies only reverts automation to folder mode, which is today's working behaviour.
    case 'lane-token': {
      const settings = loadSettings();
      const laneId = args.find((a) => !a.startsWith('--'));
      if (!laneId) {
        out('switchboard lane-token <laneId> [--remove|--check]');
        out('  with no flag, mints a token for the lane\'s account via "claude setup-token" and stores it');
        out('  --remove   delete the stored token (the account sign-in is untouched)');
        out('  --check    ask the vendor whether the stored token is still honoured');
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
          out(`the token for ${laneId} was revoked or expired, so automation reverts to folder mode. Mint a new one with: switchboard lane-token ${laneId}`);
          process.exitCode = 1;
          return;
        }
        if (outcome === 'ok') { out(`the token for ${laneId} is still honoured`); return; }
        out('the check could not run (network or endpoint failure). Failing to read the meter is not an empty tank, so the token is kept.');
        return;
      }

      const lane = settings.lanes.find((l) => l.id === laneId);
      if (!lane) { out(`no lane with id "${laneId}"`); process.exitCode = 1; return; }
      if (lane.harness !== 'claude') {
        out(`lane ${laneId} runs ${lane.harness}; only Claude lanes can carry a setup token`);
        process.exitCode = 1;
        return;
      }
      const account = registry.accounts.find((a) => a.id === lane.accountId);
      if (!account) { out(`lane ${laneId} names an unregistered account (${lane.accountId})`); process.exitCode = 1; return; }

      const executable = await toolExecutable(lane.harness);
      if (!executable) {
        out(`Tool for harness '${lane.harness}' is not installed or not found on PATH.`);
        process.exitCode = 1;
        return;
      }

      // Same launch shape as `run`: cmd.exe for the batch shims npm writes on Windows,
      // with the same unsafe-path guard.
      let spawnFile = executable;
      let spawnArgs = ['setup-token'];
      if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)) {
        if (/[\u0000-\u001f"%]/.test(executable)) {
          out(`Unsafe batch-shim path: ${executable}`);
          process.exitCode = 1;
          return;
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
        process.exitCode = 1;
        return;
      }
      if (minted.code !== 0) {
        out(`setup-token exited with code ${minted.code}, so nothing was stored`);
        process.exitCode = 1;
        return;
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
      const token = extractSetupToken(pasted);
      if (!token) {
        out('That did not contain a token, so nothing was stored. Run this command again to re-mint.');
        process.exitCode = 1;
        return;
      }

      // The minting login's identity is stamped into the stored entry, so dry-run can
      // refuse to hand the token out after the folder is re-signed into a different
      // account. No identity means nothing to stamp, and an unstamped fresh token
      // would outlive any later re-sign-in unnoticed, so it is refused instead.
      const identity = readClaudeAccountIdentity(account.home);
      if (!identity) {
        out(`No readable sign-in identity in ${account.home}, so nothing was stored. The lane's folder must be signed in; sign it in and mint again.`);
        process.exitCode = 1;
        return;
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
        process.exitCode = 1;
        return;
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
      out(`switchboard <status|accounts|add|remove|use|detect|providers|doctor|quota|lanes|lane-token|watch|dry-run|run>`);
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
      out('  lane-token <laneId> [--remove|--check]   mint, delete or validate the token a lane hands to automation');
      out('  watch [--once] [--interval <minutes>] [--mode notify|auto] [--json]   the quota watch, without the tray');
      out('  dry-run [--provider <p>] [--account <id>] [--json] [--with-token]   explain which lane would be selected');
      out('  run [--provider <p>] [--account <id>] [--no-fallback] [--yes] [--quiet] [--spec <file>] <args...>   launch in the selected lane');
      out(`  <p> is a harness (${providerList}) or the vendor behind it (anthropic|openai|google)`);
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
