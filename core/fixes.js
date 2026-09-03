import fs from 'node:fs';
import path from 'node:path';
import { deleteUserEnv } from './env.js';
import { CLAUDE_CREDENTIAL_ENV_VARS, loadRegistry, removeAccount, saveRegistry } from './accounts.js';

/**
 * The safe, automatable fixes the Health panel may offer. Every fix states exactly
 * what it changes, is confirmed by the person before it runs, and where it edits a
 * vendor file it writes a timestamped backup first.
 */

/** Pure transform: comment out non-vendor base_url lines. Exported for tests. */
export function stripCustomBaseUrls(toml) {
  let changed = false;
  const out = toml.split(/\r?\n/).map((line) => {
    const m = line.match(/^\s*base_url\s*=\s*"([^"]+)"/);
    if (m && !/openai\.com|chatgpt\.com/i.test(m[1])) {
      changed = true;
      return '# removed by Switchboard: ' + line.trim();
    }
    return line;
  }).join('\n');
  return { changed, out };
}

export const REMOVABLE_USER_ENV_VARS = Object.freeze([...CLAUDE_CREDENTIAL_ENV_VARS]);

export function applyFix(action, args = {}, { deleteEnv = deleteUserEnv, readRegistry = loadRegistry, writeRegistry = saveRegistry } = {}) {
  switch (action) {
    // Unregister an account whose tool is gone. Registration only, exactly as the Remove
    // button on a card does: removeAccount never touches the folder or the sign-in, so
    // re-installing the tool registers it again with nothing lost.
    case 'unregister-account': {
      // Both halves are injected rather than called directly, so a test can exercise this
      // without touching the registry of whoever is running the suite. Writing to the
      // real file from a test is not hypothetical: it happened while building this.
      const reg = readRegistry();
      const account = reg.accounts.find((a) => a.id === args.id);
      if (!account) return { ok: true, did: 'That account is no longer registered; nothing to do.' };
      removeAccount(reg, args.id);
      writeRegistry(reg);
      return { ok: true, did: `Unregistered "${account.label}". The folder ${account.home} and its sign-in are untouched.` };
    }
    case 'remove-user-env': {
      if (!REMOVABLE_USER_ENV_VARS.includes(args.name)) throw new Error(`not a removable variable: ${args.name}`);
      deleteEnv(args.name);
      return { ok: true, did: `Removed ${args.name} from the user environment. New processes will use each folder's own login; running processes are unchanged.` };
    }
    case 'codex-remove-baseurl': {
      const file = path.join(args.home, 'config.toml');
      const toml = fs.readFileSync(file, 'utf8');
      const { changed, out } = stripCustomBaseUrls(toml);
      if (!changed) return { ok: true, did: 'Nothing to change; no custom base_url found.' };
      const backup = `${file}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.copyFileSync(file, backup);
      fs.writeFileSync(file, out);
      return { ok: true, did: `Commented out the custom base_url line(s). Backup: ${path.basename(backup)}` };
    }
    default:
      throw new Error(`unknown fix: ${action}`);
  }
}
