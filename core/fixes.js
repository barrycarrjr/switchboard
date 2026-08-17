import fs from 'node:fs';
import path from 'node:path';
import { deleteUserEnv } from './env.js';

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

export function applyFix(action, args = {}) {
  switch (action) {
    case 'remove-user-env': {
      const allowed = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
      if (!allowed.includes(args.name)) throw new Error(`not a removable variable: ${args.name}`);
      deleteUserEnv(args.name);
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
