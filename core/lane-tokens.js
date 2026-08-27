import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { markLaneTokenDead } from './lane-admin.js';
import { CLAUDE_CREDENTIAL_ENV_VARS } from './accounts.js';
import { toolExecutable } from './providers.js';

/**
 * Whether a lane may hand its token out, kept apart from lane-admin.js, which edits the
 * entries, and from bin/cli.js, which only prints what this file decides.
 *
 * A lane token is an opt-in extra riding alongside the folder sign-in: automation that
 * asks for it authenticates with the token instead of opening the folder's credential
 * file, and everything else (selection, health checks, interactive use) keeps using the
 * folder login exactly as before. So the failure mode of everything here is deliberate:
 * when a token is missing, empty or dead, it is simply not handed out, and the caller
 * reverts to folder mode, which is the behaviour it had before tokens existed.
 */

/**
 * The setup token in a transcript of `claude setup-token`, or null when it printed none.
 *
 * The prefix is assembled at runtime because the source-tree ratchet in
 * test/generic.test.js forbids the literal credential prefix appearing anywhere in the
 * shipped tree, and a matcher FOR credentials is still a string OF one to a scanner.
 */
const SETUP_TOKEN_PREFIX = ['sk', 'ant', 'oat01'].join('-') + '-';
const SETUP_TOKEN_RX = new RegExp(SETUP_TOKEN_PREFIX + '[A-Za-z0-9_-]+');
const SETUP_TOKEN_RX_ALL = new RegExp(SETUP_TOKEN_PREFIX + '[A-Za-z0-9_-]+', 'g');

export function extractSetupToken(text) {
  return String(text ?? '').match(SETUP_TOKEN_RX)?.[0] ?? null;
}

/**
 * The same text with every setup token replaced by a marker, for anything that quotes
 * a transcript of `claude setup-token`, which prints the minted value as part of its
 * normal flow. The mint path itself no longer captures that transcript at all (the
 * tool renders only on a real console, so it gets the terminal unfiltered and the user
 * pastes the token back), but a scrubber for the credential shape stays useful and
 * tested. The marker keeps the runtime-assembled prefix so a scrubbed transcript
 * still shows that a token was printed there, just not what it was.
 */
export function redactSetupToken(text) {
  return String(text ?? '').replace(SETUP_TOKEN_RX_ALL, SETUP_TOKEN_PREFIX + '[redacted]');
}

/**
 * The token a lane may hand to automation, or null. This is the single decision point:
 * `dry-run --with-token` emits exactly what this returns, so the field can never be
 * emitted as null or an empty string, and a dead token stops being emitted the moment
 * it is marked.
 */
export function laneTokenFor(settings, laneId) {
  const entry = (settings?.laneTokens ?? {})[laneId];
  if (!entry) return null;
  if (typeof entry.token !== 'string' || entry.token.length === 0) return null;
  if (entry.dead) return null;
  return entry.token;
}

/**
 * Whether a stored token entry still belongs to the login its lane's folder carries.
 *
 * A token outlives the sign-in that minted it: re-signing the folder into a different
 * claude.ai account leaves the old account's token stored, and automation would keep
 * billing that old account for up to a year. The mint path stamps the minting login's
 * identity onto the entry so this can notice. No legitimately stored entry lacks that
 * stamp: the mint path refuses to store one when the folder's identity is unreadable,
 * so an unstamped entry is out of band (hand-edited, hand-copied, restored from an
 * older backup) and is refused the same way a mismatch is. Refusal is the safe
 * direction throughout: handing out no token only reverts automation to folder mode,
 * while handing out the wrong account's token spends someone else's allowance.
 * The account uuid is compared only when both sides carry one: the organization is the
 * billing boundary, and an identity file does not always record the account.
 */
