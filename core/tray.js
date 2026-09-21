import { defaultFollowsLanes } from './lanes.js';
import { pct, readable, spentEvidence } from './lanes-util.js';

/**
 * What the tray menu says, as data.
 *
 * The menu is the only part of Switchboard most people see most days, and until now it
 * was also the only part with nothing behind it that could be checked. Building it as a
 * list of plain rows means the wording, the ordering and the decisions about what to hide
 * can be tested without an Electron window; `src/main.js` turns each row into a menu item
 * and attaches the click.
 *
 * Row kinds: warning, heading, account, status, submenu, watch, command, checkbox,
 * separator. Anything that needs to run something carries an `action` naming what, never
 * a function, so a row stays comparable in a test.
 */

/**
 * When a limit comes back: a time today, a weekday this week, otherwise a date.
 *
 * The formatting is an argument so it can be pinned in a test. Left alone it follows the
 * machine, which is what someone reading their own tray wants.
 */
export function whenBack(at, now = Date.now(), { locale, timeZone } = {}) {
  const when = new Date(at);
  const hours = (at - now) / (60 * 60 * 1000);
  if (hours < 12) return when.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  if (hours < 24 * 6) return when.toLocaleDateString(locale, { weekday: 'long', timeZone });
  return when.toLocaleDateString(locale, { timeZone });
}

/**
 * The short state word on an account row, or null when the account is plainly fine.
 *
 * A row used to be the label and nothing else, so an account that was signed out or out
 * of quota looked exactly like a working one, and clicking it pointed the whole machine
 * at something that could not run. Saying nothing when all is well keeps the menu quiet:
 * a word here always means "this one is not simply ready".
 */
export function accountNote(login, snapshot, now = Date.now(), format = {}) {
  if (login?.signedIn === false) return 'signed out';
  if (login?.signedIn !== true) return null;
  const evidence = spentEvidence(snapshot, now);
  if (evidence.state === 'spent') {
    return evidence.resetsAt ? `out until ${whenBack(evidence.resetsAt, now, format)}` : 'out of quota';
  }
  if (evidence.state === 'clear' && readable(snapshot)) return null;
  return 'usage unknown';
}

/** The two account-wide meters that fit in the Windows hover text. */
export function accountUsage(snapshot) {
  if (!readable(snapshot)) return null;
  const values = [
    ['5h', pct(snapshot, 'session')],
    ['week', pct(snapshot, 'week')],
  ];
  const shown = values
    .filter(([, value]) => value != null && Number.isFinite(Number(value)))
    .map(([label, value]) => `${label} ${Number(value)}%`);
  return shown.length ? shown.join(', ') : null;
}

/** The same two meters, squeezed enough for several accounts in the Windows tooltip. */
export function compactAccountUsage(snapshot) {
  if (!readable(snapshot)) return null;
  const values = [
    ['5h', pct(snapshot, 'session')],
    ['wk', pct(snapshot, 'week')],
  ];
  const shown = values
    .filter(([, value]) => value != null && Number.isFinite(Number(value)))
    .map(([label, value]) => `${label}${Number(value)}%`);
  return shown.length ? shown.join(' ') : null;
}

/**
 * Extract Antigravity quota rate-limit windows into Gemini, Claude & GPT, and Credits.
 */
export function parseAntigravityWindows(snapshot) {
  if (!readable(snapshot) || !Array.isArray(snapshot?.windows)) return null;
  let gemini5h = null;
  let geminiWeek = null;
  let claude5h = null;
  let claudeWeek = null;
  let credits = null;

  for (const w of snapshot.windows) {
    if (w.key === 'credits') {
      credits = w;
      continue;
    }
    const raw = `${w.label || ''} ${w.key || ''}`.toLowerCase();
    const isGemini = raw.includes('gemini');
    const isClaude = raw.includes('claude') || raw.includes('gpt');
    const is5h = raw.includes('5h') || raw.includes('5-hour') || raw.includes('five hour') || raw.includes('5 hour');
    const isWeek = raw.includes('week') || raw.includes('weekly') || raw.includes('wk');

    if (isGemini) {
      if (is5h) gemini5h = w;
      else if (isWeek) geminiWeek = w;
    } else if (isClaude) {
      if (is5h) claude5h = w;
      else if (isWeek) claudeWeek = w;
    }
  }

  if (!gemini5h && !geminiWeek && !claude5h && !claudeWeek && !credits) return null;
  return { gemini5h, geminiWeek, claude5h, claudeWeek, credits };
}

