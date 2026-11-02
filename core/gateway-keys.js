import crypto from 'node:crypto';
import os from 'node:os';

export const GATEWAY_SCOPES = ['localhost', 'localhost-wsl', 'lan'];
export const DEFAULT_GATEWAY_PORT = 8318;
export const DEFAULT_GATEWAY_SCOPE = 'localhost-wsl';

export const GATEWAY_SCOPE_LABELS = {
  'localhost': 'Localhost only (127.0.0.1)',
  'localhost-wsl': 'Localhost + WSL (127.0.0.1 + 172.16.0.0/12)',
  'lan': 'Localhost + WSL + LAN (10.x / 192.168.x / 100.64.x)',
};

const KEY_PREFIX = 'sb-key-';

export function normalizeGatewayScope(scope) {
  const clean = String(scope ?? '').trim().toLowerCase();
  if (GATEWAY_SCOPES.includes(clean)) return clean;
  throw new Error(`invalid gateway scope "${scope}". Expected one of: ${GATEWAY_SCOPES.join(', ')}`);
}

export function normalizeGatewayPort(port) {
  const n = Math.floor(Number(port));
  if (!Number.isFinite(n) || (n !== 0 && (n < 1024 || n > 65535))) {
    throw new Error('gateway port must be an integer between 1024 and 65535');
  }
  return n;
}

export function normalizeGatewaySettings(raw = {}) {
  const enabled = Boolean(raw?.enabled);
  let port = DEFAULT_GATEWAY_PORT;
  try {
    port = normalizeGatewayPort(raw?.port ?? DEFAULT_GATEWAY_PORT);
  } catch {
    port = DEFAULT_GATEWAY_PORT;
  }
  let scope = DEFAULT_GATEWAY_SCOPE;
  try {
    scope = normalizeGatewayScope(raw?.scope ?? DEFAULT_GATEWAY_SCOPE);
  } catch {
    scope = DEFAULT_GATEWAY_SCOPE;
  }
  return { enabled, port, scope };
}

/**
 * Parse an IPv4 dotted-quad into an unsigned 32-bit integer, or null if not valid IPv4.
 */
export function parseIpv4(ip) {
  const clean = String(ip ?? '').trim();
  const parts = clean.split('.');
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n < 0 || n > 255) return null;
    acc = ((acc << 8) | n) >>> 0;
  }
  return acc;
}

function inCidr4(ipInt, baseStr, prefixBits) {
  const baseInt = parseIpv4(baseStr);
  if (baseInt == null || ipInt == null) return false;
  const mask = prefixBits === 0 ? 0 : (~0 << (32 - prefixBits)) >>> 0;
  return (ipInt & mask) >>> 0 === (baseInt & mask) >>> 0;
}

/**
 * Strip IPv4-mapped IPv6 prefix (::ffff:127.0.0.1 -> 127.0.0.1) and zone index (%eth0).
 */
export function normalizeRemoteAddress(remoteAddress) {
  let raw = String(remoteAddress ?? '').trim().toLowerCase();
  if (!raw) return '';
  const zoneIdx = raw.indexOf('%');
  if (zoneIdx !== -1) raw = raw.slice(0, zoneIdx);
  if (raw.startsWith('::ffff:')) {
    const tail = raw.slice(7);
    if (parseIpv4(tail) != null) return tail;
  }
  return raw;
}

/**
 * Classify a socket remote address into 'localhost', 'wsl', 'lan', or null (public/untrusted).
 * Only the real TCP socket address is ever passed here; X-Forwarded-For is never consulted.
 */