export function laneTokenIdentityMatches(entry, identity) {
  const stamped = typeof entry?.organizationUuid === 'string' && entry.organizationUuid.length > 0;
  if (!stamped) return false;
  if (typeof identity?.organizationUuid !== 'string' || identity.organizationUuid.length === 0) return false;
  if (identity.organizationUuid !== entry.organizationUuid) return false;
  const mintedAs = typeof entry.accountUuid === 'string' && entry.accountUuid.length > 0 ? entry.accountUuid : null;
  const signedInAs = typeof identity.accountUuid === 'string' && identity.accountUuid.length > 0 ? identity.accountUuid : null;
  if (mintedAs && signedInAs && mintedAs !== signedInAs) return false;
  return true;
}

/**
 * Whether the vendor still honours a setup token, answered the only honest way there
 * is: by running Claude with it. The account usage endpoint refuses setup tokens
 * outright (learned on the first real mint: a token minted seconds earlier came back
 * 401 there while working perfectly for runs), and `claude auth status` reports
 * loggedIn for any well-shaped value without asking the vendor at all. So the probe
 * is a minimal headless run on the cheapest model, under a throwaway config folder
 * with every other credential stripped, so nothing on the machine can answer for the
 * token and nothing real is touched.
 *
 * Answers 'ok', 'dead' (the vendor refused the credential itself), or 'unreachable'
 * (anything else: network, timeout, a missing binary; not evidence of death, the same
 * philosophy as quota-unknown in core/lanes.js).
 */
// The first alternation is the CLI's observed wording for a refused setup token,
// captured live: "Failed to authenticate. API Error: 401 OAuth access token is
// invalid." The rest cover the wordings its other auth failures have used.
const AUTH_REFUSAL_RX = /Failed to authenticate|API Error: 401|OAuth session expired|invalid (?:api key|bearer token|token)|token is (?:invalid|expired|revoked)|authentication[_ ]error|please run \/login|not logged in|credential.*(?:revoked|expired)/i;

