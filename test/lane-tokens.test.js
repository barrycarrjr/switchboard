import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { laneTokenFor, laneTokenIdentityMatches, validateLaneTokens, mergeLaneTokenResults, extractSetupToken, redactSetupToken, createSetupTokenRedactor } from '../core/lane-tokens.js';
import { buildLane } from '../core/lane-admin.js';

const account = { id: 'claude-work', provider: 'claude', label: 'Work', home: 'X:\\p\\.claude-work' };

const settingsWith = (laneTokens = {}) => ({
  lanes: [buildLane(account, 'subscription', 'lane-1')],
  spendPolicies: {},
  cooldowns: {},
  laneTokens,
});

// Fixture tokens deliberately do not carry the real credential prefix: the source-tree
// ratchet in generic.test.js forbids it, and nothing here depends on the shape. The one
// test that needs a realistic token (extractSetupToken) assembles it at runtime.
const liveEntry = (extra = {}) => ({ token: 'tok-abc', accountId: 'claude-work', mintedAt: 1000, ...extra });

const okFetch = async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 10 } }) });
const refusedFetch = (status) => async () => ({ ok: false, status, json: async () => ({}) });
const downFetch = async () => { throw new Error('offline'); };

test('laneTokenFor answers the stored token only when it is live', () => {
  assert.equal(laneTokenFor(settingsWith(), 'lane-1'), null);
  assert.equal(laneTokenFor(settingsWith({ 'lane-1': liveEntry({ token: '' }) }), 'lane-1'), null);
  assert.equal(laneTokenFor(settingsWith({ 'lane-1': liveEntry({ dead: true, deadReason: 'revoked or expired' }) }), 'lane-1'), null);
  assert.equal(laneTokenFor(settingsWith({ 'lane-1': liveEntry() }), 'lane-1'), 'tok-abc');
});

test('laneTokenFor tolerates settings that never carried the key', () => {
  assert.equal(laneTokenFor({ lanes: [] }, 'lane-1'), null);
  assert.equal(laneTokenFor(null, 'lane-1'), null);
});

test('a 401 marks the token dead, and it stops being handed out', async () => {
  const { settings, changed, results } = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry() }),
    { fetchImpl: refusedFetch(401), now: 5000 },
  );
  assert.equal(changed, true);
  assert.deepEqual(results, [{ laneId: 'lane-1', outcome: 'dead' }]);
  assert.deepEqual(settings.laneTokens['lane-1'], {
    token: 'tok-abc',
    accountId: 'claude-work',
    mintedAt: 1000,
    dead: true,
    deadReason: 'revoked or expired',
    checkedAt: 5000,
  });
  assert.equal(laneTokenFor(settings, 'lane-1'), null);
});

test('a 403 is the same refusal as a 401', async () => {
  const { settings } = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry() }),
    { fetchImpl: refusedFetch(403), now: 5000 },
  );
  assert.equal(settings.laneTokens['lane-1'].dead, true);
});

test('a network failure is not evidence of death and only stamps checkedAt', async () => {
  const { settings, changed, results } = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry() }),
    { fetchImpl: downFetch, now: 5000 },
  );
  assert.equal(changed, true);
  assert.deepEqual(results, [{ laneId: 'lane-1', outcome: 'unreachable' }]);
  assert.equal(settings.laneTokens['lane-1'].dead, undefined);
  assert.equal(settings.laneTokens['lane-1'].checkedAt, 5000);
  assert.equal(laneTokenFor(settings, 'lane-1'), 'tok-abc');
});

test('a 500 is treated like a network failure, not like a refusal', async () => {
  const { settings } = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry() }),
    { fetchImpl: refusedFetch(500), now: 5000 },
  );
  assert.equal(settings.laneTokens['lane-1'].dead, undefined);
  assert.equal(laneTokenFor(settings, 'lane-1'), 'tok-abc');
});

test('a token the vendor still honours keeps everything and stamps checkedAt', async () => {
  const { settings, changed, results } = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry() }),
    { fetchImpl: okFetch, now: 5000 },
  );
  assert.equal(changed, true);
  assert.deepEqual(results, [{ laneId: 'lane-1', outcome: 'ok' }]);
  assert.equal(settings.laneTokens['lane-1'].checkedAt, 5000);
  assert.equal(laneTokenFor(settings, 'lane-1'), 'tok-abc');
});