export function classifyRemoteAddress(remoteAddress) {
  const norm = normalizeRemoteAddress(remoteAddress);
  if (!norm) return null;
  if (norm === '::1' || norm === '0:0:0:0:0:0:0:1') return 'localhost';

  const ip4 = parseIpv4(norm);
  if (ip4 != null) {
    if (inCidr4(ip4, '127.0.0.0', 8)) return 'localhost';
    if (inCidr4(ip4, '172.16.0.0', 12)) return 'wsl';
    if (
      inCidr4(ip4, '10.0.0.0', 8)
      || inCidr4(ip4, '192.168.0.0', 16)
      || inCidr4(ip4, '100.64.0.0', 10)
    ) {
      return 'lan';
    }
    return null;
  }

  // IPv6 ULA (fc00::/7) and link-local (fe80::/10) count as LAN.
  if (/^(fc|fd)[0-9a-f]{2}:/.test(norm) || /^fe[89ab][0-9a-f]:/.test(norm)) {
    return 'lan';
  }
  return null;
}

/**
 * Whether a socket remote address is permitted by a scope ('localhost' | 'localhost-wsl' | 'lan').
 */
export function ipAllowedByScope(remoteAddress, scope) {
  const kind = classifyRemoteAddress(remoteAddress);
  if (!kind) return false;
  if (scope === 'localhost') return kind === 'localhost';
  if (scope === 'localhost-wsl') return kind === 'localhost' || kind === 'wsl';
  if (scope === 'lan') return kind === 'localhost' || kind === 'wsl' || kind === 'lan';
  return false;
}

/**
 * Pick the most helpful host IP to show in the UI and copy-paste snippets for the selected scope.
 */
export function detectGatewayHostIp(scope = DEFAULT_GATEWAY_SCOPE, interfaces = os.networkInterfaces()) {
  if (scope === 'localhost') return '127.0.0.1';
  const entries = Object.entries(interfaces ?? {});
  const ipv4s = [];
  for (const [name, list] of entries) {
    for (const addr of list ?? []) {
      const fam = addr?.family === 4 || addr?.family === 'IPv4';
      if (!fam || addr.internal) continue;
      const ip = String(addr.address ?? '').trim();
      const kind = classifyRemoteAddress(ip);
      if (kind) ipv4s.push({ name, ip, kind });
    }
  }
  if (scope === 'localhost-wsl') {
    const wslFace = ipv4s.find((e) => e.kind === 'wsl' && /wsl/i.test(e.name))
      ?? ipv4s.find((e) => e.kind === 'wsl' && /vethernet/i.test(e.name))
      ?? ipv4s.find((e) => e.kind === 'wsl');
    return wslFace ? wslFace.ip : '127.0.0.1';
  }
  if (scope === 'lan') {
    const lanFace = ipv4s.find((e) => e.kind === 'lan' && !/wsl|vethernet|docker/i.test(e.name))
      ?? ipv4s.find((e) => e.kind === 'lan')
      ?? ipv4s.find((e) => e.kind === 'wsl');
    return lanFace ? lanFace.ip : '127.0.0.1';
  }
  return '127.0.0.1';
}

export function maskGatewayToken(token) {
  const clean = String(token ?? '').trim();
  if (clean.length <= 16) return KEY_PREFIX + '****';
  return `${clean.slice(0, 11)}...${clean.slice(-4)}`;
}

export function generateGatewayToken() {
  return KEY_PREFIX + crypto.randomBytes(20).toString('hex');
}

function slugLabel(label) {
  const base = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return base || 'client';
}

function todayStamp(now = Date.now()) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Pure key creation: returns { settings, key, secret }.
 * `secret` is the full sb-key-... value, returned once at creation time so the caller can copy it.
 */
export function createGatewayKey(settings, { label, scope = DEFAULT_GATEWAY_SCOPE, now = Date.now() } = {}) {
  const cleanLabel = String(label ?? '').trim();
  if (!cleanLabel) throw new Error('a label for the client key is required');
  if (cleanLabel.length > 80) throw new Error('key label must be 80 characters or fewer');
  const cleanScope = normalizeGatewayScope(scope);

  const existing = { ...(settings?.gatewayKeys ?? {}) };
  const baseId = slugLabel(cleanLabel);
  let id = baseId;
  let n = 2;
  while (existing[id]) {
    id = `${baseId}-${n}`;
    n += 1;
  }

  const secret = generateGatewayToken();
  const hint = maskGatewayToken(secret);
  const entry = {
    id,
    label: cleanLabel,
    token: secret,
    hint,
    scope: cleanScope,
    createdAt: now,
    lastUsedAt: null,
    lastAccountId: null,
    lastLaneId: null,
    requestsToday: 0,
    dayStamp: todayStamp(now),
  };

  existing[id] = entry;
  const nextSettings = { ...settings, gatewayKeys: existing };
  return {
    settings: nextSettings,
    key: publicGatewayKey(entry, now),
    secret,
  };
}

