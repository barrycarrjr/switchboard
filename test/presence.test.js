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

test('the copilot signed-in check matches its JSONC config content, not filenames', () => {
  const entry = PRESENCE.find((p) => p.id === 'copilot');
  const signedIn = '// User settings\n{"lastLoggedInUser": "someone", "loggedInUsers": ["someone"]}';
  const signedOut = '// User settings\n{"firstLaunchAt": "2026-01-01"}';
  assert.equal(entry.credContent.pattern.test(signedIn), true);
  assert.equal(entry.credContent.pattern.test(signedOut), false);
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