test('dead and empty entries cost no request at all', async () => {
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  const { changed, results } = await validateLaneTokens(
    settingsWith({
      'lane-1': liveEntry({ dead: true, deadReason: 'revoked or expired' }),
      'lane-2': liveEntry({ token: '' }),
    }),
    { fetchImpl: counting, now: 5000 },
  );
  assert.equal(calls, 0);
  assert.equal(changed, false);
  assert.deepEqual(results, []);
});

test('laneIds narrows the pass to the named lanes', async () => {
  let seen = [];
  const recording = async (url, init) => {
    seen.push(init.headers.authorization);
    return { ok: true, json: async () => ({}) };
  };
  const { settings } = await validateLaneTokens(
    settingsWith({
      'lane-1': liveEntry(),
      'lane-2': liveEntry({ token: 'tok-other' }),
    }),
    { fetchImpl: recording, now: 5000, laneIds: ['lane-2'] },
  );
  assert.deepEqual(seen, ['Bearer tok-other']);
  assert.equal(settings.laneTokens['lane-1'].checkedAt, undefined);
  assert.equal(settings.laneTokens['lane-2'].checkedAt, 5000);
});

test('validateLaneTokens leaves the settings it was given untouched', async () => {
  const before = settingsWith({ 'lane-1': liveEntry() });
  await validateLaneTokens(before, { fetchImpl: refusedFetch(401), now: 5000 });
  assert.equal(before.laneTokens['lane-1'].dead, undefined);
  assert.equal(before.laneTokens['lane-1'].checkedAt, undefined);
});

// ---- Folding a validation pass into settings another process may have edited ----
//
// A pass works from the snapshot it started with and can spend seconds on the network,
// and checkedAt stamping means it saves on nearly every pass. Saving the snapshot's
// whole map back would revert a concurrent removal, re-mint or dead-mark, so the merge
// applies only the lanes the pass checked, and only while the fresh entry still holds
// the very token that was validated.

test('a token removed mid-pass stays removed after the merge', async () => {
  const check = await validateLaneTokens(settingsWith({ 'lane-1': liveEntry() }), { fetchImpl: okFetch, now: 5000 });
  const fresh = settingsWith({});
  const merged = mergeLaneTokenResults(fresh, check);
  assert.equal(merged.laneTokens['lane-1'], undefined);
});

test('a token re-minted mid-pass with a new value wins over the stale snapshot', async () => {
  const check = await validateLaneTokens(settingsWith({ 'lane-1': liveEntry() }), { fetchImpl: refusedFetch(401), now: 5000 });
  const fresh = settingsWith({ 'lane-1': liveEntry({ token: 'tok-new', mintedAt: 4000 }) });
  const merged = mergeLaneTokenResults(fresh, check);
  assert.deepEqual(merged.laneTokens['lane-1'], { token: 'tok-new', accountId: 'claude-work', mintedAt: 4000 });
});

test('a concurrent dead-mark on a lane the pass never checked is preserved', async () => {
  const check = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry(), 'lane-2': liveEntry({ token: 'tok-other' }) }),
    { fetchImpl: okFetch, now: 5000, laneIds: ['lane-1'] },
  );
  const deadTwo = liveEntry({ token: 'tok-other', dead: true, deadReason: 'revoked or expired', checkedAt: 4500 });
  const fresh = settingsWith({ 'lane-1': liveEntry(), 'lane-2': deadTwo });
  const merged = mergeLaneTokenResults(fresh, check);
  assert.deepEqual(merged.laneTokens['lane-2'], deadTwo);
  assert.equal(merged.laneTokens['lane-1'].checkedAt, 5000);
});

test("the checked lane's own dead-mark is applied by the merge", async () => {
  const check = await validateLaneTokens(settingsWith({ 'lane-1': liveEntry() }), { fetchImpl: refusedFetch(401), now: 5000 });
  const fresh = settingsWith({ 'lane-1': liveEntry() });
  const merged = mergeLaneTokenResults(fresh, check);
  assert.equal(merged.laneTokens['lane-1'].dead, true);
  assert.equal(merged.laneTokens['lane-1'].checkedAt, 5000);
});