/**
 * Detailed usage and availability lines for Antigravity in the tray menu.
 */
export function antigravityMenuUsage(snapshot, now = Date.now(), format = {}) {
  const parsed = parseAntigravityWindows(snapshot);
  if (!parsed) return [];
  const lines = [];

  const formatBucket = (name, b5h, bWk) => {
    if (!b5h && !bWk) return null;
    const parts = [];
    if (b5h && b5h.usedPercent != null) {
      if (b5h.usedPercent >= 100) {
        parts.push(b5h.resetsAt ? `5h out until ${whenBack(b5h.resetsAt, now, format)}` : '5h out of quota');
      } else {
        parts.push(`5h ${b5h.usedPercent}%`);
      }
    }
    if (bWk && bWk.usedPercent != null) {
      if (bWk.usedPercent >= 100) {
        parts.push(bWk.resetsAt ? `week out until ${whenBack(bWk.resetsAt, now, format)}` : 'week out of quota');
      } else {
        parts.push(`week ${bWk.usedPercent}%`);
      }
    }
    return parts.length ? `${name}: ${parts.join(', ')}` : null;
  };

  const gemini = formatBucket('Gemini', parsed.gemini5h, parsed.geminiWeek);
  if (gemini) lines.push(gemini);

  const claude = formatBucket('Claude & GPT', parsed.claude5h, parsed.claudeWeek);
  if (claude) lines.push(claude);

  if (parsed.credits?.valueLabel) {
    lines.push(`Credits: ${parsed.credits.valueLabel}`);
  }

  return lines;
}

/**
 * Compact or detailed usage lines for Antigravity in the tray tooltip.
 */
export function antigravityTooltipLines(snapshot, { compact = false, singleLine = false, now = Date.now(), format = {} } = {}) {
  const parsed = parseAntigravityWindows(snapshot);
  if (!parsed) return [];

  const formatWindow = (b5h, bWk, name, shortName) => {
    if (!b5h && !bWk) return null;
    if (compact) {
      const parts = [];
      if (b5h && b5h.usedPercent != null) {
        if (b5h.usedPercent >= 100) {
          parts.push(b5h.resetsAt ? `out until ${whenBack(b5h.resetsAt, now, format)}` : 'out');
        } else {
          parts.push(`5h${b5h.usedPercent}%`);
        }
      }
      if (bWk && bWk.usedPercent != null) {
        if (bWk.usedPercent >= 100) {
          parts.push(bWk.resetsAt ? `wk out` : 'out');
        } else {
          parts.push(`wk${bWk.usedPercent}%`);
        }
      }
      return parts.length ? `${shortName} ${parts.join(' ')}` : null;
    } else {
      const parts = [];
      if (b5h && b5h.usedPercent != null) {
        if (b5h.usedPercent >= 100) {
          parts.push(b5h.resetsAt ? `out until ${whenBack(b5h.resetsAt, now, format)}` : 'out of quota');
        } else {
          parts.push(`5h ${b5h.usedPercent}%`);
        }
      }
      if (bWk && bWk.usedPercent != null) {
        if (bWk.usedPercent >= 100) {
          parts.push(bWk.resetsAt ? `week out until ${whenBack(bWk.resetsAt, now, format)}` : 'week out of quota');
        } else {
          parts.push(`week ${bWk.usedPercent}%`);
        }
      }
      return parts.length ? `${name}, ${parts.join(', ')}` : null;
    }
  };

  const gemini = formatWindow(parsed.gemini5h, parsed.geminiWeek, 'Gemini', 'Gemini');
  const claude = formatWindow(parsed.claude5h, parsed.claudeWeek, 'Claude & GPT', 'Claude');

  const items = [gemini, claude].filter(Boolean);
  if (!items.length) return [];
  if (singleLine) {
    return [items.join(' ')];
  }
  return items;
}

