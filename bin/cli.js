#!/usr/bin/env node
// The scriptable core. Everything the tray can do, headless.
import { loadRegistry, saveRegistry, addAccount, removeAccount, detectDefaults, detectCandidates, activeAccount, activeHome, setActive, normalizeHome, PROVIDERS } from '../core/accounts.js';
import { detectAll } from '../core/providers.js';
import { runChecks } from '../core/doctor.js';
import { providerQuota } from '../core/quota.js';
import { collectStatus, formatStatus } from '../core/status.js';
import { loadSettings } from '../core/settings.js';

const [cmd, ...args] = process.argv.slice(2);
const out = (s) => process.stdout.write(s + '\n');
const providerList = Object.keys(PROVIDERS).join('|');

function fmtWindow(w) {
  const pct = w.usedPercent == null ? (w.valueLabel ?? 'n/a') : `${w.usedPercent}%`;
  const reset = w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : '';
  return `  ${w.label}: ${pct}${w.valueLabel && w.usedPercent != null ? ` (${w.valueLabel})` : ''}${reset}`;
}

async function main() {
  const registry = loadRegistry();

  switch (cmd) {
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
        if (q.error === 'no-credentials') out('  quota unavailable: no readable token (sign in, or the credentials live in the system store)');
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
      out(`switchboard <status|accounts|add|remove|use|detect|providers|doctor|quota>`);
      out('  status [--json]             full breakdown: active account, sign-in and usage');
      out('  accounts                    registered accounts (* = active)');
      out(`  add <${providerList}> <label> <folder>`);
      out('  remove <id>                 unregister (never deletes the folder)');
      out('  use <id>                    switch the machine default');
      out('  detect                      register existing vendor folders');
      out('  providers                   installed AI tools and versions');
      out('  doctor                      health checks');
      out('  quota                       per-account usage');
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
