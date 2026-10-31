import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir, writeJsonAtomic } from './paths.js';

/**
 * Default thresholds for notifications, in integer percentages (0-100).
 * The Session (5h) window moves fastest, so 80% gives warning before hitting limits.
 * The Weekly window (all models) moves slower, so 85% provides hours of runway.
 */
export const DEFAULT_THRESHOLDS = {
  session: 80,
  week: 85,
};

/**
 * Normalizes thresholds from settings into a clean map of window keys to numbers.
 * Any non-numeric or out-of-range value falls back to default.
 */
export function normalizeThresholds(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ...DEFAULT_THRESHOLDS };
  }
  const clean = { ...DEFAULT_THRESHOLDS };
  for (const [k, v] of Object.entries(input)) {
    const num = Math.round(Number(v));
    if (!Number.isNaN(num) && num >= 1 && num <= 100) clean[k] = num;
  }
  return clean;
}

/**
 * Format a human-readable notification sentence suitable for display, desktop
 * toast, and chat applications like Slack.
 */
export function formatNotificationText(event) {
  if (!event) return '[Switchboard] Notification';
  if (event.kind === 'threshold') {
    const label = event.accountLabel || event.accountId || 'Account';
    const providerStr = event.provider ? ` (${event.provider})` : '';
    const resetStr = event.resetsAt ? `, resets at ${new Date(event.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    return `[Switchboard] ${label}${providerStr} reached ${event.usedPercent}% of ${event.windowLabel || event.window} (threshold: ${event.threshold}%)${resetStr}.`;
  }
  if (event.kind === 'switch') {
    return `[Switchboard] Switched default ${event.provider || 'account'}: ${event.reason || 'lane handover'}.`;
  }
  if (event.kind === 'exhausted') {
    const resetStr = event.resetsAt ? `, earliest reset at ${new Date(event.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
    return `[Switchboard] Quota exhausted: no ${event.provider || 'AI'} account has room${resetStr}.`;
  }
  if (event.kind === 'test') {
    const label = event.accountLabel || 'Test Account';
    return `[Switchboard] Test alert: notification hooks are configured and working for ${label} (${event.windowLabel || 'Session'}: ${event.usedPercent}%).`;
  }
  return `[Switchboard] ${event.reason || event.event || 'Notification'}`;
}

/**
 * Builds a standardized payload for webhooks and command hooks.
 * Includes both "text" (standard Slack Incoming Webhook body) and "content" (Discord),
 * along with structured fields for automated bridges.
 */
export function buildNotificationPayload(event, now = Date.now()) {
  const text = formatNotificationText(event);
  return {
    text,
    content: text,
    event: event.event || event.kind,
    at: new Date(now).toISOString(),
    ...event,
  };
}

/**
 * Two readings of one reset time count as the same period when they are this close.
 *
 * The vendors state a reset to the millisecond and two readings of the same one differ in
 * the last digits, and a reading from the Claude Desktop log can be a little further off.
 * The next period of the shortest window starts five hours later, so half an hour
 * separates "the same reset, read twice" from "a new period" with room on both sides.
 */
export const SAME_RESET_TOLERANCE_MS = 30 * 60 * 1000;

/**
 * Pure evaluation of quota snapshots against thresholds.
 *
 * Takes registered accounts, quota snapshots, configured thresholds, and
 * previous notification memory. For each window crossing its threshold, emits a
 * threshold event once per reset period.
 *
 * Once per period means once, whatever the readings do in between. A reading that dips
 * under the mark and back again within one period is two usage sources disagreeing by a
 * point or two, not a fresh climb, and alerting on it again was noise. Memory is only
 * superseded by a reading from a later period, and entries for periods long gone are
 * dropped so the file does not grow for ever.
 *
 * Memory structure:
 *   { [`${accountId}:${windowKey}`]: { resetsAt, usedPercent, notifiedAt } }
 */
export function checkThresholds({
  accounts = [],
  snapshots = {},
  thresholds = DEFAULT_THRESHOLDS,
  memory = {},
  now = Date.now(),
} = {}) {
  const normThresholds = normalizeThresholds(thresholds);
  const events = [];
  const nextMemory = {};
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  // Keep what still describes a current or recent period; drop the rest.
  for (const [k, v] of Object.entries(memory ?? {})) {
    if (!v || typeof v !== 'object') continue;
    const current = v.resetsAt != null ? v.resetsAt > now - 24 * 60 * 60 * 1000 : now - (v.notifiedAt ?? 0) < WEEK;
    if (current) nextMemory[k] = v;
  }

  for (const account of accounts) {
    const snapshot = snapshots[account.id];
    if (!snapshot || snapshot.error || snapshot.stale || !Array.isArray(snapshot.windows)) {
      continue;
    }

    for (const w of snapshot.windows) {
      if (w.usedPercent == null || Number.isNaN(Number(w.usedPercent))) continue;

      const threshold = normThresholds[w.key] ?? normThresholds.default ?? null;
      if (threshold == null) continue;

      const memKey = `${account.id}:${w.key}`;
      const used = Number(w.usedPercent);
      if (used < threshold) continue;
      // A reading whose window has already turned over describes a period that is gone.
      // Its usage is not true any more, and its memory may already have been dropped
      // below, so alerting on it would repeat on every pass until a new reading arrives.
      if (w.resetsAt != null && Number(w.resetsAt) <= now) continue;

      const prev = nextMemory[memKey];
      // How long one period of this window lasts: five hours for the session, a week for
      // the rest. Used where one of the two readings states no reset time.
      const duration = w.key === 'session' ? 5 * 60 * 60 * 1000 : WEEK;
      let alreadyNotified = false;
      if (prev) {
        if (w.resetsAt != null && prev.resetsAt != null) {
          alreadyNotified = Math.abs(Number(prev.resetsAt) - Number(w.resetsAt)) < SAME_RESET_TOLERANCE_MS;
        } else if (prev.resetsAt != null) {
          // This reading states no reset, the remembered one did: still that period
          // until its reset passes.
          alreadyNotified = now < Number(prev.resetsAt) + SAME_RESET_TOLERANCE_MS;
        } else if (w.resetsAt != null) {
          // Remembered without a reset, read now with one: the same period if the alert
          // went out after this period began. The two usage sources take turns on some
          // machines, and one of them states no reset.
          alreadyNotified = Number(prev.notifiedAt) > Number(w.resetsAt) - duration;
          if (alreadyNotified) nextMemory[memKey] = { ...prev, resetsAt: w.resetsAt };
        } else {
          // Neither states a reset: silence repeats for one window's length.
          alreadyNotified = now - prev.notifiedAt < duration;
        }
      }
      if (alreadyNotified) continue;

      nextMemory[memKey] = {
        resetsAt: w.resetsAt ?? null,
        usedPercent: used,
        notifiedAt: now,
      };
      events.push({
        kind: 'threshold',
        event: 'threshold_reached',
        provider: account.provider,
        accountId: account.id,
        accountLabel: account.label,
        window: w.key,
        windowLabel: w.label || w.key,
        usedPercent: used,
        threshold,
        resetsAt: w.resetsAt ?? null,
      });
    }
  }

  return { events, memory: nextMemory };
}

/**
 * What has already been said, kept on disk so that it is said once however the watch runs.
 * The tray keeps running and could hold this in memory, but `switchboard watch --once`
 * from Task Scheduler is a new process every few minutes, and with nothing remembered it
 * sent every alert again on every run.
 *
 * Two records, because there are two audiences:
 *
 *   hooks  what went to the webhook and command hook. Shared by the tray and every
 *          terminal watch, so when both run, the hooks hear it from one of them.
 *   tray   what the tray showed on the desktop. Only the tray shows desktop
 *          notifications, so a terminal watch saying something to the hooks must not
 *          stop the person at the desk from seeing it.
 *
 * Each holds `thresholds` (checkThresholds memory) and `notices` (freshNotices memory).
 */
export const ALERT_AUDIENCES = ['hooks', 'tray'];

export function alertMemoryFile() {
  return path.join(dataDir(), 'alerts.json');
}

const asMap = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

export function loadAlertMemory(file = alertMemoryFile()) {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = {};
  }
  const memory = {};
  for (const audience of ALERT_AUDIENCES) {
    const part = asMap(raw?.[audience]);
    memory[audience] = { thresholds: asMap(part.thresholds), notices: asMap(part.notices) };
  }
  return memory;
}

/**
 * Write one audience's record, re-reading the file first so the other audience's record,
 * which another process may have just written, is kept as it is.
 */
export function saveAlertMemory(audience, record, file = alertMemoryFile()) {
  try {
    const memory = loadAlertMemory(file);
    memory[audience] = { thresholds: asMap(record?.thresholds), notices: asMap(record?.notices) };
    writeJsonAtomic(file, memory);
  } catch {
    // Not remembering costs a repeated alert at worst, never a failed watch pass.
  }
}

/**
 * Dispatches a notification payload to configured webhook and/or command hooks.
 * Fails safely: network errors, 4xx/5xx responses, or child spawn failures are
 * captured and never bubble up to crash the caller.
 */
export async function dispatchNotification(settings = {}, payload, { fetchImpl = fetch, spawnImpl = spawn } = {}) {
  const results = { webhook: null, command: null };
  if (!settings || !payload) return results;

  if (settings.notifyWebhookUrl) {
    try {
      const res = await fetchImpl(settings.notifyWebhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      results.webhook = { ok: res.ok, status: res.status };
    } catch (err) {
      results.webhook = { ok: false, error: err.message || String(err) };
    }
  }

  if (settings.notifyCommand) {
    try {
      const child = spawnImpl(settings.notifyCommand, [], {
        shell: true,
        stdio: ['pipe', 'ignore', 'ignore'],
        env: {
          ...process.env,
          SWITCHBOARD_EVENT: JSON.stringify(payload),
        },
        windowsHide: true,
      });
      child.on('error', () => {});
      if (child.stdin) {
        child.stdin.write(JSON.stringify(payload));
        child.stdin.end();
      }
      results.command = { ok: true, spawned: true };
    } catch (err) {
      results.command = { ok: false, error: err.message || String(err) };
    }
  }

  return results;
}