test('mergeLaneTokenResults mutates neither the fresh settings nor the pass result', async () => {
  const check = await validateLaneTokens(settingsWith({ 'lane-1': liveEntry() }), { fetchImpl: refusedFetch(401), now: 5000 });
  const fresh = settingsWith({ 'lane-1': liveEntry() });
  const freshBefore = JSON.stringify(fresh);
  const checkBefore = JSON.stringify(check);
  mergeLaneTokenResults(fresh, check);
  assert.equal(JSON.stringify(fresh), freshBefore);
  assert.equal(JSON.stringify(check), checkBefore);
});

// ---- The identity gate ----
//
// A stored token outlives the sign-in that minted it, so re-signing the folder into a
// different account must not leave automation billing the old one. No legitimately
// stored entry lacks a stamp (the mint path refuses to store without one), so an
// unstamped entry is out of band and refused; a stamped entry with an unreadable
// current identity fails safe too, because no token beats the wrong account's token.

test('laneTokenIdentityMatches truth table', () => {
  const stamped = liveEntry({ organizationUuid: 'org-1', accountUuid: 'acct-1' });
  assert.equal(laneTokenIdentityMatches(liveEntry(), { organizationUuid: 'org-2', accountUuid: 'acct-2' }), false);
  assert.equal(laneTokenIdentityMatches(liveEntry(), null), false);
  assert.equal(laneTokenIdentityMatches(stamped, { organizationUuid: 'org-1', accountUuid: 'acct-1' }), true);
  // The organization is the billing boundary; an identity that records no account
  // uuid still matches on the organization alone.
  assert.equal(laneTokenIdentityMatches(stamped, { organizationUuid: 'org-1', accountUuid: null }), true);
  assert.equal(laneTokenIdentityMatches(stamped, { organizationUuid: 'org-2', accountUuid: 'acct-2' }), false);
  assert.equal(laneTokenIdentityMatches(stamped, { organizationUuid: 'org-1', accountUuid: 'acct-9' }), false);
  assert.equal(laneTokenIdentityMatches(stamped, null), false);
});

test('extractSetupToken finds the token in a setup-token transcript, or answers null', () => {
  const token = ['sk', 'ant', 'oat01', 'AbC_1-xYz'].join('-');
  const transcript = `Visit the URL below to approve:\nhttps://example.invalid/approve\n\n${token}\n\nStore this token somewhere safe.\n`;
  assert.equal(extractSetupToken(transcript), token);
  assert.equal(extractSetupToken('no token here'), null);
  assert.equal(extractSetupToken(''), null);
  assert.equal(extractSetupToken(null), null);
});

test('redactSetupToken removes the token from a live echo and leaves the rest intact', () => {
  const token = ['sk', 'ant', 'oat01', 'AbC_1-xYz'].join('-');
  const transcript = `Visit https://example.invalid/approve?code=abc123 to approve.\n${token}\nStore this token somewhere safe: ${token}\n`;
  const redacted = redactSetupToken(transcript);
  assert.equal(redacted.includes(token), false);
  assert.equal(redacted.includes('https://example.invalid/approve?code=abc123'), true);
  assert.equal(redacted.includes('Store this token somewhere safe'), true);
  assert.equal(redacted.match(/\[redacted\]/g).length, 2);
  // The raw accumulator is what extraction runs on, and it still carries the value.
  assert.equal(extractSetupToken(transcript), token);
  assert.equal(redactSetupToken('no token here'), 'no token here');
});

const cliSource = () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  return fs.readFileSync(path.join(root, 'bin', 'cli.js'), 'utf8');
};

// The CLI decision itself has no spawn harness, so what is pinned here is the wiring:
// dry-run's token field is gated on the opt-in flag, on laneTokenFor and on the
// identity comparison against the lane folder's current sign-in, and the human form
// prints availability, never the value. laneTokenFor's own gating above is what makes
// "never null, never empty" true for the emitted field.
test('dry-run emission is wired through the flag, laneTokenFor and the identity gate', () => {
  const cli = cliSource();
  assert.match(cli, /const withToken = args\.includes\('--with-token'\)/);
  assert.match(cli, /const token = withToken \? emittableLaneToken\(selected\.lane\.id\) : null;/);
  assert.match(cli, /if \(token\) answer\.token = token;/);
  assert.match(cli, /emittableLaneToken\(selected\.lane\.id\) \? 'available' : 'none'/);
  assert.match(cli, /const token = laneTokenFor\(settings, laneId\);/);
  assert.match(cli, /laneTokenIdentityMatches\(settings\.laneTokens\?\.\[laneId\], identity\) \? token : null/);
});

