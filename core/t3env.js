import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { laneTokenState, laneTokenIdentityMatches } from './lane-tokens.js';
import { readClaudeAccountIdentity } from './quota.js';
import { normalizeColor } from './accounts.js';
import { createGatewayKey, normalizeGatewaySettings, publicGatewayKey } from './gateway-keys.js';

/**
 * Pointing a T3 Code environment at Switchboard's Claude accounts.
 *
 * A T3 environment (a WSL distro, or another machine reached over ssh) runs the vendor CLIs on
 * that machine, so on its own it only sees that machine's sign-ins. Switchboard's lease broker
 * lends each Claude account's long-lived setup token for one run at a time, so the environment
 * needs no sign-in of its own: T3 runs a three-line wrapper per account instead of `claude`,
 * the wrapper asks the broker for that account, and `switchboard-lease` runs the real claude
 * with it. This module plans and applies that: the client key and broker address, the lease
 * wrapper, one wrapper per account, one T3 provider entry per account, and T3's quota hub entry.
 *
 * Everything that runs on the target is a bash script sent on stdin (never a command line), so
 * the key never shows in a process list on either side. Nothing here removes or disables a T3
 * entry it did not create; an entry it finds pointing at the machine's own sign-in is reported.
 */

const WRAPPER_PREFIX = 't3-claude-';
const ID_CHARS = /^[A-Za-z0-9._-]+$/;
const TARGET_NAME = /^[A-Za-z0-9._@-]+$/;
const MASKED_SECRET = '••••••';
export const ANY_ACCOUNT_INSTANCE_ID = 'claudeAgent_sb_any';
export const PROOF_PROMPT = 'Reply with exactly: ok';

/**
 * `wsl:<distro>` or `ssh:<host>`; a bare name is a WSL distro when one by that name exists,
 * otherwise an ssh host (an alias from ~/.ssh/config works). The name is checked against a
 * strict character set because it ends up in a spawn argument list.
 */
export function parseT3Target(spec, wslDistros = []) {
  const raw = String(spec ?? '').trim();
  const m = /^(wsl|ssh):(.+)$/i.exec(raw);
  let kind;
  let name;
  if (m) {
    kind = m[1].toLowerCase();
    name = m[2].trim();
    // WSL distro names are not case-sensitive to wsl.exe, so wsl:ubuntu and wsl:Ubuntu are one
    // environment; the name as WSL lists it is the one remembered.
    if (kind === 'wsl') name = wslDistros.find((d) => d.toLowerCase() === name.toLowerCase()) ?? name;
  } else {
    const distro = wslDistros.find((d) => d.toLowerCase() === raw.toLowerCase());
    kind = distro ? 'wsl' : 'ssh';
    name = distro ?? raw;
  }
  if (!name || !TARGET_NAME.test(name) || name.startsWith('-')) {
    throw new Error(`"${raw}" is not a usable environment name (letters, digits, . _ @ - only)`);
  }
  return { id: `${kind}:${name}`, kind, name };
}

/**
 * Whether the broker would lend this lane, by the broker's own rule when the caller passes it
 * (`canLend`, which core/t3env-run.js wires to inspectLaneLeaseCredential: a live token whose
 * identity still matches the folder, or a metered lane with its API key). Without it, a live
 * token whose stamped identity matches the folder's sign-in.
 */
function defaultCanLend(lane, account, settings) {
  if (laneTokenState(settings, lane.id) !== 'live') return false;
  return laneTokenIdentityMatches(settings?.laneTokens?.[lane.id], readClaudeAccountIdentity(account.home));
}

/**
 * The Claude accounts the broker can lend. The others come back in `skipped` with the reason,
 * so the caller can say what to do instead of silently leaving an account out.
 */
export function lendableClaudeAccounts(registry, settings, { canLend = null } = {}) {
  const lends = canLend ?? ((lane, account) => defaultCanLend(lane, account, settings));
  const lendable = [];
  const skipped = [];
  for (const account of registry?.accounts ?? []) {
    if (account?.provider !== 'claude') continue;
    if (!ID_CHARS.test(String(account.id ?? ''))) {
      skipped.push({ id: account.id, label: account.label, reason: 'its id has characters a wrapper name cannot carry' });
      continue;
    }
    const lanes = (settings?.lanes ?? []).filter((l) => l?.accountId === account.id && l?.harness === 'claude');
    if (!lanes.length) {
      skipped.push({ id: account.id, label: account.label, reason: 'no lane, so the broker cannot lend it (switchboard gateway provision-client offers to add one)' });
      continue;
    }
    const live = lanes.find((l) => lends(l, account));
    if (!live) {
      const state = laneTokenState(settings, lanes[0].id);
      const reason = state === 'live'
        ? `its lane token was minted for a different sign-in than the folder now has (mint a new one with: switchboard lane-token ${lanes[0].id})`
        : `its lane token is ${state} (mint one with: switchboard lane-token --missing)`;
      skipped.push({ id: account.id, label: account.label, reason });
      continue;
    }
    let color = null;
    try { color = normalizeColor(account.color) || null; } catch { color = null; }
    lendable.push({ id: account.id, label: String(account.label ?? account.id), color, laneId: live.id });
  }
  return { lendable, skipped };
}

/** The wrapper file name for an account: `t3-claude-default` for `claude-default`. */
export function accountWrapperName(accountId) {
  const id = String(accountId ?? '');
  if (!ID_CHARS.test(id)) throw new Error(`"${id}" is not an account id`);
  return WRAPPER_PREFIX + (id.startsWith('claude-') && id.length > 'claude-'.length ? id.slice('claude-'.length) : id);
}

/** The per-account wrapper T3 runs instead of claude. */
export function accountWrapperScript(account) {
  if (!ID_CHARS.test(String(account?.id ?? ''))) throw new Error('an account id is required');
  const label = String(account.label ?? account.id).replace(/[^\x20-\x7e]/g, '?');
  return [
    '#!/usr/bin/env bash',
    `# Written by Switchboard (switchboard t3 setup). T3 Code runs this instead of claude: it borrows`,
    `# the ${label} account from Switchboard's lease broker. Running the setup again rewrites it.`,
    `export SWITCHBOARD_ACCOUNT=${account.id}`,
    'exec "$HOME/.local/bin/switchboard-lease" "$@"',
    '',
  ].join('\n');
}

