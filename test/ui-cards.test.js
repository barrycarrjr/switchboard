import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The interface lives in one HTML file, so there is nothing to import. These tests lift
 * its card helpers out of index.html and run them against a DOM small enough to read.
 * What they protect is the promise the pages make together: one card shape for every
 * account, lane and settings block, and a section only for the tools this machine has.
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
  const createElement = (tag) => {
    const node = {
      tag,
      className: '',
      innerHTML: '',
      textContent: '',
      title: '',
      attrs: {},
      children: [],
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
      appendChild: (child) => { node.children.push(child); return child; },
      replaceChildren: (...kids) => { node.children = kids; },
      click: () => (node.handlers.click || []).forEach((fn) => fn({})),
    };
    return node;
  };
  return { document: { createElement, createTextNode: (text) => ({ tag: '#text', textContent: text, className: '' }) } };
}

function load(names, exports) {
  const { document } = makeDom();
  const src = [lift('el'), lift('esc'), ...names.map(lift), `return { ${exports.join(', ')} };`].join('\n');
  return new Function('document', src)(document);
}

const PROVIDERS = [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }, { id: 'gemini', name: 'Gemini CLI' }];

test('a tool with a registered account gets its own section', () => {
  const { splitToolsByPresence } = load(['splitToolsByPresence'], ['splitToolsByPresence']);
  const { present, absent } = splitToolsByPresence(PROVIDERS, [{ provider: 'claude' }], []);
  assert.deepEqual(present.map((p) => p.id), ['claude']);
  assert.deepEqual(absent.map((p) => p.id), ['codex', 'gemini']);
});

test('a signed-in folder waiting to be registered counts as having the tool', () => {
  const { splitToolsByPresence } = load(['splitToolsByPresence'], ['splitToolsByPresence']);
  const { present, absent } = splitToolsByPresence(PROVIDERS, [], [{ provider: 'codex' }]);
  assert.deepEqual(present.map((p) => p.id), ['codex']);
  assert.deepEqual(absent.map((p) => p.id), ['claude', 'gemini']);
});

test('a tool you do not have never takes a section, and nothing is lost', () => {
  const { splitToolsByPresence } = load(['splitToolsByPresence'], ['splitToolsByPresence']);
  const { present, absent } = splitToolsByPresence(PROVIDERS, [], []);
  assert.deepEqual(present, []);
  assert.deepEqual(absent.map((p) => p.id), ['claude', 'codex', 'gemini'], 'still offered, in order, behind the shelf');
});

test('an account and a vendor-managed tool build the same card', () => {
  const { cardShell, cardSignIn } = load(['cardArea', 'cardShell', 'cardSignIn'], ['cardShell', 'cardSignIn']);

  const account = cardShell({
    titleId: 'account-claude-1',
    title: 'Main Account',
    badge: 'DEFAULT',
    person: 'account owner · max plan',
    folder: 'D:\\profiles\\one\\.claude',
    accent: true,
  });
  cardSignIn(account.card, { signedIn: true, detail: 'Signed in', note: 'Status checked by Claude Code' });

  const tool = cardShell({
    titleId: 'account-tool-copilot',
    title: 'Copilot CLI',
    person: 'GitHub account · the signed-in user',
  });
  cardSignIn(tool.card, { signedIn: false, detail: 'Not signed in', note: 'CLI installed' });

  assert.equal(account.card.tag, tool.card.tag, 'the same element');
  assert.equal(account.card.className, 'acct account-card is-default');
  assert.equal(tool.card.className, 'acct account-card', 'no accent, but the same card');
  for (const built of [account, tool]) {
    assert.equal(built.card.children.length, 2, 'a head and a sign-in area, in that order');
    assert.equal(built.card.children[0].className, 'account-head');
  }
  assert.equal(account.card.children[1].className, 'account-area signin-area');
  assert.equal(tool.card.children[1].className, 'account-area signin-area warn', 'a signed-out tool is flagged like a signed-out account');

  const [accountHead, toolHead] = [account.card.children[0], tool.card.children[0]];
  assert.deepEqual(accountHead.children.map((c) => c.className), ['account-identity', 'account-actions']);
  assert.deepEqual(toolHead.children.map((c) => c.className), ['account-identity', 'account-actions']);
  assert.deepEqual(
    accountHead.children[0].children.map((c) => c.className),
    ['account-title', 'account-person', 'account-path'],
  );
  assert.deepEqual(
    toolHead.children[0].children.map((c) => c.className),
    ['account-title', 'account-person'],
    'a tool with no folder to open simply omits that line',
  );
});

test('an unregistered folder is offered as the same card, with Register on it', () => {
  const { candidateCard } = load(
    ['setUsageSummary', 'showUsageState', 'cardArea', 'cardShell', 'cardButton', 'cardUsage', 'candidateCard'],
    ['candidateCard'],
  );
  const card = candidateCard({ provider: 'claude', label: 'work', home: 'D:\\profiles\\work\\.claude' });
  assert.equal(card.className, 'acct account-card');
  const [head, usage] = card.children;
  assert.deepEqual(head.children[1].children.map((b) => b.innerHTML), ['Register']);
  assert.deepEqual(
    head.children[0].children.map((c) => c.className),
    ['account-title', 'account-path'],
    'a folder nobody has registered has no person to name yet',
  );
  assert.equal(usage.className, 'account-area usage-area');
  assert.equal(usage.children[1].children[0].className, 'usage-state');
});

test('the shelf lists only the tools you do not have, and the button opens it', () => {
  const { shelfSection } = load(['cardButton', 'shelfSection'], ['shelfSection']);
  const section = shelfSection([{ id: 'qwen', name: 'Qwen Code', note: 'Signs in with Qwen OAuth.' }], false);
  const [toggle, list] = section.children;

  assert.equal(toggle.innerHTML, '+ Add another tool');
  assert.equal(toggle.attrs['aria-expanded'], 'false');
  assert.equal(list.className, 'tool-shelf', 'closed until asked for');
  assert.deepEqual(list.children.map((row) => row.children[0].children[0].innerHTML), ['Qwen Code']);
  assert.equal(list.children[0].children[0].children[1].innerHTML, 'Signs in with Qwen OAuth.');

  toggle.click();
  assert.equal(list.classList.contains('open'), true);
  assert.equal(toggle.attrs['aria-expanded'], 'true');
  assert.equal(toggle.textContent, 'Hide other tools');
  toggle.click();
  assert.equal(list.classList.contains('open'), false);
  assert.equal(toggle.attrs['aria-expanded'], 'false');
});

test('with nothing registered the shelf opens itself, because it is the whole page', () => {
  const { shelfSection } = load(['cardButton', 'shelfSection'], ['shelfSection']);
  const [toggle, list] = shelfSection([{ id: 'claude', name: 'Claude Code', note: null }], true).children;
  assert.equal(list.classList.contains('open'), true);
  assert.equal(toggle.innerHTML, 'Hide other tools');
  assert.equal(toggle.attrs['aria-expanded'], 'true');
});

test('the usage area is present on every card, filled or not', () => {
  const { cardShell, cardUsage } = load(['cardArea', 'cardShell', 'cardUsage'], ['cardShell', 'cardUsage']);
  const { card } = cardShell({ titleId: 'account-tool-junie', title: 'Junie' });
  const { summary, content } = cardUsage(card);
  assert.equal(card.children[1].className, 'account-area usage-area');
  assert.equal(summary.className, 'usage-summary');
  assert.equal(content.attrs['aria-live'], 'polite');
});

test('a card carries as many labelled areas as the thing it describes has', () => {
  const { cardShell, cardArea, cardNote } = load(['cardArea', 'cardNote', 'cardShell'], ['cardShell', 'cardArea', 'cardNote']);
  const { card } = cardShell({ titleId: 'about-config', title: 'Switchboard configuration' });
  cardNote(card, 'What is included', 'Folder paths, never tokens.');
  const { area } = cardArea(card, 'Updates', 'note-area');
  area.appendChild({ tag: 'div', className: 'qnote', children: [] });

  assert.deepEqual(card.children.map((c) => c.className), [
    'account-head',
    'account-area note-area',
    'account-area note-area',
  ]);
  const [, included] = card.children;
  assert.equal(included.children[0].children[0].innerHTML, 'What is included', 'the area names itself');
  assert.equal(included.children[1].className, 'qnote');
});

test('a lane is the same card as the account it points at', () => {
  const { laneCard } = load(
    ['cardArea', 'cardShell', 'cardButton', 'laneCard'],
    ['laneCard'],
  );
  const lane = { id: 'lane-1', provider: 'anthropic', harness: 'claude', accountId: 'claude-1', billing: 'subscription' };
  const card = laneCard(lane, { id: 'claude-1', label: 'Main Account' }, { onRemove() {} });

  assert.equal(card.className, 'acct account-card');
  const [head, billing] = card.children;
  assert.equal(head.children[0].children[0].children[0].innerHTML, 'Main Account');
  assert.equal(head.children[0].children[1].innerHTML, 'anthropic via claude');
  assert.deepEqual(head.children[1].children.map((b) => b.innerHTML), ['Remove'], 'no budget button on a subscription lane');
  assert.equal(billing.className, 'account-area note-area');
  assert.equal(billing.children[1].children[0].innerHTML, 'Subscription');
});

test('a metered lane with no budget says so, and offers the button that fixes it', () => {
  const { laneCard } = load(['cardArea', 'cardShell', 'cardButton', 'laneCard'], ['laneCard']);
  const lane = { id: 'lane-2', provider: 'openai', harness: 'codex', accountId: 'codex-1', billing: 'metered' };
  const card = laneCard(lane, { id: 'codex-1', label: 'Work' }, { budget: null, onSetBudget() {}, onRemove() {} });

  const [head, billing] = card.children;
  assert.deepEqual(head.children[1].children.map((b) => b.innerHTML), ['Set budget', 'Remove']);
  assert.equal(billing.className, 'account-area note-area warn', 'a lane that cannot be chosen is tinted');
  const chip = billing.children[1].children[1];
  assert.equal(chip.className, 'chip bad');
  assert.equal(chip.innerHTML, 'No budget set, so this lane is blocked');
});

test('a lane whose account was unregistered says what is wrong instead of showing a blank', () => {
  const { laneCard } = load(['cardArea', 'cardShell', 'cardButton', 'laneCard'], ['laneCard']);
  const lane = { id: 'lane-3', provider: 'anthropic', harness: 'claude', accountId: 'gone', billing: 'subscription' };
  const card = laneCard(lane, undefined, { onRemove() {} });
  assert.equal(card.children[0].children[0].children[0].children[0].innerHTML, 'Account missing');
  assert.match(card.children[1].children[2].innerHTML, /no longer registered/);
  assert.equal(card.children[1].className, 'account-area note-area warn');
});