// The mint path forwards the child's streams live, and setup-token prints the minted
// value as part of its normal flow, so the echo is redacted on both streams while the
// raw accumulator alone keeps the value for extraction.
test('the mint echo is redacted on both streams, chunk-split safe, and the raw text kept for extraction', () => {
  const cli = cliSource();
  assert.match(cli, /process\.stdout\.write\(outRedactor\.write\(data\.toString\(\)\)\);/);
  assert.match(cli, /process\.stderr\.write\(errRedactor\.write\(data\.toString\(\)\)\)/);
  assert.match(cli, /outRedactor\.flush\(\)/);
  assert.match(cli, /errRedactor\.flush\(\)/);
  assert.match(cli, /stdout \+= data\.toString\(\);/);
  assert.match(cli, /extractSetupToken\(minted\.stdout\)/);
});

// A junk entry (a non-string or empty token, from settings edited by hand) is skipped
// by validateLaneTokens, so without its own guard --check would fall through to the
// network-failure line with exit 0 despite no request ever being made.
test('lane-token --check refuses a junk entry instead of calling it a network failure', () => {
  const cli = cliSource();
  assert.match(cli, /typeof entry\.token !== 'string' \|\| entry\.token\.length === 0/);
  assert.match(cli, /no usable token is stored for/);
});

// Both validation save sites go through the merge, so a pass's stale snapshot can
// never clobber what a concurrent process wrote while the pass was on the network.
test('the watch and --check saves both merge into freshly loaded settings', () => {
  const cli = cliSource();
  assert.match(cli, /saveSettings\(mergeLaneTokenResults\(loadSettings\(\), tokenCheck\)\);/);
  assert.match(cli, /saveSettings\(mergeLaneTokenResults\(loadSettings\(\), checked\)\);/);
});

// A dead-mark keeps the same token value, so the merge's token guard alone would let a
// pass's ok, or a mere unreachable, resurrect a token another process had just proven
// revoked. The dead-mark must win: only a re-mint clears one, and a re-mint changes
// the token value, which the token guard already catches.
test('a concurrent dead-mark on the very lane the pass checked survives an ok result', async () => {
  const check = await validateLaneTokens(settingsWith({ 'lane-1': liveEntry() }), { fetchImpl: okFetch, now: 5000 });
  const fresh = settingsWith({ 'lane-1': liveEntry({ dead: true, deadReason: 'revoked or expired', checkedAt: 4500 }) });
  const merged = mergeLaneTokenResults(fresh, check);
  assert.deepEqual(merged.laneTokens['lane-1'], liveEntry({ dead: true, deadReason: 'revoked or expired', checkedAt: 4500 }));
});

test('a concurrent dead-mark survives even an unreachable result, which carries no vendor evidence', async () => {
  const check = await validateLaneTokens(settingsWith({ 'lane-1': liveEntry() }), { fetchImpl: downFetch, now: 5000 });
  const fresh = settingsWith({ 'lane-1': liveEntry({ dead: true, deadReason: 'revoked or expired', checkedAt: 4500 }) });
  const merged = mergeLaneTokenResults(fresh, check);
  assert.equal(merged.laneTokens['lane-1'].dead, true);
  assert.equal(merged.laneTokens['lane-1'].checkedAt, 4500);
});

// The live mint echo arrives in arbitrary chunks, so a per-chunk replace would let a
// token split across two of them print its tail in the clear. The streaming redactor
// holds back only what could still grow into a token.
test('the streaming redactor never lets a chunk-split token through', () => {
  const prefix = ['sk', 'ant', 'oat01'].join('-') + '-';
  const token = prefix + 'AbC123_-xyz';
  const r = createSetupTokenRedactor();
  const shown = r.write('Your token is: ' + token.slice(0, 18)) + r.write(token.slice(18) + '\nDone.\n') + r.flush();
  assert.ok(!shown.includes(token.slice(13)), 'no part of the token body may reach the terminal');
  assert.ok(shown.includes(prefix + '[redacted]'));
  assert.ok(shown.includes('Your token is: '));
  assert.ok(shown.includes('Done.'));
});

