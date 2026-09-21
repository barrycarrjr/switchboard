import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'), 'utf8');

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
        toggle: (c, on) => {
          const has = node.className.split(' ').includes(c);
          const next = on !== undefined ? on : !has;
          if (next) node.classList.add(c);
          else node.classList.remove(c);
          return next;
        },
      },
      setAttribute: (k, v) => { node.attrs[k] = v; },
      getAttribute: (k) => node.attrs[k] ?? null,
      addEventListener: (ev, fn) => { (node.handlers[ev] ||= []).push(fn); },
      appendChild: (child) => { node.children.push(child); return child; },
      replaceChildren: (...kids) => { node.children = kids; },
      click: () => (node.handlers.click || []).forEach((fn) => fn({ target: node, stopPropagation: () => {}, preventDefault: () => {} })),
      closest: (sel) => null,
      querySelector: (sel) => {
        if (sel === '.account-head-toggle') {
          return node.children.find((c) => c.className === 'account-title')?.children.find((c) => c.className === 'account-head-toggle');
        }
        return null;
      },
    };
    return node;
  };
  const document = {
    createElement,
    createTextNode: (text) => ({ tag: '#text', textContent: text, className: '' }),
  };
  return { document, createElement };
}

function load(deps, returns) {
  const src = [...deps.map(lift), `return { ${returns.join(', ')} };`].join('\n\n');
  const { document, createElement } = makeDom();
  const api = new Function('document', 'el', 'esc', src)(
    document,
    (tag, cls, html) => {
      const n = createElement(tag);
      if (cls) n.className = cls;
      if (html != null) {
        n.innerHTML = html;
        n.textContent = html;
      }
      return n;
    },
    (s) => String(s ?? ''),
  );
  return { ...api, document, createElement };
}

test('updateAccountBar renders a single visual bar with remaining percentage', () => {
  const { updateAccountBar, createElement } = load(['updateAccountBar'], ['updateAccountBar']);
  const barEl = createElement('div');

  const reading = {
    windows: [
      { key: 'session', label: 'Session (5h)', usedPercent: 29 },
      { key: 'week', label: 'Week (all models)', usedPercent: 10 },
    ],
  };

  updateAccountBar(barEl, reading);
  assert.equal(barEl.style.display, 'block');
  assert.equal(barEl.title, '71% left (29% used on Session (5h))');

  const head = barEl.children[0];
  const bar = barEl.children[1];
  assert.equal(head.className, 'account-meter-head');
  assert.equal(head.children[0].className, 'account-meter-left good');
  assert.equal(head.children[0].children[0].textContent, '71%');
  assert.match(head.children[1].textContent, /29% used/);

  assert.equal(bar.attrs['role'], 'progressbar');
  assert.equal(bar.attrs['aria-valuenow'], '71');
  assert.equal(bar.attrs['aria-label'], '71% left');
  assert.equal(bar.children[0].style.width, '71%');
});

test('updateAccountBar shows warn tone when <= 30% left and hot tone when <= 10% left', () => {
  const { updateAccountBar, createElement } = load(['updateAccountBar'], ['updateAccountBar']);
  const barEl = createElement('div');

  // 80% used -> 20% left -> warn
  updateAccountBar(barEl, {
    windows: [{ key: 'session', label: 'Session (5h)', usedPercent: 80 }],
  });
  assert.equal(barEl.children[0].children[0].className, 'account-meter-left warn');
  assert.equal(barEl.children[1].className, 'bar quota-bar warn');
  assert.equal(barEl.children[1].children[0].style.width, '20%');

  // 96% used -> 4% left -> hot
  updateAccountBar(barEl, {
    windows: [{ key: 'session', label: 'Session (5h)', usedPercent: 96 }],
  });
  assert.equal(barEl.children[0].children[0].className, 'account-meter-left hot');
  assert.equal(barEl.children[1].className, 'bar quota-bar hot');
  assert.equal(barEl.children[1].children[0].style.width, '4%');
});

test('updateAccountBar hides bar when no windows report percentage', () => {
  const { updateAccountBar, createElement } = load(['updateAccountBar'], ['updateAccountBar']);
  const barEl = createElement('div');

  updateAccountBar(barEl, { windows: [] });
  assert.equal(barEl.style.display, 'none');

  updateAccountBar(barEl, null);
  assert.equal(barEl.style.display, 'none');
});

test('cardShell includes toggle button and toggles compact mode on header click', () => {
  const { cardShell } = load(['cardShell'], ['cardShell']);
  const { card } = cardShell({ titleId: 'acct-1', title: 'Work', person: 'Work Profile' });
  const head = card.children[0];
  const identity = head.children[0];
  const titleRow = identity.children[0];
  const tog = titleRow.children.find((c) => c.className === 'account-head-toggle');

  assert.ok(tog, 'toggle button exists in title row');
  assert.equal(tog.innerHTML, '&#9662;');

  // Toggle via tog click
  tog.click();
  assert.ok(card.classList.contains('compact'), 'card is now compact');
  assert.equal(tog.innerHTML, '&#9656;');

  tog.click();
  assert.equal(card.classList.contains('compact'), false, 'card is expanded again');
  assert.equal(tog.innerHTML, '&#9662;');
});

test('CSS rules hide account-path when compact and when account has person line', () => {
  assert.match(HTML, /\.account-card\.compact \.account-path\{display:none\}/);
  assert.match(HTML, /\.account-person \+ \.account-path\{display:none\}/);
  assert.match(HTML, /\.account-meter\{/);
});
