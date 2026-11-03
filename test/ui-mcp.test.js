import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The MCP panel lives in the single-file UI, so there is nothing to import. These tests
 * lift its row and chip builders out of index.html and run them against a DOM small
 * enough to read. What they protect is the promise the panel makes: a row says what the
 * server actually is, and a button is offered only when pressing it can work.
 */
const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'), 'utf8');

/** Pull one top-level const (single line or block) or function out of the page. */
function lift(name) {
  const lines = HTML.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`const ${name} = `) || l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `found ${name} in index.html`);
  if (lines[start].startsWith('const ') && lines[start].trimEnd().endsWith(';')) return lines[start];
  const closer = lines[start].startsWith('const ') ? '};' : '}';
  const end = lines.findIndex((l, i) => i > start && l === closer);
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
      disabled: false,
      attrs: {},
      children: [],
      handlers: {},
      setAttribute: (k, v) => { node.attrs[k] = v; },
      addEventListener: (ev, fn) => { (node.handlers[ev] ||= []).push(fn); },
      appendChild: (child) => { node.children.push(child); return child; },
      replaceChildren: (...kids) => { node.children = kids; },
    };
    return node;
  };
  return { document: { createElement } };
}

function load(names, exports) {
  const { document } = makeDom();
  const src = [lift('el'), lift('esc'), ...names.map(lift), `return { ${exports.join(', ')} };`].join('\n');
  return new Function('document', src)(document);
}

const CLIENTS = [
  { id: 'claude', name: 'Claude Code', canRemove: true },
  { id: 'codex', name: 'Codex', canRemove: true },
];

const rowParts = ['MARK', 'MCP_CHIP', 'mcpStillOn', 'mcpWhyNotAddable', 'mcpRemoveQuestion', 'mcpDisableQuestion', 'mcpClientNames', 'mcpError', 'mcpToggle', 'mcpChip', 'mcpProviderControl', 'mcpRow'];
const loadRow = () => load(rowParts, ['mcpRow', 'mcpChip', 'mcpProviderControl', 'mcpWhyNotAddable', 'mcpToggle', 'mcpClientNames', 'mcpDisableQuestion', 'mcpRemoveQuestion']);

/** The words a row shows, buttons included. */
function readRow(row) {
  const text = row.children.map((c) => c.innerHTML || '').join(' ');
  const buttons = row.children.filter((c) => c.tag === 'button');
  return { text, buttons };
}

test('a server found in a client config says what it runs, not "undefined"', () => {
  const { mcpRow } = loadRow();
  const row = mcpRow({ name: 'unifi-home', command: 'D:\\tools\\unifi.exe', addable: false, state: {} }, CLIENTS, () => {});
  const { text } = readRow(row);
  assert.ok(text.includes('unifi-home'), 'the name is shown');
  assert.ok(text.includes('Started by the client: D:\\tools\\unifi.exe'), 'and the program the client starts');
  assert.ok(!text.includes('undefined'), 'a missing address is never printed as undefined');
});

test('a remote server shows its address when the catalogue has no description', () => {
  const { mcpRow } = loadRow();
  const row = mcpRow({ name: 'phpstorm', url: 'http://127.0.0.1:64410/stream', addable: false, state: {} }, CLIENTS, () => {});
  assert.ok(readRow(row).text.includes('http://127.0.0.1:64410/stream'));
});

test('a description is preferred over the raw address', () => {
  const { mcpRow } = loadRow();
  const row = mcpRow({ name: 'sentry', url: 'https://mcp.sentry.dev/mcp', description: 'Error tracking', addable: true, state: {} }, CLIENTS, () => {});
  const { text } = readRow(row);
  assert.ok(text.includes('Error tracking'));
  assert.ok(!text.includes('https://mcp.sentry.dev/mcp'), 'the url would only crowd the line');
});

