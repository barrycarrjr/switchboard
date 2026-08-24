import fs from 'node:fs';
import path from 'node:path';
import { dataDir, writeJsonAtomic } from './paths.js';
import { PROVIDERS } from './accounts.js';
import { providerQuota } from './quota.js';

/**
 * A quota reading shared across processes, on disk.
 *
 * The tray app, `switchboard status`, `switchboard dry-run` and `switchboard quota`
 * all want the same numbers, but only the app kept a cache, and only in memory. Every
 * CLI invocation therefore hit the live usage endpoints fresh, for every account, and
 * the CLI is exactly the surface other tools automate (Paperclip and the Slack bridge
 * both run `dry-run` before spawning work). The endpoints rate-limit aggressively, so
 * the busiest surface was the one with no cache at all.
 *
 * This file is that cache: any process that fetches a live reading writes it here, and
 * any process that needs one reads it first. Only live readings are shared; fallback
 * sources (Claude Desktop history, Codex session logs) are themselves files that cost
 * nothing to re-read, and caching them would add a second layer of staleness to
 * readings that already carry their own sample time.
 */

/**
 * How long a shared reading stands in for a live call. Matched to the tray app's
 * five-minute watch, which keeps this file warm: a CLI caller inside the window rides
 * the app's reading instead of spending a request of its own. Usage percentages move
 * slowly enough that five minutes cannot misdescribe an account's health, and every
 * decision reader (core/lanes.js) treats missing-or-old as unknown, never as empty.
 */
export const SHARED_QUOTA_TTL_MS = 5 * 60 * 1000;

export function quotaCacheFile() {
  return path.join(dataDir(), 'quota-cache.json');
}

/**
 * The key a shared reading is filed under. Includes the credential file's size and
 * mtime so a re-authentication (or sign-out) invalidates every reading taken with the
 * old credential, the same way the app's in-memory caches key on a credential stamp.
 */
export function sharedQuotaKey(provider, home) {
  const def = PROVIDERS[provider];
  let stamp = 'missing';
  if (def?.credFile) {
    try {
      const stat = fs.statSync(path.join(home, def.credFile));
      stamp = `${stat.size}:${stat.mtimeMs}`;
    } catch {
      stamp = 'missing';
    }
  }
  return `${provider}:${path.resolve(home).toLowerCase()}:${stamp}`;
}

/** The shared reading for one account, or null when there is none fresh enough. */
export function readSharedQuota(accountId, key, now = Date.now(), file = quotaCacheFile(), ttl = SHARED_QUOTA_TTL_MS) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))?.[accountId];
    if (!entry || entry.key !== key) return null;
    // A clock that moved backwards makes `at` look future-dated; treat that as absent
    // rather than serving a reading whose age cannot be known.
    if (typeof entry.at !== 'number' || entry.at > now || now - entry.at > ttl) return null;
    if (!entry.result || entry.result.error) return null;
    return { ...entry.result, observedAt: entry.at, cached: true };
  } catch {
    return null;
  }
}

/** Record a live reading for other processes. Failures and fallbacks are never shared. */
export function writeSharedQuota(accountId, key, result, at = Date.now(), file = quotaCacheFile()) {
  if (!result || result.error || result.source !== 'token') return;
  let all = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed;
  } catch {
    // a torn or missing file simply starts over
  }
  all[accountId] = { key, at, result };
  try {
    writeJsonAtomic(file, all);
  } catch {
    // the cache is an optimization; failing to write it must never fail the reading
  }
}

/**
 * providerQuota with the shared cache in front of it: serve a fresh-enough shared
 * reading, otherwise fetch live and share the result. The CLI's one quota path.
 */
export async function sharedProviderQuota(account, { usageSource = null, now = Date.now(), fetchImpl = fetch } = {}) {
  const key = sharedQuotaKey(account.provider, account.home);
  const hit = readSharedQuota(account.id, key, now);
  if (hit) return hit;
  const result = await providerQuota(account.provider, account.home, { fetchImpl, usageSource, now });
  writeSharedQuota(account.id, key, result, Date.now());
  return result;
}