/** The account a wrapper's text names, or null. Reads hand-written wrappers too. */
export function wrapperAccountId(text) {
  const m = /^\s*(?:export\s+)?SWITCHBOARD_ACCOUNT=["']?([A-Za-z0-9._-]+)["']?\s*$/m.exec(String(text ?? ''));
  return m ? m[1] : null;
}

/**
 * The id T3 gives a quota hub entry for `url`: the entry already holding that url, else
 * `cliproxy-<host>` made safe, with a counter when taken. Copied from T3 Code's own settings
 * page so an entry written here is the one T3 would have written.
 */
export function t3HubSourceId(url, existing = {}) {
  const found = Object.entries(existing ?? {}).find(([, s]) => s?.url === url);
  if (found) return found[0];
  let host = url;
  try { host = new URL(url).host; } catch { /* keep the raw text */ }
  const base = `cliproxy-${host.toLowerCase().replace(/[^a-z0-9.-]+/g, '-').replace(/^-+|-+$/g, '') || 'hub'}`;
  let id = base;
  for (let n = 2; id in (existing ?? {}); n += 1) id = `${base}-${n}`;
  return id;
}

/** Where T3 keeps a hub's management key: one file per source, named by base64url of its id. */
export function t3HubSecretFileName(sourceId) {
  return `usage-limit-source-${Buffer.from(String(sourceId), 'utf8').toString('base64url')}.bin`;
}

function slug(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'account';
}

function basename(p) {
  return String(p ?? '').split('/').filter(Boolean).pop() ?? '';
}

/**
 * The target's T3 settings with one provider per lendable account, an "any account" provider,
 * and the quota hub, plus a list of what changed and what was left alone.
 *
 * - `wrappers` maps each `t3-claude-*` file already on the target to the account it names, so
 *   an entry made by hand earlier is adopted (its id, name, color and config folder kept)
 *   instead of being duplicated. Keeping the id matters: T3 binds each conversation to a
 *   provider id, and a new id would orphan every conversation on the old one.
 * - An entry pointing at `switchboard-lease` itself is the "any account" entry.
 * - A new entry leaves T3's config-folder field empty, so claude there uses the same settings,
 *   MCP servers and trusted folders as the plain `claude` command (a filled-in field makes T3
 *   set CLAUDE_CONFIG_DIR, which moves Claude's own config file). The account comes from the
 *   lent token either way.
 * - The quota hub entry Switchboard added before is moved to the new address when the broker's
 *   address changed, rather than a second one being added beside a dead one.
 * - Nothing is removed or disabled. A Claude entry that is not Switchboard's is reported.
 * Pure: returns the new settings object and never mutates `current`.
 */
export function mergeT3EnvironmentSettings(current, { home, accounts, wrappers = {}, hubUrl = null } = {}) {
  if (!home || !String(home).startsWith('/')) throw new Error('the target home folder is required');
  const bin = `${home}/.local/bin`;
  const settings = current && typeof current === 'object' ? structuredClone(current) : {};
  const instances = settings.providerInstances && typeof settings.providerInstances === 'object'
    ? settings.providerInstances
    : {};
  settings.providerInstances = instances;
  const changes = [];
  const leftovers = [];
  const wrapperFiles = {}; // accountId -> wrapper file name to write
  const adoptedFiles = new Set(); // wrapper files that existed before and are rewritten

  const accountOf = (instance) => {
    const file = basename(instance?.config?.binaryPath);
    if (file === 'switchboard-lease') return '*';
    if (!file.startsWith(WRAPPER_PREFIX)) return null;
    if (wrappers[file]) return wrappers[file];
    const byName = accounts.find((a) => accountWrapperName(a.id) === file);
    return byName ? byName.id : null;
  };
  // T3 refuses a whole settings file holding a provider id over 64 characters.
  const newId = (base) => {
    const head = base.slice(0, 58);
    let id = head;
    for (let n = 2; id in instances; n += 1) id = `${head}_${n}`;
    return id;
  };

  const claimed = new Set();
  for (const account of accounts) {
    const adoptedId = Object.keys(instances).find((id) => !claimed.has(id)
      && instances[id]?.driver === 'claudeAgent' && accountOf(instances[id]) === account.id);
    if (adoptedId) {
      claimed.add(adoptedId);
      const inst = instances[adoptedId];
      const file = basename(inst.config.binaryPath);
      // A wrapper file name the scripts would refuse is not reused; the account gets the usual one.
      const usable = /^t3-claude-[A-Za-z0-9._-]+$/.test(file) ? file : accountWrapperName(account.id);
      wrapperFiles[account.id] = usable;
      if (usable === file && file in wrappers) adoptedFiles.add(file);
      const next = {
        ...inst,
        displayName: inst.displayName || `Claude - ${account.label} (Switchboard)`,
        ...(inst.accentColor || !account.color ? {} : { accentColor: account.color }),
        config: { ...inst.config, binaryPath: `${bin}/${usable}` },
      };
      if (JSON.stringify(next) !== JSON.stringify(inst)) {
        instances[adoptedId] = next;
        changes.push(`updated ${adoptedId} (${account.label})`);
      }
      continue;
    }
    const file = accountWrapperName(account.id);
    wrapperFiles[account.id] = file;
    if (file in wrappers) adoptedFiles.add(file);
    const id = newId(`claudeAgent_sb_${slug(account.id.replace(/^claude-/, ''))}`);
    claimed.add(id);
    instances[id] = {
      driver: 'claudeAgent',
      displayName: `Claude - ${account.label} (Switchboard)`,
      ...(account.color ? { accentColor: account.color } : {}),
      enabled: true,
      config: { binaryPath: `${bin}/${file}`, homePath: '', customModels: [], launchArgs: '' },
    };
    changes.push(`added ${id} (${account.label})`);
  }

  const anyId = Object.keys(instances).find((id) => instances[id]?.driver === 'claudeAgent' && accountOf(instances[id]) === '*');
  if (!anyId) {
    const id = newId(ANY_ACCOUNT_INSTANCE_ID);
    claimed.add(id);
    instances[id] = {
      driver: 'claudeAgent',
      displayName: 'Claude - any account (Switchboard)',
      enabled: true,
      config: { binaryPath: `${bin}/switchboard-lease`, homePath: '', customModels: [], launchArgs: '' },
    };
    changes.push(`added ${id} (whichever account has the most room)`);
  } else {
    claimed.add(anyId);
  }

  for (const [id, inst] of Object.entries(instances)) {
    if (inst?.driver !== 'claudeAgent' || claimed.has(id)) continue;
    const who = accountOf(inst);
    leftovers.push({
      id,
      displayName: inst.displayName ?? id,
      note: who ? `points at a wrapper for "${who}", an account Switchboard cannot lend right now` : 'uses this machine\'s own Claude sign-in, not Switchboard',
    });
  }

  let hubId = null;
  if (hubUrl) {
    const sources = settings.usageLimitSources && typeof settings.usageLimitSources === 'object' ? settings.usageLimitSources : {};
    settings.usageLimitSources = sources;
    const sameUrl = Object.keys(sources).find((id) => sources[id]?.url === hubUrl);
    const ours = Object.keys(sources).find((id) => sources[id]?.kind === 'cliproxy' && sources[id]?.label === 'Switchboard');
    if (sameUrl) {
      hubId = sameUrl;
    } else if (ours) {
      hubId = ours;
      changes.push(`moved quota hub ${ours} from ${sources[ours].url} to ${hubUrl}`);
      sources[ours] = { ...sources[ours], url: hubUrl };
    } else {
      hubId = t3HubSourceId(hubUrl, sources);
      sources[hubId] = { kind: 'cliproxy', label: 'Switchboard', url: hubUrl, managementKey: MASKED_SECRET, enabled: true };
      changes.push(`added quota hub ${hubId}`);
    }
  }

  return { settings, changes, leftovers, wrapperFiles, adoptedFiles: [...adoptedFiles], hubId };
}

// ---------------------------------------------------------------------------------------------
// Scripts that run on the target. Each prints `@@name=<base64>` lines, which parseMarkedOutput
// reads, so a login banner or a stray line from a profile cannot be mistaken for an answer.
// Every command that could read stdin is given /dev/null: the script itself arrives on stdin.

const B64 = (s) => Buffer.from(String(s ?? ''), 'utf8').toString('base64');
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const SCRIPT_HEAD = [
  'set -u',
  'emit() { printf "@@%s=%s\\n" "$1" "$(printf "%s" "$2" | base64 | tr -d "\\n")"; }',
];

/**
 * Facts about the target that the plan depends on. `brokerUrls` are tried in order with the
 * target's key. `defaultRoutePort` adds the default-route host on that port, which is Windows
 * only from inside WSL; on a LAN machine it is the router, and the key must never go there.
 */
export function inspectScript({ brokerUrls = [], defaultRoutePort = null } = {}) {
  const urls = brokerUrls.map(shq).join(' ');
  const viaRoute = Number.isInteger(defaultRoutePort) ? ` \${gw:+"http://$gw:${defaultRoutePort}"}` : '';
  return [
    ...SCRIPT_HEAD,
    'emit home "$HOME"',
    'c=""; [ -x "$HOME/.local/bin/claude" ] && c="$HOME/.local/bin/claude"',
    'if [ -z "$c" ]; then for x in $(which -a claude 2>/dev/null); do case "$x" in /mnt/*|*/t3-claude-*|*/switchboard-lease) ;; *) c="$x"; break ;; esac; done; fi',
    'emit claude "$c"',
    // Run, not looked up, exactly as the lease wrapper decides (a shim on PATH may not run).
    'if node -e 0 >/dev/null 2>&1; then emit json node; elif python3 -I -c 0 >/dev/null 2>&1; then emit json python3; else emit json none; fi',
    // GNU tools these scripts rely on; a machine without one is refused, not half set up
    // (without sha256sum the settings guard would compare two empty hashes and pass).
    'miss=""; for t in base64 sha256sum mktemp timeout cp; do command -v "$t" >/dev/null 2>&1 || miss="$miss $t"; done; emit missing "$miss"',
    'command -v curl >/dev/null 2>&1 && emit curl yes || emit curl no',
    'p="$HOME/.local/bin/switchboard-lease"',
    'if [ -L "$p" ]; then emit lease "symlink:$(readlink -f "$p")"; elif [ -f "$p" ]; then emit lease "file:$(sha256sum "$p" | cut -d" " -f1)"; else emit lease missing; fi',
    'kf="$HOME/.config/switchboard/client-key"',
    'gw="$(ip route 2>/dev/null | awk \'/default/ {print $3; exit}\')"',
    `if [ -r "$kf" ]; then emit key present; k="$(head -n1 "$kf" | tr -d '\\r')"; else emit key missing; k="sb-key-none"; fi`,
    `for u in ${urls}${viaRoute}; do`,
    // curl reads its config (the key) from the pipe; a </dev/null here would replace the pipe
    // and send no key at all, so every key looked refused (found on the first live run).
    `  code="$(printf 'header = "Authorization: Bearer %s"\\n' "$k" | curl -s -o /dev/null -w '%{http_code}' --max-time 5 -K - "$u/v1/info" 2>/dev/null)"`,
    '  emit "probe" "$u $code"',
    '  case "$code" in 200|401|403) break ;; esac',
    'done',
    'emit brokerfile "$(head -n1 "$HOME/.config/switchboard/broker-url" 2>/dev/null)"',
    's="$HOME/.t3/userdata/settings.json"',
    '[ -d "$HOME/.t3/userdata" ] && emit t3 yes || emit t3 no',
    // The text and its hash come from one copy, so a save by T3 between the two reads cannot
    // pair an old text with a new hash.
    'if [ -f "$s" ]; then st="$(mktemp)"; cp "$s" "$st"; emit settings "$(cat "$st")"; emit settingssha "$(sha256sum "$st" | cut -d" " -f1)"; rm -f "$st"; else emit settingssha none; fi',
    // The wrapper text comes back whole (they are a few lines) and is read here, not with sed.
    'for w in "$HOME"/.local/bin/t3-claude-*; do [ -f "$w" ] || continue; emit wrapper "$(basename "$w")"$\'\\n\'"$(head -c 4096 "$w")"; done',
    'for f in "$HOME"/.t3/userdata/secrets/usage-limit-source-*.bin; do [ -f "$f" ] && emit hubsecret "$(basename "$f")"; done',
    // A codex seen through WSL interop (/mnt/...) is the Windows one, not installed here.
    'cx="$(command -v codex 2>/dev/null)"; case "$cx" in ""|/mnt/*) emit codex not-installed ;; *) if timeout 15 codex login status </dev/null >/dev/null 2>&1; then emit codex signed-in; else emit codex not-signed-in; fi ;; esac',
    'emit done 1',
    '',
  ].join('\n');
}

/** `@@name=<base64>` lines into { name: value } (repeated names into arrays where listed). */
export function parseMarkedOutput(text, repeated = []) {
  const out = {};
  for (const r of repeated) out[r] = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    // Matched at the end of the line, so text a login script printed with no newline before
    // the first mark (a terminal title, say) cannot hide it.
    const m = /@@([A-Za-z0-9_.-]+)=([A-Za-z0-9+/=]*)$/.exec(line.trim());
    if (!m) continue;
    const value = Buffer.from(m[2], 'base64').toString('utf8');
    if (repeated.includes(m[1])) out[m[1]].push(value);
    else out[m[1]] = value;
  }
  return out;
}

