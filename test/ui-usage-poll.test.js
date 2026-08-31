import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The usage cards live in the single-file UI, so there is nothing to import. These
 * tests lift the parts that decide how long a reading may stay on screen and run them
 * against a DOM small enough to read.
 *
 * What they protect is one promise: a figure on screen describes the window it is
 * standing next to. On 2026-08-31 it did not. The cards read usage once as they were
 * drawn and never again, so a five-hour window turned over while the panel sat open
 * and the panel kept showing the spent window's percentages beside a reset time that
 * had already passed, with nothing admitting either. Both accounts were affected and
 * the background watch held the correct figures the whole time.
 */
const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'), 'utf8');

/** Pull one top-level `const x = ...` line or `function x() { ... }` block out of the page. */
function lift(name) {
  const lines = HTML.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `) || l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `found ${name} in index.html`);
  if (lines[start].startsWith('const ')) return lines[start];
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.ok(end > start, `found the end of ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

function makeDom() {
  const all = [];
  const matches = (node, sel) => {
    if (sel === '#tab-accounts .usage-content') return node.classList.contains('usage-content');
    throw new Error(`unsupported selector: ${sel}`);
  };
  const createElement = (tag) => {
    const node = {
      tag,
      className: '',
      innerHTML: '',
      textContent: '',
      title: '',
      type: '',
      tabIndex: 0,
      style: {},
      attrs: {},
      children: [],
      parentElement: null,
      handlers: {},
      classList: {
        add: (c) => { if (!node.className.split(' ').includes(c)) node.className = `${node.className} ${c}`.trim(); },
        remove: (c) => { node.className = node.className.split(' ').filter((x) => x && x !== c).join(' '); },
        contains: (c) => node.className.split(' ').includes(c),
        toggle: (c, on) => (on ? node.classList.add(c) : node.classList.remove(c)),
      },
      setAttribute: (k, v) => { node.attrs[k] = v; },
      getAttribute: (k) => node.attrs[k] ?? null,
      addEventListener: (ev, fn) => { (node.handlers[ev] ||= []).push(fn); },
      appendChild: (child) => { child.parentElement = node; node.children.push(child); return child; },
      replaceChildren: (...kids) => { kids.forEach((k) => { k.parentElement = node; }); node.children = kids; },
      contains: (other) => {
        for (let at = other; at; at = at.parentElement) if (at === node) return true;
        return false;
      },
    };
    all.push(node);
    return node;
  };
  const document = {
    createElement,
    createTextNode: (text) => ({ tag: '#text', textContent: text, className: '', parentElement: null }),
    querySelectorAll: (sel) => all.filter((n) => matches(n, sel)),
    activeElement: null,
    hidden: false,
  };
  return { document, createElement };
}

/** Evaluate the lifted helpers against the stub DOM and hand back what the tests drive. */
function load(names, exports, extras = {}) {
  const { document, createElement } = makeDom();
  const argNames = ['document', ...Object.keys(extras)];
  const src = [
    'let usageTimer = null;',
    lift('el'),
    lift('esc'),
    ...names.map(lift),
    `return { ${exports.join(', ')} };`,
  ].join('\n');
  const api = new Function(...argNames, src)(document, ...Object.values(extras));
  return { ...api, document, createElement };
}

/* ----------------------------- when a tick reads ---------------------------- */

test('a tick reads only when the panel is current, on screen and not away in the tray', () => {
  const { shouldPollUsage } = load(['shouldPollUsage'], ['shouldPollUsage']);
  assert.equal(shouldPollUsage({ current: true, tabOn: true, hidden: false }), true);
  assert.equal(shouldPollUsage({ current: false, tabOn: true, hidden: false }), false, 'a superseded render never reads');
  assert.equal(shouldPollUsage({ current: true, tabOn: false, hidden: false }), false, 'another tab is open');
  assert.equal(shouldPollUsage({ current: true, tabOn: true, hidden: true }), false, 'the window is in the tray');
});

test('being on screen must be answered, while being away has to be claimed', () => {
  const { shouldPollUsage } = load(['shouldPollUsage'], ['shouldPollUsage']);
  // The two that permit a read are required to say yes; the one that forbids it has
  // to say so outright. A browser always answers document.hidden, so the asymmetry
  // only ever settles what an unanswerable question means: keep the figures true.
  assert.equal(shouldPollUsage({ current: undefined, tabOn: true, hidden: false }), false, 'an unknown render is not a current one');
  assert.equal(shouldPollUsage({ current: true, tabOn: undefined, hidden: false }), false, 'an unknown tab is not an open one');
  assert.equal(shouldPollUsage({ current: true, tabOn: true, hidden: undefined }), true, 'an unstated visibility is not a claim of being away');
});

/* ------------------------------ one timer only ------------------------------ */

test('each render replaces the poll rather than stacking another one beside it', () => {
  const started = [];
  const cleared = [];
  let nextId = 1;
  const { watchAccountUsage } = load(
    ['USAGE_POLL_MS', 'shouldPollUsage', 'watchAccountUsage', 'refreshVisibleUsage'],
    ['watchAccountUsage'],
    {
      setInterval: (fn, ms) => { const id = nextId++; started.push({ id, fn, ms }); return id; },
      clearInterval: (id) => cleared.push(id),
      isCurrentRender: () => true,
      $: () => ({ classList: { contains: () => true } }),
    },
  );

  // renderAccounts runs again on every push from the main process, so this is the
  // ordinary case, not an edge one: without the clear, a machine left open all day
  // would accumulate a poller per refresh and ask once per render per minute.
  watchAccountUsage(1);
  watchAccountUsage(2);
  watchAccountUsage(3);

  assert.equal(started.length, 3, 'one poll per render');
  assert.deepEqual(started.map((s) => s.ms), [60000, 60000, 60000], 'a minute apart');
  assert.deepEqual(cleared.slice(1), [1, 2], 'each render stops the one before it');
});

/* -------------------------- which cards get re-read ------------------------- */

test('every drawn usage card is re-read, and a card holding the keyboard is left alone', () => {
  const { refreshVisibleUsage, document, createElement } = load(['refreshVisibleUsage'], ['refreshVisibleUsage']);
  const calls = [];
  const card = (name) => {
    const host = createElement('div');
    host.className = 'usage-content';
    host.refreshUsage = () => calls.push(name);
    return host;
  };

  const first = card('first');
  const second = card('second');
  const busy = card('busy');
  const button = createElement('button');
  busy.appendChild(button);
  document.activeElement = button;

  // A node in the panel that never registered a refresher (a tool with no usage
  // source) must be stepped over rather than thrown on.
  const plain = createElement('div');
  plain.className = 'usage-content';

  refreshVisibleUsage();
  assert.deepEqual(calls, ['first', 'second'], 'both idle cards read; the focused one is not torn out from under them');

  document.activeElement = null;
  refreshVisibleUsage();
  assert.deepEqual(calls, ['first', 'second', 'first', 'second', 'busy'], 'it is read again once the keyboard has moved on');
});

/* --------------------- the reading against the clock ------------------------ */

const USAGE_HELPERS = [
  'barClass', 'fmtAccountTime', 'setUsageSummary', 'showUsageState',
  'quotaProblemLabel', 'quotaSourceRow', 'renderUsageWindows',
];

function drawn(now) {
  const { renderUsageWindows, createElement } = load(USAGE_HELPERS, ['renderUsageWindows']);
  const host = createElement('div');
  const summary = createElement('span');
  const reading = {
    windows: [{ key: 'session', label: 'Session (5h)', usedPercent: 23, resetsAt: Date.parse('2026-08-31T17:49:00Z') }],
    source: 'token',
    vendor: 'Anthropic',
    observedAt: Date.parse('2026-08-31T16:51:00Z'),
  };
  assert.equal(renderUsageWindows(host, summary, reading, null, now), true);
  const metric = host.children[0].children[0];
  const line = metric.children.find((c) => String(c.className).startsWith('quota-reset'));
  assert.ok(line, 'the card states when the window turns over');
  return line;
}

test('a window still running says when it turns over', () => {
  const line = drawn(Date.parse('2026-08-31T16:51:00Z'));
  assert.ok(line.textContent.startsWith('Resets '), line.textContent);
  assert.equal(line.className, 'quota-reset', 'nothing to flag yet');
});

test('the same reading drawn after its window turned over says so, rather than reading as current', () => {
  // The exact case from 2026-08-31: a session window read at 12:51 and reset at 13:49,
  // still on screen at 14:18 showing the spent window's 23%.
  const line = drawn(Date.parse('2026-08-31T18:18:00Z'));
  assert.ok(line.textContent.startsWith('Reset time passed '), line.textContent);
  assert.match(line.textContent, /reading may be stale/);
  assert.equal(line.className, 'quota-reset past', 'and it is marked, not just worded differently');
});

test('the moment of drawing is the caller\'s to state, so the verdict cannot be frozen at first draw', () => {
  const before = drawn(Date.parse('2026-08-31T17:48:59Z'));
  const after = drawn(Date.parse('2026-08-31T17:49:01Z'));
  assert.notEqual(before.textContent, after.textContent, 'two seconds either side of the turnover read differently');
});