test('the streaming redactor holds back a token split inside the prefix itself', () => {
  const prefix = ['sk', 'ant', 'oat01'].join('-') + '-';
  const token = prefix + 'SECRETBODY';
  const r = createSetupTokenRedactor();
  const shown = r.write('token: ' + token.slice(0, 5)) + r.write(token.slice(5) + ' end\n') + r.flush();
  assert.ok(!shown.includes('SECRETBODY'));
  assert.ok(shown.includes(prefix + '[redacted]'));
  assert.ok(shown.includes(' end'));
});

test('the streaming redactor passes an interactive prompt through promptly, and flush releases a held token', () => {
  const prefix = ['sk', 'ant', 'oat01'].join('-') + '-';
  const r = createSetupTokenRedactor();
  const first = r.write('Open https://claude.ai/activate and approve, then press Enter: ');
  assert.ok(first.includes('https://claude.ai/activate'));
  // A token that ends the stream is still held when it closes; flush redacts it.
  const second = r.write('done. ' + prefix + 'TAILBODY');
  assert.ok(!second.includes('TAILBODY'));
  const rest = r.flush();
  assert.equal(rest, prefix + '[redacted]');
  assert.equal(r.flush(), '', 'a second flush returns nothing, so settling twice cannot double-print');
});

// The tray is the resident watcher on a desktop machine, so it must run the same
// validation the CLI watch runs; without it a vendor-revoked token would never be
// marked dead there, and dry-run would keep handing it to automation.
test('the tray quota watch validates lane tokens with the same merge discipline', () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
  const validate = main.indexOf('const tokenCheck = await validateLaneTokens(settings, { now: Date.now(), maxAgeMs: 60 * 60 * 1000 });');
  assert.ok(validate >= 0, 'the tray validates stored lane tokens, hourly-throttled');
  assert.match(main, /const merged = mergeLaneTokenResults\(before, tokenCheck\);/);
  // The round-4 defect was this block sitting AFTER the quota-watch mode gate, which
  // meant default installs (quotaWatch 'off') never validated tokens at all. Pin the
  // order so a future shuffle cannot quietly reopen that hole.
  const gate = main.indexOf("if (settings.quotaWatch === 'off') return;");
  assert.ok(gate > validate, "validation precedes the quota-watch 'off' gate, so default installs still check tokens");
  // A death raises an active notification naming the re-mint command, never the value.
  assert.match(main, /switchboard lane-token \$\{r\.laneId\}/);
});

// The timed passes pass a freshness window so a recently checked token costs no vendor
// call; a skipped lane produces no result row, so the merge leaves it untouched. The
// explicit --check passes no window and always asks.
test('maxAgeMs skips a freshly checked token and rechecks a stale one', async () => {
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  const fresh = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry({ checkedAt: 5000 }) }),
    { fetchImpl: counting, now: 5000 + 60_000, maxAgeMs: 60 * 60 * 1000 },
  );
  assert.equal(calls, 0);
  assert.equal(fresh.changed, false);
  assert.deepEqual(fresh.results, []);
  const stale = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry({ checkedAt: 5000 }) }),
    { fetchImpl: counting, now: 5000 + 61 * 60_000, maxAgeMs: 60 * 60 * 1000 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(stale.results, [{ laneId: 'lane-1', outcome: 'ok' }]);
});

test('no maxAgeMs means every live token is asked about, however fresh', async () => {
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry({ checkedAt: 5000 }) }),
    { fetchImpl: counting, now: 5001 },
  );
  assert.equal(calls, 1);
});

// A checkedAt ahead of now means the clock that wrote it was wrong; treating it as
// fresh would suppress validation for the whole skew. Stale-on-future re-asks the
// vendor and re-stamps with the corrected clock.
test('a checkedAt in the future is stale, not fresh', async () => {
  let calls = 0;
  const counting = async () => { calls++; return { ok: true, json: async () => ({}) }; };
  const { settings, results } = await validateLaneTokens(
    settingsWith({ 'lane-1': liveEntry({ checkedAt: 5000 + 24 * 60 * 60_000 }) }),
    { fetchImpl: counting, now: 5000, maxAgeMs: 60 * 60 * 1000 },
  );
  assert.equal(calls, 1);
  assert.deepEqual(results, [{ laneId: 'lane-1', outcome: 'ok' }]);
  assert.equal(settings.laneTokens['lane-1'].checkedAt, 5000);
});