/** The inspect output as a plain object the planner reads. */
export function parseInspect(text) {
  const raw = parseMarkedOutput(text, ['probe', 'wrapper', 'hubsecret']);
  if (raw.done !== '1') return null;
  const probes = raw.probe.map((p) => {
    const [url, code] = p.split(' ');
    return { url, code: Number(code) || 0 };
  });
  const answered = probes.find((p) => [200, 401, 403].includes(p.code)) ?? null;
  const wrappers = {};
  const wrapperTexts = {};
  for (const w of raw.wrapper) {
    const nl = w.indexOf('\n');
    const file = (nl >= 0 ? w.slice(0, nl) : w).trim();
    if (!file) continue;
    wrapperTexts[file] = nl >= 0 ? w.slice(nl + 1) : '';
    wrappers[file] = wrapperAccountId(wrapperTexts[file]);
  }
  let settings = null;
  let settingsError = null;
  if (raw.settingssha !== 'none') {
    if (!raw.settingssha) settingsError = 'its hash could not be read';
    else {
      try { settings = JSON.parse(raw.settings ?? ''); } catch (e) { settingsError = String(e.message || e); }
    }
  }
  return {
    home: raw.home,
    claude: raw.claude || null,
    json: raw.json,
    curl: raw.curl === 'yes',
    lease: raw.lease,
    key: raw.key,
    broker: answered,
    probes,
    brokerFile: raw.brokerfile || null,
    t3: raw.t3 === 'yes',
    settings,
    settingsError,
    settingsSha: raw.settingssha,
    wrappers,
    wrapperTexts,
    hubSecrets: raw.hubsecret,
    codex: raw.codex,
    missingTools: String(raw.missing ?? '').trim().split(/\s+/).filter(Boolean),
  };
}