test('browse marks a suggestion as suggested, above its own category', () => {
  const { mcpRow } = loadRow();
  const server = { name: 'linear', url: 'https://mcp.linear.app/mcp', description: 'Track issues', category: 'productivity', featured: true, addable: true, state: {} };
  const browse = readRow(mcpRow(server, CLIENTS, () => {}, { showCategory: true })).text;
  assert.ok(browse.includes('suggested'), 'so the order at the top of the list is explained');
  assert.ok(browse.includes('productivity'), 'without losing its real category');

  const active = readRow(mcpRow(server, CLIENTS, () => {})).text;
  assert.ok(!active.includes('suggested'), 'the active list is not a place for advertising');
});

test('a chip is offered for a client that does not have the server yet', () => {
  const { mcpChip } = loadRow();
  const chip = mcpChip({ name: 'sentry', url: 'https://mcp.sentry.dev/mcp', addable: true, state: {} }, CLIENTS[0], () => {});
  assert.equal(chip.disabled, false);
  assert.ok(chip.innerHTML.includes('Claude Code'));
  assert.equal(chip.title, 'Add sentry to Claude Code');
});

test('a registered chip says it can be clicked to remove', () => {
  const { mcpChip } = loadRow();
  const chip = mcpChip({ name: 'sentry', url: 'https://mcp.sentry.dev/mcp', addable: true, state: { claude: 'ready' } }, CLIENTS[0], () => {});
  assert.equal(chip.attrs['aria-pressed'], 'true');
  assert.ok(chip.title.includes('Click to remove.'), 'removing is a click, and the row has to say so');
});

// A button that can only fail is worse than a greyed one: Switchboard writes remote https
// addresses, and local commands that pass its checks, so anything else has to be set up
// inside the client.
test('a server Switchboard cannot write is greyed out with the reason', () => {
  const { mcpChip } = loadRow();
  const local = mcpChip({ name: 'unifi-home', command: 'D:\\tools\\unifi.exe & more', addable: false, state: {} }, CLIENTS[0], () => {});
  assert.equal(local.disabled, true);
  assert.equal(local.title, 'unifi-home starts a program with characters Switchboard will not put on a command line, so it has to be set up inside Claude Code.');

  const named = mcpChip({ name: 'MCP_DOCKER', command: 'docker', addable: false, state: {} }, CLIENTS[0], () => {});
  assert.equal(named.title, 'MCP_DOCKER has a name Switchboard does not copy between clients (lowercase letters, digits and hyphens only), so it has to be set up inside Claude Code.',
    'blaming the command would send someone to fix the wrong thing');

  const loopback = mcpChip({ name: 'phpstorm', url: 'http://127.0.0.1:64410/stream', addable: false, state: {} }, CLIENTS[1], () => {});
  assert.equal(loopback.disabled, true);
  assert.equal(loopback.title, 'Switchboard adds remote https servers only, so phpstorm has to be set up inside Codex.');
});

test('a server that cannot work in a client keeps saying so, ahead of anything else', () => {
  const { mcpChip } = loadRow();
  const chip = mcpChip({
    name: 'slack',
    url: 'https://mcp.slack.com/mcp',
    only: ['claude'],
    caveat: 'Only clients Slack has pre-registered can sign in. Others cannot use it at all.',
    addable: true,
    state: {},
  }, CLIENTS[1], () => {});
  assert.equal(chip.disabled, true);
  assert.ok(chip.title.includes('pre-registered'));
});

test('Forget is offered only for a server added by hand', () => {
  const { mcpRow } = loadRow();
  const server = { name: 'my-tracker', url: 'https://mcp.example.com/mcp', addable: true, state: {} };
  const mine = readRow(mcpRow(server, CLIENTS, () => {}, { forgettable: true }));
  assert.ok(mine.buttons.some((b) => b.innerHTML === 'Forget'));

  const theirs = readRow(mcpRow(server, CLIENTS, () => {}));
  assert.ok(!theirs.buttons.some((b) => b.innerHTML === 'Forget'), 'nothing to forget for a catalogue entry');
});

