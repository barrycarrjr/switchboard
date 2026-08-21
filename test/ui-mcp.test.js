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

const rowParts = ['MARK', 'MCP_CHIP', 'mcpWhyNotAddable', 'mcpChip', 'mcpRow'];
const loadRow = () => load(rowParts, ['mcpRow', 'mcpChip', 'mcpWhyNotAddable']);

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
// addresses and nothing else, so anything else has to be set up inside the client.
test('a server Switchboard cannot write is greyed out with the reason', () => {
  const { mcpChip } = loadRow();
  const local = mcpChip({ name: 'unifi-home', command: 'D:\\tools\\unifi.exe', addable: false, state: {} }, CLIENTS[0], () => {});
  assert.equal(local.disabled, true);
  assert.equal(local.title, 'unifi-home is a program the client starts itself, so it has to be set up inside Claude Code.');

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