/**
 * The script that writes the plan. Files are written to a temp name and renamed. The T3
 * settings file goes last, after everything its entries point at exists, and only if it still
 * has the content the plan was made from (T3 may have saved it meanwhile); otherwise it prints
 * `@@conflict` and the caller plans again. The old settings file is kept next to it.
 */
export function applyScript({
  key = null,
  brokerUrl = null,
  brokerPort = null,
  leaseScript = null,
  replaceSymlink = false,
  wrappers = [],
  settingsText = null,
  expectSha = null,
  backupSuffix = 'before-switchboard',
  hubSecretFile = null,
} = {}) {
  const lines = [
    ...SCRIPT_HEAD,
    'umask 077',
    'fail() { emit error "$1"; exit 1; }',
    'put() { # put <path> <mode> <base64>',
    '  local d t; d="$(dirname "$1")"; mkdir -p "$d" || fail "cannot create $d"',
    '  t="$(mktemp "$d/.switchboard.XXXXXX")" || fail "cannot write in $d"',
    '  printf "%s" "$3" | base64 -d > "$t" || { rm -f "$t"; fail "cannot write $1"; }',
    '  chmod "$2" "$t" && mv -f "$t" "$1" || { rm -f "$t"; fail "cannot replace $1"; }',
    '}',
    'conf="$HOME/.config/switchboard"; bin="$HOME/.local/bin"',
  ];
  if (key) lines.push(`put "$conf/client-key" 600 ${shq(B64(`${key}\n`))}`, 'emit key written');
  if (brokerUrl) lines.push(`put "$conf/broker-url" 644 ${shq(B64(`${brokerUrl}\n`))}`, 'emit brokerurl written');
  if (brokerPort != null) {
    if (!Number.isInteger(brokerPort)) throw new Error('the broker port must be a number');
    lines.push(`put "$conf/broker-port" 644 ${shq(B64(`${brokerPort}\n`))}`, 'emit brokerport written');
  }
  if (leaseScript) {
    lines.push(
      'p="$bin/switchboard-lease"',
      `if [ -L "$p" ] && [ ${replaceSymlink ? 1 : 0} = 0 ]; then emit lease "symlink-kept $(readlink -f "$p")";`,
      `else [ -L "$p" ] && rm -f "$p"; put "$p" 755 ${shq(B64(leaseScript))}; emit lease written; fi`,
    );
  }
  for (const w of wrappers) {
    if (!/^t3-claude-[A-Za-z0-9._-]+$/.test(w.file)) throw new Error(`unexpected wrapper name ${w.file}`);
    // A wrapper someone wrote by hand may carry more than the account (flags, CLAUDE_BIN), so a
    // copy is kept next to it before it is replaced.
    if (w.backup) lines.push(`[ -f "$bin/${w.file}" ] && cp -p "$bin/${w.file}" "$bin/${w.file}.${backupSuffix}" && emit wrapperbackup ${shq(`${w.file}.${backupSuffix}`)}`);
    lines.push(`put "$bin/${w.file}" 755 ${shq(B64(w.text))}`, `emit wrapper ${shq(w.file)}`);
  }
  if (hubSecretFile) {
    if (!/^usage-limit-source-[A-Za-z0-9_-]+\.bin$/.test(hubSecretFile)) throw new Error('unexpected hub secret file name');
    lines.push(
      'sd="$HOME/.t3/userdata/secrets"; hf="$sd/' + hubSecretFile + '"',
      // The hub key follows the client key on the machine: a key that was since replaced or
      // revoked would leave T3's quota view refused with no sign of why (found on a live run).
      'if [ -r "$conf/client-key" ]; then',
      '  want="$(head -n1 "$conf/client-key" | tr -d "\\r\\n")"; have=""; [ -f "$hf" ] && have="$(cat "$hf")"',
      '  if [ "$want" = "$have" ]; then emit hubsecret unchanged',
      '  else mkdir -p "$sd" && chmod 700 "$sd"; t="$(mktemp "$sd/.switchboard.XXXXXX")" && printf "%s" "$want" > "$t" && chmod 600 "$t" && mv -f "$t" "$hf" && emit hubsecret written || emit hubsecret failed; fi',
      'fi',
    );
  }
  if (settingsText != null) {
    lines.push(
      's="$HOME/.t3/userdata/settings.json"',
      'now="none"; [ -f "$s" ] && now="$(sha256sum "$s" | cut -d" " -f1)"',
      `if [ "$now" != ${shq(expectSha ?? 'none')} ]; then emit conflict 1; exit 3; fi`,
      `if [ -f "$s" ]; then b="$s.${backupSuffix}"; cp -p "$s" "$b" || fail "cannot back up $s"; emit backup "$b"; fi`,
      `put "$s" 600 ${shq(B64(settingsText))}`,
      'emit settings written',
    );
  }
  lines.push('emit done 1', '');
  return lines.join('\n');
}