/** The three things the watch can do when an account runs out, in plain words. */
export const WATCH_MODES = [
  ['off', 'Do nothing'],
  ['notify', 'Tell me'],
  ['auto', 'Switch automatically'],
];

/**
 * Everything wrong that the tray can say, in the order it should be read.
 *
 * Each of these is something the app already knew and the tray used to keep to itself.
 * They appear only when true, so a machine with nothing wrong sees none of them. The
 * menu and the hover text both build from this one list, because a hover that disagrees
 * with the menu underneath it is worse than a hover that says less.
 */
export function trayWarnings({ accounts = [], overrideBlocking = false, strandedProviders = [], update = null } = {}) {
  const warnings = [];
  if (accounts.length === 0) {
    warnings.push({ kind: 'warning', label: 'No accounts set up yet, open Switchboard', action: 'open:accounts' });
  }
  if (overrideBlocking) {
    warnings.push({ kind: 'warning', label: 'A sign-in override is blocking switching, open Health', action: 'open:health' });
  }
  for (const name of strandedProviders) {
    warnings.push({ kind: 'warning', label: `${name} is pointed at a folder that is not registered`, action: 'open:accounts' });
  }
  if (update) {
    warnings.push({ kind: 'warning', label: `Update available: ${update}`, action: 'open:about' });
  }
  return warnings;
}

export function trayModel({
  providers = [],
  accounts = [],
  activeIds = {},
  notes = {},
  alsoSignedIn = [],
  terminals = [],
  watchMode = 'off',
  lanes = [],
  overrideBlocking = false,
  strandedProviders = [],
  update = null,
  startWithWindows = false,
  now = Date.now(),
  locale = undefined,
  antigravityQuota = null,
} = {}) {
  const rows = [];

  const warnings = trayWarnings({ accounts, overrideBlocking, strandedProviders, update });
  if (warnings.length) rows.push(...warnings, { kind: 'separator' });

  for (const provider of providers) {
    const mine = accounts.filter((a) => a.provider === provider.id);
    if (!mine.length) continue; // a tool with no accounts is the window's business
    // When the watch keeps this tool on its lane order, a row picked here would be
    // switched straight back, so the rows still show which account is in use but no
    // longer offer to change it, and the heading says why. See defaultFollowsLanes.
    const followsLanes = defaultFollowsLanes({ quotaWatch: watchMode, lanes }, provider.id);
    rows.push({ kind: 'heading', label: followsLanes ? `${provider.name}, set by lane order` : provider.name });
    for (const account of mine) {
      const note = notes[account.id];
      rows.push({
        kind: 'account',
        accountId: account.id,
        label: note ? `${account.label}, ${note}` : account.label,
        checked: activeIds[provider.id] === account.id,
        enabled: !followsLanes,
      });
    }
    rows.push({ kind: 'separator' });
  }

  // Tools that hold one sign-in for the whole machine. There is nothing to pick between,
  // so they are lines to read rather than things to click; they are here because they are
  // accounts you have, and the window was the only place that admitted it.
  if (alsoSignedIn.length) {
    rows.push({ kind: 'heading', label: 'Also signed in' });
    for (const tool of alsoSignedIn) {
      const who = tool.who || (tool.signedIn ? 'signed in' : 'not signed in');
      rows.push({ kind: 'status', label: `${tool.name}, ${who}` });
      const agQuota = tool.quota ?? (tool.name === 'Antigravity' ? antigravityQuota : null);
      if (agQuota && readable(agQuota)) {
        const usageLines = antigravityMenuUsage(agQuota, now, { locale });
        for (const line of usageLines) {
          rows.push({ kind: 'status', label: `  ${line}` });
        }
      }
    }
    rows.push({ kind: 'separator' });
  }

  // Opening a terminal on a named account changes nothing machine-wide, which makes it
  // the one thing in this menu that is a click rather than a decision.
  const openable = terminals.filter((t) => t.bin);
  if (openable.length) {
    const items = [];
    for (const tool of openable) {
      if (!tool.accounts?.length) {
        items.push({ kind: 'terminal', label: tool.name, bin: tool.bin, accountId: null });
        continue;
      }
      for (const account of tool.accounts) {
        items.push({ kind: 'terminal', label: `${tool.name} on ${account.label}`, bin: tool.bin, accountId: account.id });
      }
    }
    rows.push({ kind: 'submenu', label: 'Open a terminal', items });
    rows.push({ kind: 'separator' });
  }

  // The old wording ("Notify when the default runs out") described the behaviour before
  // lanes existed. Naming the current mode in the parent shows it without opening it.
  const mode = WATCH_MODES.find(([id]) => id === watchMode) ?? WATCH_MODES[0];
  rows.push({
    kind: 'watch',
    label: `When an account runs out: ${mode[1]}`,
    modes: WATCH_MODES.map(([id, label]) => ({ id, label, checked: watchMode === id })),
  });
  rows.push({ kind: 'separator' });
  rows.push({ kind: 'command', label: 'Open Switchboard', action: 'open:accounts' });
  rows.push({ kind: 'command', label: 'Run health checks', action: 'open:health' });
  rows.push({ kind: 'command', label: 'About Switchboard', action: 'open:about' });
  rows.push({ kind: 'separator' });
  rows.push({ kind: 'checkbox', label: 'Start with Windows', checked: startWithWindows, action: 'startup' });
  rows.push({ kind: 'command', label: 'Quit', action: 'quit' });
  return rows;
}

