import { readSharedStatus, writeSharedStatus } from './status-cache.js';

/**
 * The vendor statuspage.io feeds Switchboard can read directly, and which of each
 * page's components actually describe the tool Switchboard runs. A statuspage.io
 * component list mixes in things Switchboard has no opinion on (claude.ai's web chat,
 * GitHub billing pages, Cursor's IDE), so matching is a short include-list of
 * lower-cased substrings against the current, observed component names rather than
 * "whatever the vendor happens to be tracking today". If a vendor renames a component
 * this stops matching it and the card quietly falls back to the page-level indicator
 * instead of misreporting, so it is safe to be specific here.
 */
export const LIVE_SOURCES = {
  claude: {
    summaryUrl: 'https://status.claude.com/api/v2/summary.json',
    pageUrl: 'https://status.claude.com',
    includes: ['claude api', 'claude code'],
  },
  codex: {
    summaryUrl: 'https://status.openai.com/api/v2/summary.json',
    pageUrl: 'https://status.openai.com',
    includes: ['codex api', 'vs code extension'],
  },
  copilot: {
    summaryUrl: 'https://www.githubstatus.com/api/v2/summary.json',
    pageUrl: 'https://www.githubstatus.com',
    includes: ['copilot'],
  },
  cursor: {
    summaryUrl: 'https://status.cursor.com/api/v2/summary.json',
    pageUrl: 'https://status.cursor.com',
    includes: ['cli'],
  },
  grok: {
    summaryUrl: 'https://status.x.ai/api/v2/summary.json',
    pageUrl: 'https://status.x.ai',
    includes: ['api'],
  },
};

/**
 * The other eight tools in core/providers.js are not skipped, they are answered
 * honestly instead of guessed at. Each one is a real reason found by hand (see the
 * conversation that added this file), not a placeholder:
 *  - limited: the vendor has a status page, but it does not speak to this product
 *    specifically (Gemini and Antigravity share Google's general Cloud dashboard;
 *    JetBrains does not break Junie out from the rest of its services; Amp has its
 *    own page but Switchboard has not confirmed its data shape yet).
 *  - no-feed: the vendor publishes nothing public to check (Qwen / Alibaba).
 *  - not-applicable: the tool is not a hosted service of its own. Aider and OpenCode
 *    run against whichever model API you point them at, so their real health is
 *    whichever provider's card that is.
 *  - local: the tool runs on this machine with no vendor backend. Ollama already has
 *    a reachability check in core/doctor.js; this card points at that instead of
 *    inventing a second, redundant one.
 */
export const STATIC_SOURCES = {
  gemini: { tier: 'limited', pageUrl: 'https://status.cloud.google.com', summary: "Google does not publish one combined status feed for the Gemini API. The closest official signal is Google Cloud's general dashboard, which is not specific to this product." },
  junie: { tier: 'limited', pageUrl: 'https://status.jetbrains.com', summary: 'JetBrains has a status page, but it does not break out Junie or AI Assistant as their own component.' },
  qwen: { tier: 'no-feed', pageUrl: 'https://www.alibabacloud.com/status', summary: 'Alibaba does not publish a public status feed for Qwen, so this cannot be checked automatically.' },
  amp: { tier: 'limited', pageUrl: 'https://ampcodestatus.com', summary: 'Amp publishes its own status page, but Switchboard has not confirmed its data format yet.' },
  opencode: { tier: 'not-applicable', pageUrl: null, summary: "OpenCode is not a hosted service on its own. It runs against whichever model provider you connect it to, so its real health is that provider's card." },
  aider: { tier: 'not-applicable', pageUrl: null, summary: "Aider is not a hosted service either. It runs against whichever model API key you give it, so check that provider's card instead." },
  antigravity: { tier: 'limited', pageUrl: 'https://status.cloud.google.com', summary: 'Google has not published a dedicated status page for Antigravity yet. The closest official signal is the same Google Cloud dashboard shown for Gemini.' },
  ollama: { tier: 'local', pageUrl: null, summary: 'Ollama runs on this machine, so there is no vendor status page to check. See the Ollama check below instead.' },
};

const COMPONENT_LEVEL = {
  operational: 'ok',
  degraded_performance: 'warn',
  partial_outage: 'bad',
  major_outage: 'bad',
  under_maintenance: 'info',
};

const INDICATOR_LEVEL = { none: 'ok', minor: 'warn', major: 'bad', critical: 'bad' };

const RANK = { ok: 0, info: 0, warn: 1, bad: 2 };

/** Statuspage's snake_case component status, in Switchboard's own ok/warn/bad/info words. */
export function componentLevel(status) {
  return COMPONENT_LEVEL[status] ?? 'info';
}

/** "degraded_performance" -> "Degraded performance", for display. */
export function humanStatus(status) {
  const s = String(status ?? '').replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : 'Unknown';
}

/** The worst of several ok/warn/bad/info levels. Ties toward ok, since info never outranks it. */
export function worstLevel(levels) {
  return levels.reduce((worst, lvl) => (RANK[lvl] > RANK[worst] ? lvl : worst), 'ok');
}

/**
 * Turn one statuspage.io `/api/v2/summary.json` body into the facts Switchboard's card
 * needs. Pure and synchronous so tests can hand it canned JSON without mocking fetch.
 * A page whose components have all been renamed still returns something useful: the
 * page's own overall word for how it is doing, rather than an empty card.
 */
export function classifyLiveResponse(data, source) {
  const allComponents = Array.isArray(data?.components) ? data.components : [];
  const matched = allComponents.filter((c) => {
    const name = String(c?.name ?? '').toLowerCase();
    return source.includes.some((needle) => name.includes(needle));
  });
  const components = matched.map((c) => ({ name: c.name, level: componentLevel(c.status), status: humanStatus(c.status) }));
  const level = components.length
    ? worstLevel(components.map((c) => c.level))
    : (INDICATOR_LEVEL[data?.status?.indicator] ?? 'info');
  return { level, components, summary: data?.status?.description || null };
}

async function fetchLiveStatus(source, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetchImpl(source.summaryUrl, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return { tier: 'live', ...classifyLiveResponse(data, source), pageUrl: source.pageUrl, error: null };
  } catch (e) {
    // Unreachable is not evidence of an outage, just of not having checked. The card
    // says so plainly rather than guessing at a color it cannot back up.
    return { tier: 'live', level: 'info', components: [], summary: 'Could not reach the status page to check right now.', pageUrl: source.pageUrl, error: e.name === 'AbortError' ? 'timeout' : 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Every tool in core/providers.js, keyed by id: a live reading for the five vendors
 * with a clean public feed (through the shared disk cache, so the tray, the CLI, and
 * every open Switchboard window share one set of requests), and the honest static
 * entry for the other eight. `force` skips the cache for the "Check now" button.
 */
export async function fetchAllProviderStatus({ fetchImpl = fetch, now = Date.now(), file = undefined, force = false, timeoutMs = 8000 } = {}) {
  const out = {};
  await Promise.all(Object.entries(LIVE_SOURCES).map(async ([id, source]) => {
    const cached = !force && readSharedStatus(id, now, file);
    if (cached) {
      out[id] = cached;
      return;
    }
    const result = await fetchLiveStatus(source, fetchImpl, timeoutMs);
    if (!result.error) writeSharedStatus(id, result, now, file);
    out[id] = { ...result, checkedAt: result.error ? null : now };
  }));
  for (const [id, def] of Object.entries(STATIC_SOURCES)) {
    out[id] = { tier: def.tier, level: 'info', components: [], summary: def.summary, pageUrl: def.pageUrl, error: null, checkedAt: null };
  }
  return out;
}