/**
 * One tiny borrowed run per wrapper, to prove the whole path end to end. Waits for the broker
 * to accept the key first, because a key created a moment ago reaches the running tray only
 * when it next reads its settings (about a second).
 */
export function proveScript(wrapperFiles = [], { timeoutSeconds = 150, model = 'haiku' } = {}) {
  // From the home folder: wsl.exe starts in the caller's folder, and a project there (its hooks,
  // its MCP servers) would otherwise run with the lent token.
  const lines = [...SCRIPT_HEAD, 'cd "$HOME" || exit 1', 'bin="$HOME/.local/bin"'];
  for (const file of wrapperFiles) {
    if (!/^(t3-claude-[A-Za-z0-9._-]+|switchboard-lease)$/.test(file)) throw new Error(`unexpected wrapper name ${file}`);
    lines.push(
      `out="$(timeout ${Number(timeoutSeconds)} "$bin/${file}" -p ${shq(PROOF_PROMPT)} --model ${shq(model)} </dev/null 2>&1)"; code=$?`,
      `emit ${shq(`prove.${file}`)} "$code $(printf "%s" "$out" | tail -c 600)"`,
    );
  }
  lines.push('emit done 1', '');
  return lines.join('\n');
}

/**
 * prove output into [{ file, ok, cooling, code, detail }]. A run is ok when it exited 0 and said
 * ok. Exit 75 is the wrapper finding no lane free (the account is cooling down or out for the
 * week): the setup is not at fault, so it is reported as cooling rather than as a failure.
 */
export function parseProve(text, wrapperFiles = []) {
  const raw = parseMarkedOutput(text);
  return wrapperFiles.map((file) => {
    const v = raw[`prove.${file}`];
    if (v == null) return { file, ok: false, code: null, detail: 'no answer from the target' };
    const sp = v.indexOf(' ');
    const code = Number(sp >= 0 ? v.slice(0, sp) : v);
    const detail = (sp >= 0 ? v.slice(sp + 1) : '').trim();
    const said = detail.split(/\r?\n/).map((l) => l.trim().toLowerCase().replace(/[.!]$/, ''));
    return { file, ok: code === 0 && said.includes('ok'), cooling: code === 75, code, detail: detail.slice(-300) };
  });
}

// ---------------------------------------------------------------------------------------------
// Transport.

/** The program and arguments that run a bash script (fed on stdin) on the target. */
export function targetCommand(target) {
  if (target.kind === 'wsl') return { file: 'wsl.exe', args: ['-d', target.name, '--exec', 'bash', '-s'] };
  if (target.kind === 'ssh') {
    // BatchMode: key sign-in only. A password or host-key prompt would wait forever on a pipe.
    return { file: 'ssh', args: ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', target.name, 'bash -s'] };
  }
  throw new Error(`unknown environment kind ${target.kind}`);
}

export function runScript(target, script, { spawnImpl = spawn, timeoutMs = 60000 } = {}) {
  const { file, args } = targetCommand(target);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    let child;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    try {
      child = spawnImpl(file, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: String(e.message || e) });
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* already gone */ }
      finish({ code: null, stdout, stderr: `${stderr}\n${file} timed out after ${Math.round(timeoutMs / 1000)} s`.trim() });
    }, timeoutMs);
    child.stdout?.on('data', (c) => { stdout += c; });
    child.stderr?.on('data', (c) => { stderr += c; });
    child.on('error', (e) => finish({ code: null, stdout, stderr: String(e.message || e) }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(Buffer.from(script.replace(/\r\n/g, '\n'), 'utf8'));
  });
}

