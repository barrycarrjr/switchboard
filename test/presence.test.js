import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PRESENCE, detectPresence } from '../core/presence.js';

test('presence table invariants: unique ids, account names, vendor sites, a credential check each', () => {
  const ids = PRESENCE.map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const p of PRESENCE) {
    assert.ok(p.name && p.account, `${p.id} names the tool and the account kind`);
    assert.match(p.url, /^https:\/\//);
    assert.ok(p.bin, `${p.id} is detectable`);
    assert.ok(p.credFiles || p.credPattern || p.credContent, `${p.id} has a signed-in check`);
    assert.ok(p.note, `${p.id} carries its honest capability note`);
  }
});

test('the copilot signed-in check matches the real nested JSONC shape and extracts who', () => {
  const entry = PRESENCE.find((p) => p.id === 'copilot');
  // The vendor writes objects, not strings: users carry a nested "login" field.
  const signedIn = '// User settings\n{"lastLoggedInUser": {\n  "login": "someone",\n  "host": "https://example.invalid"\n}, "loggedInUsers": [{"login": "someone", "host": "https://example.invalid"}]}';
  const signedOut = '// User settings\n{"firstLaunchAt": "2026-01-01", "loggedInUsers": []}';
  assert.equal(entry.credContent.pattern.test(signedIn), true);
  assert.equal(entry.credContent.pattern.test(signedOut), false);
  assert.equal(entry.credContent.identity.exec(signedIn)[1], 'someone');
});

test('detectPresence hides entries with nothing to show and reports CLI state from the finder', async () => {
  const all = await detectPresence({ whichFn: async () => true });
  assert.equal(all.length, PRESENCE.length);
  for (const entry of all) assert.equal(entry.cliInstalled, true);

  const none = await detectPresence({ whichFn: async () => false });
  for (const entry of none) {
    assert.equal(entry.cliInstalled, false);
    assert.equal(entry.signedIn, true, 'only signed-in entries may appear when no CLI is found');
  }
});

test('a shared config folder is not evidence the tool is installed', async () => {
  // Antigravity writes credentials into ~/.gemini. After Gemini CLI was uninstalled the
  // Accounts page kept showing a signed-in Gemini card with nothing left to run it.
  const rows = await detectPresence({ whichFn: () => false });
  assert.equal(rows.some((r) => r.id === 'gemini'), false, 'gemini needs its own CLI present');
});

test('a shared folder tool comes back the moment its CLI is present again', async () => {
  const rows = await detectPresence({ whichFn: () => true });
  assert.equal(rows.some((r) => r.id === 'gemini'), true, 'installed plus signed in is still a card');
});

test('a tool with no command on PATH is still shown when it is signed in', async () => {
  // Junie is an IDE plugin, so its credential is the only evidence it exists. Requiring
  // the binary would hide a tool the person plainly has.
  const junie = PRESENCE.find((e) => e.id === 'junie');
  assert.ok(junie, 'junie is a presence entry');
  assert.notEqual(junie.sharedDir, true, 'junie keeps its own folder, so a credential counts');
});