/**
 * Pure key revocation: removes the key entry by id.
 */
export function revokeGatewayKey(settings, keyId) {
  const existing = { ...(settings?.gatewayKeys ?? {}) };
  if (!existing[keyId]) throw new Error(`no gateway key with id "${keyId}"`);
  delete existing[keyId];
  return { ...settings, gatewayKeys: existing };
}

/**
 * Strip the raw token before returning key metadata to UI, IPC, or CLI list output.
 */
export function publicGatewayKey(entry, now = Date.now()) {
  if (!entry || typeof entry !== 'object') return null;
  const currentDay = todayStamp(now);
  const requestsToday = entry.dayStamp === currentDay ? (Number(entry.requestsToday) || 0) : 0;
  return {
    id: entry.id,
    label: entry.label,
    hint: entry.hint || (typeof entry.token === 'string' ? maskGatewayToken(entry.token) : KEY_PREFIX + '****'),
    scope: GATEWAY_SCOPES.includes(entry.scope) ? entry.scope : DEFAULT_GATEWAY_SCOPE,
    createdAt: entry.createdAt ?? null,
    lastUsedAt: entry.lastUsedAt ?? null,
    lastAccountId: entry.lastAccountId ?? null,
    lastLaneId: entry.lastLaneId ?? null,
    requestsToday,
    unreadable: Boolean(entry.unreadable),
  };
}

