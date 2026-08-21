import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The Apps panel lives in the single-file UI, so there is nothing to import. These
 * tests lift the one decision the row makes out of index.html: which account the
 * Launch button opens on, and what the arrow beside it offers.
 */
const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'index.html'), 'utf8');

function lift(name) {
  const lines = HTML.split('\n');
  const start = lines.findIndex((l) => l.startsWith(`function ${name}(`));
  assert.ok(start >= 0, `found ${name} in index.html`);
  const end = lines.findIndex((l, i) => i > start && l === '}');
  assert.ok(end > start, `found the end of ${name}`);
  return lines.slice(start, end + 1).join('\n');
}

const appLaunchPlan = new Function(`${lift('appLaunchPlan')}\nreturn appLaunchPlan;`)();

const claudeDesktop = (profiles) => ({ id: 'claude-desktop', name: 'Claude Desktop', installed: true, supported: true, profiles });

test('an app with one login per machine keeps the plain button it always had', () => {
  const plan = appLaunchPlan({ id: 'lmstudio', name: 'LM Studio', installed: true });
  assert.equal(plan.openLabel, null, 'no account name is claimed where there are no accounts');
  assert.equal(plan.openDir, null, 'and no folder is named, so the launch is the one it always was');
  assert.deepEqual(plan.items, []);
});

test('the button names the account it opens, and the arrow holds the others', () => {
  const plan = appLaunchPlan(claudeDesktop([
    { dir: 'C:\\standard', label: 'Main Account', isDefault: true, isOpen: false, added: false },
    { dir: 'C:\\second', label: 'Secondary', isDefault: false, isOpen: true, added: false },
  ]));

  assert.equal(plan.openLabel, 'Secondary', 'the machine default is what the button opens');
  assert.equal(plan.openDir, 'C:\\second');
  assert.deepEqual(
    plan.items.map((i) => [i.kind, i.label]),
    [['open', 'Main Account'], ['open', 'Secondary'], ['add', 'Add another account…']],
  );
  assert.equal(plan.items[0].sub, 'C:\\standard', 'each account shows the folder it is kept in');
});

test('one account means nothing to choose between, but it is still named', () => {
  const plan = appLaunchPlan(claudeDesktop([
    { dir: 'C:\\standard', label: 'Main Account', isDefault: true, isOpen: true, added: false },
  ]));

  assert.equal(plan.openLabel, 'Main Account');
  assert.deepEqual(plan.items.map((i) => i.kind), ['add'], 'no list of one');
});

test('only a folder added by hand can be taken back off the list', () => {
  const plan = appLaunchPlan(claudeDesktop([
    { dir: 'C:\\standard', label: 'Main Account', isDefault: true, isOpen: true, added: false },
    { dir: 'D:\\profiles\\work', label: 'work', isDefault: false, isOpen: false, added: true },
  ]));

  const forget = plan.items.filter((i) => i.kind === 'forget');
  assert.deepEqual(forget.map((i) => i.label), ['Stop offering work']);
  assert.equal(forget[0].dir, 'D:\\profiles\\work');
});

test('an app whose accounts could not be worked out is never given a half-built menu', () => {
  const plan = appLaunchPlan({ id: 'claude-desktop', name: 'Claude Desktop', installed: true, supported: false, profiles: [] });
  assert.equal(plan.openLabel, null);
  assert.deepEqual(plan.items, []);
});
