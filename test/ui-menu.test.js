import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The row menu lives in the single-file UI, so there is nothing to import. These
 * tests lift the helpers out of index.html and run them against a DOM small enough
 * to read: enough of createElement, classList, append and querySelectorAll for the
 * split Launch control, and nothing more.
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
    if (sel === '.menu.open') return node.className.includes('menu') && node.classList.contains('open');
    if (sel === '[aria-expanded="true"]') return node.attrs['aria-expanded'] === 'true';
    throw new Error(`unsupported selector: ${sel}`);
  };
  const createElement = (tag) => {
    const node = {
      tag,
      className: '',
      innerHTML: '',
      title: '',
      attrs: {},
      children: [],
      parentElement: null,
      handlers: {},
      classList: {
        add: (c) => { if (!node.className.split(' ').includes(c)) node.className = `${node.className} ${c}`.trim(); },
        remove: (c) => { node.className = node.className.split(' ').filter((x) => x && x !== c).join(' '); },
        contains: (c) => node.className.split(' ').includes(c),
      },
      setAttribute: (k, v) => { node.attrs[k] = v; },
      getAttribute: (k) => node.attrs[k] ?? null,
      addEventListener: (ev, fn) => { (node.handlers[ev] ||= []).push(fn); },
      appendChild: (child) => { child.parentElement = node; node.children.push(child); return child; },
      append: (...kids) => kids.forEach((k) => node.appendChild(k)),
      querySelector: (sel) => node.children.find((c) => matches(c, sel)) ?? null,
      click: () => (node.handlers.click || []).forEach((fn) => fn({ stopPropagation() {} })),
    };
    all.push(node);
    return node;
  };
  const document = {
    createElement,
    querySelectorAll: (sel) => all.filter((n) => matches(n, sel)),
    addEventListener: () => {},
  };
  return { document, createElement };
}

/** Evaluate the lifted helpers against the stub DOM and hand back what the tests drive. */
function load() {
  const { document, createElement } = makeDom();
  const src = [lift('el'), lift('esc'), lift('attachMenu'), lift('closeMenus'), 'return { attachMenu, closeMenus };'].join('\n');
  const api = new Function('document', src)(document);
  return { ...api, document, row: () => createElement('div') };
}

test('a row with a main button gets one split control: button, caret, menu', () => {
  const { attachMenu, row } = load();
  const r = row();
  const launch = load().row();
  launch.className = 'btn primary';
  attachMenu(r, [{ label: 'Remove launcher', danger: true, onClick() {} }], launch);

  assert.equal(r.children.length, 1, 'the row holds the split control, not loose buttons');
  const split = r.children[0];
  assert.equal(split.className, 'split');
  assert.deepEqual(split.children.map((c) => c.className), ['btn primary', 'caret', 'menu']);
  assert.equal(split.children[1].innerHTML, '&#9662;', 'the toggle is a caret, not three dots');
  assert.equal(split.children[1].attrs['aria-haspopup'], 'true');
  assert.equal(split.children[2].children[0].className, 'danger');
});

test('a row with no main action keeps the "..." button', () => {
  const { attachMenu, row } = load();
  const r = row();
  attachMenu(r, [{ label: 'Uninstall', onClick() {} }]);
  assert.deepEqual(r.children.map((c) => c.className), ['kebab', 'menu']);
  assert.equal(r.children[0].innerHTML, '&#8943;');
});

test('the caret toggles its own menu and reports the state to screen readers', () => {
  const { attachMenu, row } = load();
  const r = row();
  const launch = load().row();
  attachMenu(r, [{ label: 'Reinstall', onClick() {} }], launch);
  const [, caret, menu] = r.children[0].children;

  assert.equal(menu.classList.contains('open'), false);
  caret.click();
  assert.equal(menu.classList.contains('open'), true);
  assert.equal(caret.attrs['aria-expanded'], 'true');
  caret.click();
  assert.equal(menu.classList.contains('open'), false, 'a second click closes it again');
  assert.equal(caret.attrs['aria-expanded'], 'false');
});

test('opening one row menu closes any other, and closeMenus clears them all', () => {
  const { attachMenu, closeMenus, row } = load();
  const rows = [row(), row()];
  for (const r of rows) attachMenu(r, [{ label: 'Uninstall', onClick() {} }], row());
  const carets = rows.map((r) => r.children[0].children[1]);
  const menus = rows.map((r) => r.children[0].children[2]);

  carets[0].click();
  carets[1].click();
  assert.deepEqual(menus.map((m) => m.classList.contains('open')), [false, true]);
  assert.equal(carets[0].attrs['aria-expanded'], 'false');

  closeMenus();
  assert.deepEqual(menus.map((m) => m.classList.contains('open')), [false, false]);
});

test('choosing an action closes the menu and runs it once', () => {
  const { attachMenu, row } = load();
  const r = row();
  let ran = 0;
  attachMenu(r, [{ label: 'Remove launcher', onClick: () => { ran += 1; } }], row());
  const [, caret, menu] = r.children[0].children;
  caret.click();
  menu.children[0].click();
  assert.equal(ran, 1);
  assert.equal(menu.classList.contains('open'), false);
});
