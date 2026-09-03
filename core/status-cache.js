import fs from 'node:fs';
import path from 'node:path';
import { dataDir, writeJsonAtomic } from './paths.js';

/**
 * A vendor status-page reading shared across processes, on disk.
 *
 * Unlike quota-cache.js this has no per-account key: a status page belongs to the
 * vendor, not to any Switchboard account, so one reading serves every account on that
 * provider and every Switchboard process on the machine.
 *
 * How long a shared reading stands in before asking the vendor again. Matches the
 * quota cache's five-minute window: a status page changes slowly enough that five
 * minutes cannot misdescribe an outage, and it keeps repeated Health-tab visits from
 * hammering five public endpoints that have nothing to do with any Switchboard account.
 */
export const SHARED_STATUS_TTL_MS = 5 * 60 * 1000;

export function statusCacheFile() {
  return path.join(dataDir(), 'status-cache.json');
}

/** The shared reading for one provider, or null when there is none fresh enough. */
export function readSharedStatus(id, now = Date.now(), file = statusCacheFile(), ttl = SHARED_STATUS_TTL_MS) {
  try {
    const entry = JSON.parse(fs.readFileSync(file, 'utf8'))?.[id];
    if (!entry) return null;
    // A clock that moved backwards makes `at` look future-dated; treat that as absent
    // rather than serving a reading whose age cannot be known.
    if (typeof entry.at !== 'number' || entry.at > now || now - entry.at > ttl) return null;
    if (!entry.result) return null;
    return { ...entry.result, checkedAt: entry.at, cached: true };
  } catch {
    return null;
  }
}

/** Record a live reading for other processes. A failed check is never shared. */
export function writeSharedStatus(id, result, at = Date.now(), file = statusCacheFile()) {
  if (!result || result.error) return;
  let all = {};
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed;
  } catch {
    // a torn or missing file simply starts over
  }
  all[id] = { at, result };
  try {
    writeJsonAtomic(file, all);
  } catch {
    // the cache is an optimization; failing to write it must never fail the reading
  }
}