export function listGatewayKeys(settings, now = Date.now()) {
  const map = settings?.gatewayKeys ?? {};
  return Object.values(map)
    .filter((e) => e && typeof e === 'object' && typeof e.id === 'string')
    .map((e) => publicGatewayKey(e, now))
    .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

function timingSafeStringMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validate a presented bearer/x-api-key token and the caller's socket IP against both
 * the Gateway listener scope and the individual key's scope.
 */
export function verifyGatewayKey(settings, presentedToken, remoteAddress) {
  const gw = normalizeGatewaySettings(settings?.gateway);
  if (!ipAllowedByScope(remoteAddress, gw.scope)) {
    return {
      ok: false,
      status: 403,
      reason: 'ip-outside-gateway-scope',
      message: `Caller address ${normalizeRemoteAddress(remoteAddress) || 'unknown'} is outside the gateway listener scope (${gw.scope}).`,
    };
  }

  const rawToken = String(presentedToken ?? '').trim();
  if (!rawToken) {
    return {
      ok: false,
      status: 401,
      reason: 'missing-key',
      message: 'Missing Switchboard client key. Pass an sb-key-... token in Authorization: Bearer or x-api-key.',
    };
  }

  let matched = null;
  for (const entry of Object.values(settings?.gatewayKeys ?? {})) {
    if (!entry || typeof entry.token !== 'string' || entry.unreadable) continue;
    if (timingSafeStringMatch(rawToken, entry.token)) {
      matched = entry;
    }
  }

  if (!matched) {
    return {
      ok: false,
      status: 401,
      reason: 'invalid-key',
      message: 'Invalid or revoked Switchboard client key.',
    };
  }

  const keyScope = GATEWAY_SCOPES.includes(matched.scope) ? matched.scope : DEFAULT_GATEWAY_SCOPE;
  if (!ipAllowedByScope(remoteAddress, keyScope)) {
    return {
      ok: false,
      status: 403,
      reason: 'ip-outside-key-scope',
      keyId: matched.id,
      keyLabel: matched.label,
      message: `Client key "${matched.label}" is scoped to ${keyScope} and cannot be used from ${normalizeRemoteAddress(remoteAddress) || 'unknown'}.`,
    };
  }

  return {
    ok: true,
    key: publicGatewayKey(matched),
  };
}

/**
 * Record a successful or attempted request on a client key.
 */
export function recordGatewayKeyUse(settings, keyId, { accountId = null, laneId = null, now = Date.now() } = {}) {
  const existing = { ...(settings?.gatewayKeys ?? {}) };
  const entry = existing[keyId];
  if (!entry) return settings;
  const day = todayStamp(now);
  const prevCount = entry.dayStamp === day ? (Number(entry.requestsToday) || 0) : 0;
  existing[keyId] = {
    ...entry,
    lastUsedAt: now,
    lastAccountId: accountId ?? entry.lastAccountId ?? null,
    lastLaneId: laneId ?? entry.lastLaneId ?? null,
    requestsToday: prevCount + 1,
    dayStamp: day,
  };
  return { ...settings, gatewayKeys: existing };
}

/**
 * The label `gateway provision-client` gives the key it creates when the machine has none.
 */
export const DEFAULT_PROVISION_LABEL = 'lease clients';

/**
 * The gateway turned on for provisioning, with an existing scope and port left exactly as
 * they were. A gateway nobody configured gets the defaults (scope localhost-wsl); one that
 * was configured keeps its scope in either direction, because a script must never widen
 * or narrow a scope a person chose (decision of 2026-11-01: a broker on `lan` stays `lan`).
 */
export function gatewayEnabledSettings(settings = {}) {
  const gw = normalizeGatewaySettings(settings?.gateway);
  return {
    settings: { ...settings, gateway: { ...gw, enabled: true } },
    wasEnabled: gw.enabled,
    fresh: settings?.gateway == null,
    scope: gw.scope,
    port: gw.port,
  };
}

/**
 * The key `gateway provision-client` installs here and in every WSL distro: a stored,
 * readable key when there is one, else a new one. Either way the key carries the
 * GATEWAY's scope. verifyGatewayKey checks a key against its own scope, so a
 * `localhost-wsl` key on a `lan` gateway answers 403 `ip-outside-key-scope` to every
 * caller on the LAN (found on a live machine on 2026-11-01). Preference among stored keys:
 * the one whose label matches `label`, then one already on the gateway's scope, then the
 * first readable one; a key this machine cannot decrypt is never picked. Pure: the caller
 * saves the returned settings. `secret` is the token to install, never to print.
 */
export function chooseProvisionKey(settings = {}, { label = '', scope = null, now = Date.now() } = {}) {
  const gwScope = normalizeGatewayScope(scope ?? normalizeGatewaySettings(settings?.gateway).scope);
  const readable = Object.values(settings?.gatewayKeys ?? {})
    .filter((e) => e && typeof e.token === 'string' && e.token.length > 0 && !e.unreadable);
  const wanted = String(label ?? '').trim().toLowerCase();
  const picked = (wanted ? readable.find((e) => String(e.label ?? '').trim().toLowerCase() === wanted) : null)
    ?? readable.find((e) => e.scope === gwScope)
    ?? readable[0]
    ?? null;
  if (!picked) {
    const made = createGatewayKey(settings, { label: String(label ?? '').trim() || DEFAULT_PROVISION_LABEL, scope: gwScope, now });
    return { settings: made.settings, key: made.key, secret: made.secret, created: true, scopeChanged: false, previousScope: null };
  }
  const scopeChanged = picked.scope !== gwScope;
  const entry = scopeChanged ? { ...picked, scope: gwScope } : picked;
  const next = scopeChanged
    ? { ...settings, gatewayKeys: { ...(settings?.gatewayKeys ?? {}), [picked.id]: entry } }
    : settings;
  return {
    settings: next,
    key: publicGatewayKey(entry, now),
    secret: entry.token,
    created: false,
    scopeChanged,
    previousScope: scopeChanged ? picked.scope : null,
  };
}
