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
function compactAccountUsage(snapshot) {
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
 * hover never passes off a part as the whole. Tools with one machine-wide sign-in are
 * left to the menu on purpose: they are lines that never change, and they would crowd
 * out the ones that do.
 */
export function trayTooltip(options = {}, limit = TOOLTIP_LIMIT) {
  const {
    providers = [], accounts = [], activeIds = {}, notes = {}, quotas = {}, signedIn = {},
  } = options;
  const detailed = [];
  const compact = [];
  for (const provider of providers) {
    const mine = accounts
      .filter((a) => a.provider === provider.id)
      .sort((a, b) => Number(activeIds[provider.id] === b.id) - Number(activeIds[provider.id] === a.id));
    const detailedAccounts = [];
    const compactAccounts = [];
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
      detailedAccounts.push(`${TOOLTIP_INDENT}${account.label}${detail ? `, ${detail}` : ''}`);
      compactAccounts.push(`${TOOLTIP_INDENT}${account.label}${shortDetail ? ` ${shortDetail}` : ''}`);
    }
    if (detailedAccounts.length) {
      detailed.push({ lines: [`${provider.name}:`, ...detailedAccounts], count: detailedAccounts.length });
      compact.push({ lines: [`${provider.name}:`, ...compactAccounts], count: compactAccounts.length });
    }
  }
  const warnings = trayWarnings(options).map((w) => w.label);

  const title = 'Switchboard';
  const complete = (groups) => [title, ...warnings, ...groups.flatMap((group) => group.lines)].join('\n');
  const detailedText = complete(detailed);
  if (detailedText.length <= limit) return detailedText;
  const compactText = complete(compact);
  if (compactText.length <= limit) return compactText;

  const kept = [title];
  const keptUnits = [];
  let used = title.length;
  let dropped = 0;
  const units = [
    ...warnings.map((line) => ({ lines: [line], count: 1 })),
    ...compact,
  ];
  for (let index = 0; index < units.length; index += 1) {
    const unit = units[index];
    const added = unit.lines.reduce((sum, line) => sum + 1 + line.length, 0);
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
    if (used + 1 + tail.length <= limit) {
      kept.push(tail);
      break;
    }
    const removed = keptUnits.pop();
    if (!removed) break;
    kept.splice(kept.length - removed.lines.length, removed.lines.length);
    used -= removed.added;
    dropped += removed.count;
  }
  return kept.join('\n');
}