/**
 * Windows shows at most 127 characters of tray tooltip and cuts whatever follows
 * without saying so, which is why the text below is fitted here rather than there.
 */
export const TOOLTIP_LIMIT = 127;
const TOOLTIP_INDENT = '\u2003';

/**
 * The hover text: every signed-in account, its usage when already cached, and anything
 * about it which is not simply ready.
 *
 * It takes the same input as the menu and says the same things in the same words,
 * because a hover that disagrees with the menu underneath it is worse than one that
 * says less. What cannot be fitted is counted rather than quietly dropped, so the
 * hover never passes off a part as the whole. When multiple accounts overflow the 127-char
 * limit, active accounts across providers are prioritized so each active tool (including
 * Antigravity) remains visible.
 */
export function trayTooltip(options = {}, limit = TOOLTIP_LIMIT) {
  const {
    providers = [], accounts = [], activeIds = {}, notes = {}, quotas = {}, signedIn = {},
    antigravityQuota = null, alsoSignedIn = [], now = Date.now(), locale = undefined,
  } = options;
  const detailed = [];
  const compact = [];
  const activeDetailed = [];
  const activeCompact = [];

  for (const provider of providers) {
    const mine = accounts
      .filter((a) => a.provider === provider.id)
      .sort((a, b) => Number(activeIds[provider.id] === b.id) - Number(activeIds[provider.id] === a.id));
    const detailedAccounts = [];
    const compactAccounts = [];
    let activeDetailedAccount = null;
    let activeCompactAccount = null;

    for (const account of mine) {
      const note = notes[account.id];
      const usage = accountUsage(quotas[account.id]);
      const compactUsage = compactAccountUsage(quotas[account.id]);
      const selected = activeIds[provider.id] === account.id;
      // A cached usage reading is itself evidence that this account was active. The
      // explicit sign-in state also keeps a ready account visible before it has a reading.
      if (!selected && signedIn[account.id] !== true && !usage && !note) continue;
      // A previous reading belongs to the login that produced it. Once that login is
      // known to be gone, saying so is more useful than repeating its old percentages.
      const detail = note === 'signed out' ? note : (usage ?? note);
      const shortDetail = note === 'signed out' ? note : (compactUsage ?? note);
      const detLine = `${TOOLTIP_INDENT}${account.label}${detail ? `, ${detail}` : ''}`;
      const cmpLine = `${TOOLTIP_INDENT}${account.label}${shortDetail ? ` ${shortDetail}` : ''}`;
      detailedAccounts.push(detLine);
      compactAccounts.push(cmpLine);
      if (selected || !activeDetailedAccount) {
        activeDetailedAccount = detLine;
        activeCompactAccount = cmpLine;
      }
    }
    if (detailedAccounts.length) {
      detailed.push({ lines: [`${provider.name}:`, ...detailedAccounts], count: detailedAccounts.length });
      compact.push({ lines: [`${provider.name}:`, ...compactAccounts], count: compactAccounts.length });
      if (activeDetailedAccount) {
        activeDetailed.push({ lines: [`${provider.name}:`, activeDetailedAccount], count: 1 });
        activeCompact.push({ lines: [`${provider.name}:`, activeCompactAccount], count: 1 });
      }
    }
  }

  const agQuota = antigravityQuota ?? alsoSignedIn.find((t) => t.name === 'Antigravity')?.quota ?? null;
  const hasAgQuota = agQuota && readable(agQuota);
  if (hasAgQuota) {
    const agDetailed = antigravityTooltipLines(agQuota, { compact: false, now, format: { locale } });
    const agCompact = antigravityTooltipLines(agQuota, { compact: true, singleLine: false, now, format: { locale } });

    if (agDetailed.length) {
      const detLines = ['Antigravity:', ...agDetailed.map((l) => `${TOOLTIP_INDENT}${l}`)];
      detailed.push({ lines: detLines, count: agDetailed.length });
      activeDetailed.push({ lines: detLines, count: agDetailed.length });
    }
    if (agCompact.length) {
      const cmpLines = ['Antigravity:', ...agCompact.map((l) => `${TOOLTIP_INDENT}${l}`)];
      compact.push({ lines: cmpLines, count: agCompact.length });
      activeCompact.push({ lines: cmpLines, count: agCompact.length });
    }
  }

  const warnings = trayWarnings(options).map((w) => w.label);

  const complete = (groups) => [...warnings, ...groups.flatMap((group) => group.lines)].join('\n') || 'No active accounts';
  const detailedText = complete(detailed);
  if (detailedText.length <= limit) return detailedText;
  const compactText = complete(compact);
  if (compactText.length <= limit) return compactText;

  // Prioritize active accounts so all active providers fit within the limit
  if (activeCompact.length) {
    const activeCompactText = complete(activeCompact);
    if (activeCompactText.length <= limit) return activeCompactText;

    if (hasAgQuota) {
      const agSingle = antigravityTooltipLines(agQuota, { compact: true, singleLine: true, now, format: { locale } });
      if (agSingle.length) {
        const singleCompactGroups = activeCompact.map((group) => {
          if (group.lines[0] === 'Antigravity:') {
            return { lines: ['Antigravity:', `${TOOLTIP_INDENT}${agSingle[0]}`], count: 1 };
          }
          return group;
        });
        const singleCompactText = complete(singleCompactGroups);
        if (singleCompactText.length <= limit) return singleCompactText;
      }
    }
  }

  const kept = [];
  const keptUnits = [];
  let used = 0;
  let dropped = 0;
  const units = [
    ...warnings.map((line) => ({ lines: [line], count: 1 })),
    ...(activeCompact.length ? activeCompact : compact),
  ];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const added = unit.lines.join('\n').length + (kept.length ? 1 : 0);
    if (used + added <= limit) {
      kept.push(...unit.lines);
      keptUnits.push({ ...unit, added });
      used += added;
    } else {
      dropped = units.slice(index).reduce((sum, rest) => sum + rest.count, 0);
      break;
    }
  }
  // Give a whole provider group back if that is what it takes to admit there are more.
  while (dropped > 0) {
    const tail = `and ${dropped} more`;
    const added = tail.length + (kept.length ? 1 : 0);
    if (used + added <= limit) {
      kept.push(tail);
      break;
    }
    const removed = keptUnits.pop();
    if (!removed) break;
    kept.splice(kept.length - removed.lines.length, removed.lines.length);
    used -= removed.added;
    dropped += removed.count;
  }
  return kept.join('\n') || 'No active accounts';
}
