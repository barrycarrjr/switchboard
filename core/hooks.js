import { spawn } from 'node:child_process';

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
 * Pure evaluation of quota snapshots against thresholds.
 *
 * Takes registered accounts, quota snapshots, configured thresholds, and
 * previous notification memory. For each window crossing its threshold, emits a
 * threshold event once per turnover period (or until usage drops back below).
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
  const nextMemory = { ...memory };

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

      if (used >= threshold) {
        const prev = nextMemory[memKey];
        let alreadyNotified = false;

        if (prev) {
          // If the reset timestamp is identical, we already alerted for this cycle.
          if (w.resetsAt != null && prev.resetsAt != null && prev.resetsAt === w.resetsAt) {
            alreadyNotified = true;
          } else if (w.resetsAt == null) {
            // Fallback when vendor does not state reset time: silence repeat alerts
            // inside the window duration (5 hours for session, 7 days for week).
            const duration = w.key === 'session' ? 5 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000;
            if (now - prev.notifiedAt < duration) {
              alreadyNotified = true;
            }
          }
        }

        if (!alreadyNotified) {
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
      } else {
        // Usage is below threshold (e.g. after a reset or drop): clear memory
        // so the next climb over threshold triggers a fresh notification.
        if (nextMemory[memKey]) {
          delete nextMemory[memKey];
        }
      }
    }
  }

  return { events, memory: nextMemory };
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
