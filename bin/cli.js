#!/usr/bin/env node
// The scriptable core. Everything the tray can do, headless.
import { loadRegistry, saveRegistry, addAccount, removeAccount, detectDefaults, activeAccount, activeHome, setActive, PROVIDERS } from '../core/accounts.js';
import { detectAll } from '../core/providers.js';
import { runChecks } from '../core/doctor.js';
import { accountQuota } from '../core/quota.js';

const [cmd, ...args] = process.argv.slice(2);
const out = (s) => process.stdout.write(s + '\n');

function fmtWindow(w) {
  const pct = w.usedPercent == null ? (w.valueLabel ?? 'n/a') : `${w.usedPercent}%`;
  const reset = w.resetsAt ? `, resets ${new Date(w.resetsAt).toLocaleString()}` : '';
  return `  ${w.label}: ${pct}${w.valueLabel && w.usedPercent != null ? ` (${w.valueLabel})` : ''}${reset}`;
}

async function main() {
  const registry = loadRegistry();

  switch (cmd) {
    case 'status': {
      for (const p of Object.values(PROVIDERS)) {
        const active = activeAccount(registry, p.id);
        out(`${p.name}: ${active ? `${active.label} (${active.home})` : `unregistered folder ${activeHome(p.id)}`}`);
      }
      return;
    }
    case 'accounts': {
      if (registry.accounts.length === 0) { out('No accounts registered. Add one: switchboard add <claude|codex> <label> <folder>'); return; }
      for (const a of registry.accounts) {
        const active = activeAccount(registry, a.provider)?.id === a.id;
        out(`${active ? '*' : ' '} ${a.id}  [${a.provider}] ${a.label}  ${a.home}`);
      }
      return;
    }
    case 'add': {
      const [provider, label, home] = args;
      const account = addAccount(registry, { provider, label, home });
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
      const found = detectDefaults(registry);
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
      for (const a of registry.accounts.filter((x) => x.provider === 'claude')) {
        out(`${a.label} (${a.home})`);
        const q = await accountQuota(a.home);
        if (q.error === 'no-credentials') out('  quota unavailable: no readable token (sign in, or the credentials live in the system store)');
        else if (q.error === 'auth') out('  quota unavailable: stored token needs a refresh (run the CLI once on this account)');
        else if (q.error) out('  quota unavailable right now');
        else q.windows.forEach((w) => out(fmtWindow(w)));
      }
      const codex = registry.accounts.filter((x) => x.provider === 'codex');
      if (codex.length) out('Codex: no usage API for subscriptions; see the official usage page.');
      return;
    }
    default:
      out('switchboard <status|accounts|add|remove|use|detect|providers|doctor|quota>');
      out('  status                      what new terminals will use');
      out('  accounts                    registered accounts (* = active)');
      out('  add <provider> <label> <folder>');
      out('  remove <id>                 unregister (never deletes the folder)');
      out('  use <id>                    switch the machine default');
      out('  detect                      register existing vendor folders');
      out('  providers                   installed AI tools and versions');
      out('  doctor                      health checks');
      out('  quota                       per-account usage');
  }
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });
