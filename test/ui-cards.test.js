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
      style: {},
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
    badge: 'CURRENT',
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
  const { shelfSection } = load(['cardButton', 'shelfNote', 'shelfSection'], ['shelfSection']);
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
  const { shelfSection } = load(['cardButton', 'shelfNote', 'shelfSection'], ['shelfSection']);
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

/**
 * The account marked here is the one new terminals and newly launched tools will use, and
 * "default" read as "the one it came with" rather than "the one you switched to". These
 * assertions pin the words themselves, because nothing else in the suite renders them and a
 * copy change is exactly the kind of thing that slides back without anyone noticing.
 */
test('the marked account is named as the current one, not as a default', () => {
  assert.match(HTML, /badge: isDefault \? 'CURRENT' : null/, 'the badge names the current account');
  assert.match(HTML, /cardButton\('Switch to this'/, 'the button says what Switchboard does');
  assert.match(HTML, /`New sessions use: \$\{active\.label\}/, 'the section header says what the mark means');
  assert.doesNotMatch(HTML, /'DEFAULT'|Make default|Default for new sessions/, 'no default wording is left on the accounts page');
});

/**
 * Switching to an account nobody is signed into hands every new terminal a folder that
 * cannot run anything, and the usage watch already refuses to make such an account the
 * default by itself. These pin the two halves of that: what counts as a refusal, and
 * that a refused button really cannot act.
 */
test('a confirmed signed-out account cannot be made the default', () => {
  const { switchBlockedReason } = load(['switchBlockedReason'], ['switchBlockedReason']);
  assert.equal(
    switchBlockedReason('Main Account', { signedIn: false, detail: 'Not signed in' }),
    'Not signed in. Sign Main Account in before making it the default.',
  );
  assert.equal(
    switchBlockedReason('Main Account', { signedIn: false, detail: 'Claude is using API-key authentication, not this Claude subscription login' }),
    'Claude is using API-key authentication, not this Claude subscription login. Sign Main Account in before making it the default.',
    'the reason names what is actually wrong, not just "signed out"',
  );
});

test('a sign-in that could not be read still allows the switch', () => {
  const { switchBlockedReason } = load(['switchBlockedReason'], ['switchBlockedReason']);
  assert.equal(switchBlockedReason('Secondary', { signedIn: true, detail: 'Signed in' }), null);
  assert.equal(
    switchBlockedReason('Secondary', { signedIn: null, detail: 'Sign-in status unavailable' }),
    null,
    'an unreachable check is not evidence of being signed out',
  );
  assert.equal(switchBlockedReason('Secondary', undefined), null, 'nor is a card drawn before any reading arrived');
});

test('the account card puts that refusal on the switch button', () => {
  assert.match(HTML, /const blocked = switchBlockedReason\(a\.label, login\);/, 'the card asks before offering the switch');
  assert.match(HTML, /disabled: Boolean\(blocked\)/, 'a refused switch is disabled, not merely explained');
  assert.match(HTML, /title: blocked \?\?/, 'the reason becomes the hover text');
});

test('a disabled card button says why and cannot be clicked', () => {
  const { cardButton } = load(['cardButton'], ['cardButton']);
  let ran = 0;

  const live = cardButton('Switch to this', () => { ran += 1; }, { primary: true, title: 'Use Secondary for new Claude Code sessions' });
  live.click();
  assert.equal(ran, 1);
  assert.ok(!live.disabled, 'a usable button is left alone');

  const blocked = cardButton('Switch to this', () => { ran += 1; }, { primary: true, disabled: true, title: 'Not signed in. Sign Main Account in before making it the default.' });
  blocked.click();
  assert.equal(ran, 1, 'the handler never runs');
  assert.equal(blocked.disabled, true);
  assert.equal(blocked.title, 'Not signed in. Sign Main Account in before making it the default.', 'hovering it says why');
  assert.equal(blocked.className, 'btn primary', 'it stays the same button, only unusable');
});

// ---- A tool that is not on the machine ----

test('a tool that is not installed takes no section, whatever is registered for it', () => {
  const { splitToolsByPresence } = load(['splitToolsByPresence'], ['splitToolsByPresence']);
  // Installing a tool makes Switchboard register its folder, so uninstalling leaves an
  // account behind. That account kept an empty section alive, with every button inert.
  const providers = [{ id: 'qwen', name: 'Qwen Code', installed: false }];

  const { present, absent } = splitToolsByPresence(providers, [{ provider: 'qwen' }], [{ provider: 'qwen' }]);

  assert.deepEqual(present, []);
  assert.deepEqual(absent.map((p) => p.id), ['qwen']);
});

test('an installed tool with a registered account still gets its section', () => {
  const { splitToolsByPresence } = load(['splitToolsByPresence'], ['splitToolsByPresence']);
  const providers = [{ id: 'codex', name: 'Codex', installed: true }];
  const { present } = splitToolsByPresence(providers, [{ provider: 'codex' }], []);
  assert.deepEqual(present.map((p) => p.id), ['codex']);
});

test('a state payload with no installed flag behaves exactly as before', () => {
  const { splitToolsByPresence } = load(['splitToolsByPresence'], ['splitToolsByPresence']);
  const { present } = splitToolsByPresence(PROVIDERS, [], [{ provider: 'codex' }]);
  assert.deepEqual(present.map((p) => p.id), ['codex']);
});

test('the shelf accounts for registrations a hidden tool still holds', () => {
  const { shelfNote } = load(['shelfNote'], ['shelfNote']);
  const qwen = { id: 'qwen', name: 'Qwen Code' };

  assert.match(shelfNote(qwen, [{ provider: 'qwen' }]), /1 registered account, kept for when it is back/);
  assert.match(shelfNote(qwen, [{ provider: 'qwen' }, { provider: 'qwen' }]), /2 registered accounts/);
  assert.equal(shelfNote(qwen, []), null, 'nothing registered, nothing to say');
});

test('the shelf keeps a vendor note alongside what is registered', () => {
  const { shelfNote } = load(['shelfNote'], ['shelfNote']);
  const withNote = { id: 'gemini', name: 'Gemini CLI', note: 'Retired for personal accounts' };

  assert.equal(shelfNote(withNote, []), 'Retired for personal accounts');
  assert.match(shelfNote(withNote, [{ provider: 'gemini' }]), /1 registered account.*Retired for personal accounts/);
});

test('the section summary says what it can, without claiming anything about installs', () => {
  const { accountsSectionSummary } = load(['accountsSectionSummary'], ['accountsSectionSummary']);

  assert.equal(accountsSectionSummary(1, 0, { label: 'Main' }), 'New sessions use: Main · 1 account');
  assert.equal(accountsSectionSummary(2, 0, null), '2 accounts · the folder in use is not registered');
  assert.equal(accountsSectionSummary(0, 1, null), '1 folder found, none registered yet');
});