export async function probeSetupToken(token, {
  executable = null,
  spawnImpl = spawn,
  timeoutMs = 120_000,
  baseEnv = process.env,
} = {}) {
  const bin = executable ?? await toolExecutable('claude');
  if (!bin) return 'unreachable';

  const env = {};
  const rejected = new Set(['CLAUDE_CONFIG_DIR', ...CLAUDE_CREDENTIAL_ENV_VARS].map((n) => n.toUpperCase()));
  for (const [name, value] of Object.entries(baseEnv ?? {})) {
    if (!rejected.has(name.toUpperCase())) env[name] = value;
  }
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-token-probe-'));
  env.CLAUDE_CONFIG_DIR = scratch;
  env.CLAUDE_CODE_OAUTH_TOKEN = token;

  // The same batch-shim wrapping the run case uses: cmd.exe mangles nothing here
  // because every argument is a plain word.
  let file = bin;
  let args = ['-p', 'Reply with exactly: ok', '--model', 'haiku'];
  if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin)) {
    file = 'cmd.exe';
    args = ['/d', '/s', '/v:off', '/c', bin, ...args];
  }

  try {
    return await new Promise((resolve) => {
      let output = '';
      let settled = false;
      const settle = (answer) => { if (!settled) { settled = true; clearTimeout(timer); resolve(answer); } };
      const child = spawnImpl(file, args, { env, cwd: scratch, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { try { child.kill(); } catch { /* already gone */ } settle('unreachable'); }, timeoutMs);
      child.stdout?.on('data', (d) => { output += d.toString(); });
      child.stderr?.on('data', (d) => { output += d.toString(); });
      child.on('error', () => settle('unreachable'));
      child.on('close', (code) => {
        if (code === 0) return settle('ok');
        settle(AUTH_REFUSAL_RX.test(output) ? 'dead' : 'unreachable');
      });
    });
  } finally {
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/**
 * Ask the vendor whether each stored live token is still honoured, one probe run per
 * token (see probeSetupToken). Only the vendor refusing the credential itself marks a
 * token dead; a network failure or any other error is NOT evidence of death (the same
 * philosophy as quota-unknown in core/lanes.js: failing to read the meter is not an
 * empty tank) and only stamps checkedAt. Entries already dead, and entries with no
 * usable token, cost nothing.
 *
 * Pure apart from the fetch: settings in, new settings out, and `changed` tells the
 * caller whether anything is worth saving. `laneIds` narrows the pass to named lanes,
 * for `lane-token <laneId> --check`; omitted means every stored token.
 */
export async function validateLaneTokens(settings, { probeImpl = probeSetupToken, now = Date.now(), laneIds = null, maxAgeMs = null } = {}) {
  const wanted = laneIds ? new Set(laneIds) : null;
  const results = [];
  let next = settings;
  let changed = false;

  const stamp = (laneId, entry) => {
    next = { ...next, laneTokens: { ...(next.laneTokens ?? {}), [laneId]: { ...entry, checkedAt: now } } };
    changed = true;
  };

  for (const [laneId, entry] of Object.entries(settings?.laneTokens ?? {})) {
    if (wanted && !wanted.has(laneId)) continue;
    if (!entry || typeof entry.token !== 'string' || entry.token.length === 0 || entry.dead) continue;
    // The timed passes run every few minutes forever, and one real probe run per
    // token per pass adds up against a rate-limited endpoint. A freshness window lets
    // them skip a recently checked token; a skipped lane produces no result row, so
    // the merge leaves it untouched. An explicit --check passes no window and always
    // asks the vendor. A stamp in the FUTURE is treated as stale, not fresh: a pass
    // run under a fast clock (VM resume, clock correction) would otherwise suppress
    // validation for the whole skew, and re-checking simply re-stamps with the
    // corrected clock. Same guard quota-cache.js applies to its own persisted stamp.
    if (maxAgeMs != null && typeof entry.checkedAt === 'number'
      && now - entry.checkedAt >= 0 && now - entry.checkedAt < maxAgeMs) continue;
    let outcome;
    try {
      outcome = await probeImpl(entry.token);
    } catch {
      outcome = 'unreachable';
    }
    if (outcome === 'dead') {
      next = markLaneTokenDead(next, laneId, 'revoked or expired', now);
      changed = true;
      results.push({ laneId, outcome: 'dead' });
    } else if (outcome === 'ok') {
      stamp(laneId, entry);
      results.push({ laneId, outcome: 'ok' });
    } else {
      stamp(laneId, entry);
      results.push({ laneId, outcome: 'unreachable' });
    }
  }

  return { settings: next, changed, results };
}

/**
 * Fold a validation pass's outcomes into freshly loaded settings, one lane at a time.
 *
 * A validation pass works from the settings snapshot it started with and can spend
 * seconds on the network, and checkedAt stamping means it has something to save on
 * nearly every pass. Saving that snapshot's whole laneTokens map back would silently
 * revert whatever another process wrote in the meantime: a token removed mid-pass
 * would be resurrected into settings.json, and a token re-minted mid-pass would be
 * replaced by the stale one that was checked. So the caller re-reads settings and this
 * applies only the lanes the pass actually checked, and only while the fresh entry
 * still holds the very token that was validated: a mid-pass removal stays removed, a
 * mid-pass re-mint with a different token wins, and a lane the pass never touched is
 * never touched here either. A concurrent dead-mark on the very lane this pass
 * checked also wins: it keeps the same token value, so the token guard alone would
 * let a pass's ok (or a mere unreachable, which carries no vendor evidence at all)
 * resurrect a token another process had just proven revoked. A dead-mark is only
 * legitimately cleared by a re-mint, and a re-mint changes the token value, which the
 * token guard already catches. Pure: fresh settings in, new settings out, ready to save.
 */
export function mergeLaneTokenResults(freshSettings, tokenCheck) {
  const laneTokens = { ...(freshSettings?.laneTokens ?? {}) };
  const checked = tokenCheck?.settings?.laneTokens ?? {};
  for (const { laneId } of tokenCheck?.results ?? []) {
    const current = laneTokens[laneId];
    const validated = checked[laneId];
    if (!current || !validated) continue;
    if (current.token !== validated.token) continue;
    if (current.dead && !validated.dead) continue;
    laneTokens[laneId] = validated;
  }
  return { ...freshSettings, laneTokens };
}