// Removing a server that Switchboard could not have added is a one-way door: it has no
// address to register, so it exists only because the client itself was set up with it.
test('removing a server that cannot be put back says so', () => {
  const { mcpRemoveQuestion } = load([...rowParts, 'mcpRemoveQuestion'], ['mcpRemoveQuestion']);
  const oneWay = mcpRemoveQuestion({ name: 'unifi-home', command: 'D:\\tools\\unifi.exe', addable: false }, CLIENTS[0]);
  assert.ok(oneWay.includes('Remove "unifi-home" from Claude Code?'));
  assert.ok(oneWay.includes('cannot put it back'), 'the part that stops a click being regretted');

  const ordinary = mcpRemoveQuestion({ name: 'sentry', url: 'https://mcp.sentry.dev/mcp', addable: true }, CLIENTS[0]);
  assert.equal(ordinary, 'Remove "sentry" from Claude Code?', 'nothing extra when it can simply be added again');
});

// ---- Switching a whole server off from its mark ----
//
// Unchecking client by client is a click each, and for a server the client starts itself
// there is nothing to uncheck at all: those buttons are greyed because Switchboard could
// never put such a server back. The mark at the left of the row is the switch for the
// whole server, and it is only a switch where pressing it can do something.

test('the mark on an active row is a switch, and says which way it is set', () => {
  const { mcpRow } = loadRow();
  const row = mcpRow({ name: 'MCP_DOCKER', command: 'docker', addable: false, state: { claude: 'on' } }, CLIENTS, () => {}, { togglable: true });
  const mark = row.children[0];
  assert.equal(mark.tag, 'button');
  assert.equal(mark.attrs['aria-pressed'], 'true');
  assert.ok(mark.title.includes('off in every client'), 'so a click is not a surprise');
});

test('a switched-off row can be switched back on, and says where it will go', () => {
  const { mcpRow } = loadRow();
  const row = mcpRow({
    name: 'MCP_DOCKER',
    command: 'docker',
    disabled: true,
    disabledClients: ['claude', 'codex'],
    addable: false,
    state: {},
  }, CLIENTS, () => {}, { togglable: true });
  const mark = row.children[0];
  assert.equal(mark.tag, 'button');
  assert.equal(mark.attrs['aria-pressed'], 'false');
  assert.ok(mark.title.includes('back on'));
  assert.ok(row.className.includes('off'), 'and it does not look like a running server');
  const text = row.children.map((c) => c.innerHTML || '').join(' ');
  assert.ok(text.includes('Switched off'), 'an off row must not read as one that was never switched on');
  assert.ok(text.includes('Claude Code and Codex'), 'named by the buttons they are on');
});

// Switched off here, then put back into a client by some other route. Greyed out, the row
// would say the server is quiet while a client is still loading it.
test('a row switched off here but still on in a client says so instead of looking off', () => {
  const { mcpRow } = loadRow();
  const row = mcpRow({
    name: 'home-assistant',
    command: 'uvx',
    disabled: true,
    disabledClients: ['claude'],
    addable: true,
    state: { claude: 'on-despite-disabled', codex: 'off' },
  }, CLIENTS, () => {}, { togglable: true });
  assert.ok(!row.className.includes('off'), 'it is not shown as a quiet server');
  assert.ok(row.className.includes('warn'));
  const text = row.children.map((c) => c.innerHTML || '').join(' ');
  assert.ok(text.includes('Switched off here, but still on in Claude Code'), 'naming the client that still has it');
  const mark = row.children[0];
  assert.equal(mark.tag, 'button');
  assert.ok(mark.title.includes('back on in every client'), 'and the mark says what pressing it will do');
});

test('the mark stays a plain mark where there is nothing to switch', () => {
  const { mcpRow } = loadRow();
  const browse = mcpRow({ name: 'sentry', url: 'https://mcp.sentry.dev/mcp', addable: true, state: { claude: 'ready' } }, CLIENTS, () => {});
  assert.equal(browse.children[0].tag, 'div', 'the browse list switches nothing off');

  const unused = mcpRow({ name: 'sentry', url: 'https://mcp.sentry.dev/mcp', addable: true, state: {} }, CLIENTS, () => {}, { togglable: true });
  assert.equal(unused.children[0].tag, 'div', 'a server no client has is already off');
});