// ---------------------------------------------------------------------------------------------
// The whole setup for one environment.

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * Set up one environment. `deps` carries everything with a side effect on this machine, so a
 * test can run the whole flow against fakes:
 *   loadSettings() / saveSettings(s)   Switchboard settings
 *   registry                           Switchboard accounts
 *   canLend(lane, account)             the broker's own lending rule (optional)
 *   leaseScript                        the text of bin/switchboard-lease
 *   port                               the broker's port
 *   brokerUrl                          what an ssh target is told (http://<lan ip>:<port>)
 *   wslBrokerUrls                      what a WSL target tries (its default route is added)
 *   hubUrl                             the quota hub url for T3, or null
 *   createKey(settings, label)         -> { settings, secret, key, created }
 *   run(target, script, opts)          -> { code, stdout, stderr }
 * Options:
 *   replaceSymlink  install a copy over a symlinked lease wrapper
 *   prove           send each account one short message from the target (default true)
 *   refreshOnly     the tray's start-up refresh: bring the wrapper files up to date and nothing
 *                   else. It never makes a key (a key someone revoked stays revoked), never
 *                   writes T3's settings (a provider someone removed stays removed), and never
 *                   proves.
 * The report's `reached` says whether the target answered at all, so a machine that is merely
 * asleep is not recorded as broken.
 */
export async function setupT3Environment(target, deps, { replaceSymlink = false, prove = true, refreshOnly = false, now = Date.now() } = {}) {
  const report = {
    target: target.id, ok: false, reached: false, steps: [], accounts: [], skipped: [], leftovers: [],
    proof: [], signIns: [], keyId: null, keyCreated: false, error: null, backup: null, port: deps.port ?? 8318,
    brokerUrl: target.kind === 'ssh' ? deps.brokerUrl : null,
  };
  const step = (text) => report.steps.push(text);
  const fail = (text) => { report.error = text; return report; };

  const { lendable, skipped } = lendableClaudeAccounts(deps.registry, deps.loadSettings(), { canLend: deps.canLend ?? null });
  report.skipped = skipped;
  report.accounts = lendable.map((a) => ({ id: a.id, label: a.label }));
  if (!lendable.length) return fail('Switchboard has no Claude account it can lend (each needs a lane with a live setup token).');

  const port = report.port;
  const inspectOpts = target.kind === 'ssh'
    ? { brokerUrls: [deps.brokerUrl] }
    : { brokerUrls: deps.wslBrokerUrls ?? [`http://127.0.0.1:${port}`], defaultRoutePort: port };
  const runOpts = { timeoutMs: 60000 };

  let inspected = null;
  let applied = null;
  let keySecret = null;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const res = await deps.run(target, inspectScript(inspectOpts), runOpts);
    inspected = parseInspect(res.stdout);
    if (!inspected) {
      const why = (res.stderr || '').trim().split(/\r?\n/).slice(-3).join(' ');
      return fail(`could not reach ${target.id}${why ? `: ${why}` : ''}`);
    }
    report.reached = true;
    // Checked on every attempt: after a conflict the file is read again and may be different.
    if (inspected.settingsError) return fail(`T3's settings file on ${target.id} cannot be read safely (${inspected.settingsError}); not touching it.`);
    if (!inspected.home || !inspected.home.startsWith('/')) return fail(`${target.id} did not say where its home folder is.`);
    if (attempt === 1) {
      if (!inspected.t3) return fail(`T3 Code has never run as this user on ${target.id} (no ~/.t3/userdata). Open that environment in T3 first.`);
      if (inspected.missingTools.length) return fail(`${target.id} lacks ${inspected.missingTools.join(', ')}, which the setup needs (GNU coreutils).`);
      if (!inspected.curl) return fail(`curl is not installed on ${target.id}.`);
      if (inspected.json === 'none') return fail(`${target.id} has neither node nor python3, and the lease wrapper needs one to read the broker's reply.`);
      if (!inspected.claude) return fail(`Claude Code is not installed on ${target.id}. Install it there (curl -fsSL https://claude.ai/install.sh | bash), then run this again.`);
      if (!inspected.broker) {
        const tried = inspected.probes.map((p) => p.url).join(', ') || 'no address';
        return fail(`${target.id} cannot reach Switchboard's broker (tried ${tried}). Check Switchboard is running, the gateway is on with scope lan, and Windows Firewall allows port ${port}.`);
      }
      step(`Reached ${target.id}: home ${inspected.home}, claude at ${inspected.claude}, broker at ${inspected.broker.url}.`);

      // The key: keep the one on the target when the broker accepts it (other tools there, such as
      // a bridge, may share that file); otherwise give this environment its own, so it can be
      // revoked on its own. The start-up refresh never makes one: a refused key may be one a
      // person revoked on purpose to cut this machine off.
      if (inspected.broker.code === 200 && inspected.key === 'present') {
        step('Kept the client key already on the target (the broker accepts it).');
      } else if (refreshOnly) {
        return fail(`the broker refuses ${target.id}'s client key (revoked?). Run the setup for it to issue a new one.`);
      } else {
        const made = deps.createKey(deps.loadSettings(), `T3 ${target.name}`);
        deps.saveSettings(made.settings);
        keySecret = made.secret;
        report.keyId = made.key?.id ?? null;
        report.keyCreated = Boolean(made.created);
        step(`${inspected.key === 'present' ? 'The broker refused the key on the target, so it gets' : 'Gave the target'} its own client key "${made.key?.label ?? `T3 ${target.name}`}".`);
      }
    }

    const merged = mergeT3EnvironmentSettings(inspected.settings ?? {}, {
      home: inspected.home,
      accounts: lendable,
      wrappers: inspected.wrappers,
      hubUrl: deps.hubUrl ?? null,
    });
    report.leftovers = merged.leftovers;
    const hubSecretFile = merged.hubId && (!refreshOnly || inspected.settings?.usageLimitSources?.[merged.hubId])
      ? t3HubSecretFileName(merged.hubId)
      : null;
    const wrappers = lendable.map((a) => ({ file: merged.wrapperFiles[a.id], text: accountWrapperScript(a) }));
    // A file that already says exactly this is not rewritten (the shell drops its last newline).
    // In a refresh, only wrappers T3 already points at are touched.
    const toWrite = wrappers
      .filter((w) => (inspected.wrapperTexts?.[w.file] ?? null)?.trimEnd() !== w.text.trimEnd())
      .filter((w) => !refreshOnly || w.file in (inspected.wrapperTexts ?? {}))
      .map((w) => ({ ...w, backup: merged.adoptedFiles.includes(w.file) && wrapperAccountId(inspected.wrapperTexts[w.file]) !== null && inspected.wrapperTexts[w.file].trimEnd() !== w.text.trimEnd() }));
    const leaseCurrent = inspected.lease === `file:${sha256(deps.leaseScript)}`;
    const settingsText = !refreshOnly && merged.changes.length ? `${JSON.stringify(merged.settings, null, 2)}\n` : null;
    const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const script = applyScript({
      key: keySecret,
      brokerUrl: target.kind === 'ssh' && inspected.brokerFile !== deps.brokerUrl ? deps.brokerUrl : null,
      // Inside WSL the wrapper finds the broker by its default route on 8318; any other port is
      // saved for it, because the address itself changes with each WSL start.
      brokerPort: target.kind === 'wsl' && port !== 8318 ? port : null,
      leaseScript: leaseCurrent ? null : deps.leaseScript,
      replaceSymlink,
      wrappers: toWrite,
      settingsText,
      expectSha: inspected.settingsSha,
      backupSuffix: `before-switchboard-${stamp}`,
      hubSecretFile,
    });
    const res2 = await deps.run(target, script, runOpts);
    const out = parseMarkedOutput(res2.stdout, ['wrapper', 'wrapperbackup']);
    if (out.key) {
      step('Wrote the client key.');
      keySecret = null; // written; a second attempt must not write it again
    }
    if (out.conflict === '1') {
      if (attempt === 1) {
        step('T3 saved its settings while this ran; planning again.');
        continue;
      }
      return fail(`T3 kept changing its settings on ${target.id}; try again in a moment.`);
    }
    if (out.done !== '1') {
      return fail(`writing to ${target.id} failed: ${out.error || (res2.stderr || '').trim().split(/\r?\n/).pop() || 'no answer'}`);
    }
    if (out.brokerurl) step(`Saved the broker address ${deps.brokerUrl} on the target.`);
    if (out.brokerport) step(`Saved the broker port ${port} on the target.`);
    if (out.lease === 'written') step('Installed the lease wrapper (~/.local/bin/switchboard-lease).');
    else if (out.lease?.startsWith('symlink-kept')) step(`Left the lease wrapper alone: it is a link to ${out.lease.slice('symlink-kept '.length)}. Pass --replace-symlink to install a copy.`);
    if (leaseCurrent) step('The lease wrapper there is already this version.');
    step(out.wrapper.length ? `Wrote ${out.wrapper.length} account wrapper${out.wrapper.length === 1 ? '' : 's'}: ${out.wrapper.join(', ')}.` : 'The account wrappers there are already up to date.');
    for (const b of out.wrapperbackup) step(`Kept a copy of the hand-written wrapper it replaced: ~/.local/bin/${b}.`);
    if (out.hubsecret === 'written') step('Saved the quota hub key for T3.');
    if (out.hubsecret === 'failed') step('Could not save the quota hub key; add it in T3 (Settings, Providers, Usage providers).');
    if (out.settings === 'written') {
      report.backup = out.backup ?? null;
      for (const c of merged.changes) step(`T3: ${c}.`);
      if (out.backup) step(`T3's previous settings are kept at ${out.backup}.`);
    } else if (!refreshOnly) {
      step('T3 already had every entry; its settings were not touched.');
    }
    applied = { merged, wrappers };
    break;
  }
  if (!applied) return fail(`T3 kept changing its settings on ${target.id}; try again in a moment.`);

  report.signIns = [];
  if (inspected.codex === 'not-signed-in') report.signIns.push({ provider: 'Codex', how: 'codex login --device-auth' });
  report.signIns.push({ provider: 'Grok, Antigravity, Junie', how: 'sign in on that machine if you use them there; Switchboard cannot lend them' });

  if (prove && !refreshOnly) {
    const files = applied.wrappers.map((w) => w.file);
    let results = parseProve((await deps.run(target, proveScript(files), { timeoutMs: (files.length * 160 + 30) * 1000 })).stdout, files);
    // A key made a moment ago may not have reached the tray yet; those runs exit 78 with
    // "rejected". Only they are tried again, after the tray has had time to re-read its settings.
    const refused = results.filter((r) => r.code === 78).map((r) => r.file);
    if (report.keyCreated && refused.length) {
      await (deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(3000);
      const again = parseProve((await deps.run(target, proveScript(refused), { timeoutMs: (refused.length * 160 + 30) * 1000 })).stdout, refused);
      results = results.map((r) => again.find((a) => a.file === r.file) ?? r);
    }
    report.proof = results.map((r) => {
      const account = lendable.find((a) => applied.merged.wrapperFiles[a.id] === r.file);
      return { ...r, account: account?.id ?? null, label: account?.label ?? r.file };
    });
    const bad = report.proof.filter((r) => !r.ok && !r.cooling);
    const cooling = report.proof.filter((r) => r.cooling);
    if (bad.length) step(`Proof: ${bad.length} of ${report.proof.length} accounts did not answer.`);
    else step(`Proof: ${report.proof.length - cooling.length} of ${report.proof.length} accounts answered through Switchboard.`);
    if (cooling.length) step(`Not proven, because the account is out of allowance right now (not a setup fault): ${cooling.map((r) => r.label).join(', ')}.`);
    report.ok = bad.length === 0;
  } else {
    if (!refreshOnly) step('Skipped the proof run.');
    report.ok = true;
  }
  return report;
}

/**
 * The client key an environment gets when the one on it is missing or refused: a readable key
 * already made for it (a second run reuses it rather than piling up keys), else a new one, on
 * the gateway's scope either way. Keys made here are marked as belonging to a T3 environment,
 * so `gateway provision-client` does not hand one out as this machine's own key. Pure; the
 * caller saves the returned settings.
 */
export const T3_KEY_PURPOSE = 't3-environment';
export function keyForEnvironment(settings, label, { now = Date.now() } = {}) {
  const scope = normalizeGatewaySettings(settings?.gateway).scope;
  const wanted = String(label ?? '').trim().toLowerCase();
  const existing = Object.values(settings?.gatewayKeys ?? {}).find((e) => e && !e.unreadable && e.purpose === T3_KEY_PURPOSE
    && typeof e.token === 'string' && e.token.startsWith('sb-key-') && String(e.label ?? '').trim().toLowerCase() === wanted);
  if (existing) {
    const entry = existing.scope === scope ? existing : { ...existing, scope };
    return {
      settings: entry === existing ? settings : { ...settings, gatewayKeys: { ...settings.gatewayKeys, [entry.id]: entry } },
      key: publicGatewayKey(entry, now),
      secret: entry.token,
      created: false,
    };
  }
  const made = createGatewayKey(settings, { label: String(label).slice(0, 80), scope, now });
  const id = made.key.id;
  const marked = { ...made.settings, gatewayKeys: { ...made.settings.gatewayKeys, [id]: { ...made.settings.gatewayKeys[id], purpose: T3_KEY_PURPOSE } } };
  return { ...made, settings: marked, created: true };
}

/**
 * Remember an environment so `t3 setup --all`, `t3 status` and Health know about it. A target
 * that never answered and was not known before is not remembered (a typo stays a typo); one
 * that was known and is unreachable now keeps its last good record, with the failed attempt
 * noted beside it, because a machine that is asleep is not broken.
 */
export function rememberT3Environment(settings, target, report, { leaseSha = null, now = Date.now() } = {}) {
  const envs = { ...(settings?.t3Environments ?? {}) };
  const prev = envs[target.id];
  if (!report.reached) {
    if (!prev) return settings;
    envs[target.id] = { ...prev, lastAttemptAt: now, lastAttemptError: report.error ?? null };
    return { ...settings, t3Environments: envs };
  }
  if (!prev && !report.ok && report.error) {
    // Reached but refused before anything was written there (no T3, no claude, no broker).
    return settings;
  }
  envs[target.id] = {
    id: target.id,
    kind: target.kind,
    name: target.name,
    keyId: report.keyId ?? prev?.keyId ?? null,
    port: report.port ?? prev?.port ?? null,
    brokerUrl: report.brokerUrl ?? prev?.brokerUrl ?? null,
    lastSetupAt: now,
    lastOk: Boolean(report.ok),
    lastError: report.error ?? null,
    lastAttemptAt: now,
    lastAttemptError: null,
    accounts: (report.accounts ?? []).map((a) => a.id),
    proofFailed: (report.proof ?? []).filter((r) => !r.ok && !r.cooling).map((r) => r.label),
    leaseSha: report.error ? (prev?.leaseSha ?? null) : leaseSha,
  };
  return { ...settings, t3Environments: envs };
}

/** Forget an environment: Switchboard stops listing and checking it. Nothing on it is touched. */
export function forgetT3Environment(settings, targetId) {
  const envs = { ...(settings?.t3Environments ?? {}) };
  if (!envs[targetId]) throw new Error(`no T3 environment "${targetId}" is remembered`);
  delete envs[targetId];
  return { ...settings, t3Environments: envs };
}

function ageText(ms, now) {
  if (!ms) return 'never';
  const mins = Math.max(0, Math.round((now - ms) / 60000));
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}

/**
 * One line of state per remembered environment, for `t3 status`, the Gateway tab and Health.
 * It is judged from what Switchboard knows here, without reaching out to the machine:
 * - failed: the last setup or proof failed, or the key it was given has since been revoked.
 * - stale: its lease wrapper is older than this Switchboard's (`wrapperOld`, which the tray's
 *   start-up refresh acts on), an account was added since, or the broker's port or address
 *   moved after it was set up. Running the setup again fixes each of these.
 * Each line carries its age, and a failed attempt to reach it since, so a reading is never
 * passed off as current.
 */
export function t3EnvironmentStatus(settings, { leaseSha = null, lendableIds = [], port = null, brokerUrl = null, now = Date.now() } = {}) {
  return Object.values(settings?.t3Environments ?? {}).map((e) => {
    const missing = lendableIds.filter((id) => !(e.accounts ?? []).includes(id));
    const wrapperOld = Boolean(leaseSha && e.leaseSha && e.leaseSha !== leaseSha);
    const keyGone = Boolean(e.keyId && !settings?.gatewayKeys?.[e.keyId]);
    const moved = [
      port != null && e.port != null && e.port !== port ? `the broker's port changed to ${port}` : null,
      e.kind === 'ssh' && brokerUrl && e.brokerUrl && e.brokerUrl !== brokerUrl ? `the broker's address changed to ${brokerUrl}` : null,
    ].filter(Boolean);
    let state = 'ok';
    let detail = `${(e.accounts ?? []).length} accounts`;
    if (!e.lastOk) {
      state = 'failed';
      detail = e.lastError || (e.proofFailed?.length ? `no answer from ${e.proofFailed.join(', ')}` : 'last setup failed');
    } else if (keyGone) {
      state = 'failed';
      detail = 'the client key it was given has been revoked';
    } else if (wrapperOld || missing.length || moved.length) {
      state = 'stale';
      detail = [wrapperOld ? 'the lease wrapper there is out of date' : null, missing.length ? `not yet set up for ${missing.join(', ')}` : null, ...moved].filter(Boolean).join('; ');
    }
    detail += `; set up ${ageText(e.lastSetupAt, now)}`;
    if (e.lastAttemptError) detail += `; could not reach it ${ageText(e.lastAttemptAt, now)}`;
    return { id: e.id, kind: e.kind, name: e.name, state, detail, wrapperOld, lastSetupAt: e.lastSetupAt ?? null };
  });
}