test('the question before switching off says it can be switched back on', () => {
  const { mcpDisableQuestion } = loadRow();
  const asked = mcpDisableQuestion({ name: 'MCP_DOCKER' });
  assert.ok(asked.includes('Switch "MCP_DOCKER" off in every client?'));
  assert.ok(asked.includes('switched back on'), 'the part that makes it a decision rather than a gamble');
});

test('client ids are reported as the names on their buttons', () => {
  const { mcpClientNames } = loadRow();
  assert.equal(mcpClientNames(['claude'], CLIENTS), 'Claude Code');
  assert.equal(mcpClientNames(['claude', 'codex'], CLIENTS), 'Claude Code and Codex');
  assert.equal(mcpClientNames([], CLIENTS), '');
  assert.equal(mcpClientNames(['junie'], CLIENTS), 'junie', 'a client that is not here is still named, not dropped');
});

test('the add form sends an https address as a remote server and anything else as a local command', () => {
  const mcpAddPayload = new Function(`${lift('mcpAddPayload')}\nreturn mcpAddPayload;`)();
  assert.deepEqual(mcpAddPayload(' tracker ', ' https://mcp.example.com/mcp ', ''), { name: 'tracker', url: 'https://mcp.example.com/mcp', label: 'tracker' });
  assert.deepEqual(mcpAddPayload('workspace', 'node', '  server.mjs   --port 3000 '), { name: 'workspace', command: 'node', args: ['server.mjs', '--port', '3000'], label: 'workspace' });
  assert.deepEqual(mcpAddPayload('bare', 'node', ''), { name: 'bare', command: 'node', args: [], label: 'bare' });
  assert.deepEqual(mcpAddPayload('empty', '', ''), { name: 'empty', url: '', label: 'empty' }, 'nothing typed is reported as a missing address');
});

test('mcpRow displays discovered toolCount when present', () => {
  const { mcpRow } = loadRow();
  const row = mcpRow({ name: 'home-assistant', url: 'https://ha.example.com/api/mcp', toolCount: 72, addable: true, state: { claude: 'ready' } }, CLIENTS, () => {});
  assert.ok(readRow(row).text.includes('72 tools'));
});

test('customizationSkillRow and customizationMarketplaceRow render compact provider popover and rich marketplace cards', () => {
  const custParts = [...rowParts, 'customizationClientChip', 'customizationProviderControl', 'customizationSkillRow', 'marketplaceSourceLabel', 'customizationMarketplaceRow'];
  const { customizationSkillRow, customizationMarketplaceRow } = load(custParts, ['customizationSkillRow', 'customizationMarketplaceRow']);
  const dynClients = [
    { id: 'claude', name: 'Claude Code', accountCount: 2 },
    { id: 'grok', name: 'Grok CLI', accountCount: 1 },
  ];
  const skillRow = customizationSkillRow(
    { name: 'frontend-design', title: 'Frontend Design', description: 'UI polish', state: { claude: 'on', grok: 'off' } },
    dynClients,
    () => {},
  );
  const skillOut = readRow(skillRow);
  assert.ok(skillOut.text.includes('/frontend-design'));
  const targetsWrap = skillRow.children[2];
  assert.equal(targetsWrap.className, 'cust-targets');
  assert.ok(targetsWrap.children[0].innerHTML.includes('Claude Code*2'));
  const popWrap = targetsWrap.children[1];
  assert.ok(popWrap.children[0].innerHTML.includes('Providers (1/2)'));

  const mktCard = customizationMarketplaceRow({
    name: 'chrome-devtools-plugin',
    title: 'Chrome DevTools',
    kind: 'plugin',
    featured: true,
    sources: ['google', 'anthropic'],
    category: 'browser',
    description: 'Live Chrome inspection.',
  }, () => {});
  assert.ok(mktCard.className.includes('mkt-card'));
  const foot = mktCard.children[mktCard.children.length - 1];
  assert.equal(foot.children[0].innerHTML, 'Install');
  assert.equal(foot.children[1].innerHTML, 'Details');
});

