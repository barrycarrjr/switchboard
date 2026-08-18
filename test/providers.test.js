import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS, detectTool, uninstallCmdFor } from '../core/providers.js';

test('tool table invariants: unique ids, vendor sites, vendor install commands or honest notes', () => {
  const ids = TOOLS.map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const t of TOOLS) {
    assert.ok(t.name, `${t.id} has a name`);
    assert.ok(t.bin || t.appPaths, `${t.id} is detectable`);
    assert.match(t.url, /^https:\/\//, `${t.id} has a vendor site`);
    if (t.install.via === 'manual') {
      assert.match(t.install.url, /^https:\/\//, `${t.id} links to the vendor over https`);
      assert.equal(t.install.cmd, undefined, `${t.id} manual entries carry no command`);
      assert.ok(t.note, `${t.id} explains why there is no install button`);
    } else if (t.install.via === 'vendor') {
      // A vendor bootstrap script must come from the vendor's own https domain.
      const host = new URL(t.url).host;
      assert.match(t.install.cmd, new RegExp(`^irm https://${host.replace(/\./g, '\\.')}/`), `${t.id} bootstraps only from ${host}`);
    } else {
      assert.match(t.install.cmd, /^(winget|npm|python) /, `${t.id} delegates to a vendor mechanism`);
    }
  }
});

test('installCmdFor derives every lifecycle command from the one table entry', async () => {
  const { installCmdFor } = await import('../core/providers.js');
  const winget = { install: { via: 'winget', cmd: 'winget install --id Vendor.Tool -e' } };
  assert.equal(installCmdFor(winget, 'install'), 'winget install --id Vendor.Tool -e');
  assert.equal(installCmdFor(winget, 'update'), 'winget upgrade --id Vendor.Tool -e');
  assert.equal(installCmdFor(winget, 'reinstall'), 'winget install --id Vendor.Tool -e --force');
  assert.equal(installCmdFor(winget, 'uninstall'), 'winget uninstall --id Vendor.Tool');
  const npm = { install: { via: 'npm', cmd: 'npm install -g @scope/pkg' } };
  assert.equal(installCmdFor(npm, 'update'), 'npm install -g @scope/pkg');
  assert.equal(installCmdFor(npm, 'reinstall'), 'npm install -g @scope/pkg');
  assert.equal(installCmdFor(npm, 'uninstall'), 'npm uninstall -g @scope/pkg');
  assert.equal(installCmdFor({ install: { via: 'manual', url: 'https://x' } }, 'install'), null);
  assert.equal(installCmdFor(winget, 'format-disk'), null);
});

test('uninstall commands mirror the install mechanism, and only where safe', () => {
  assert.equal(uninstallCmdFor({ install: { via: 'winget', cmd: 'winget install --id Vendor.Tool -e' } }), 'winget uninstall --id Vendor.Tool');
  assert.equal(uninstallCmdFor({ install: { via: 'npm', cmd: 'npm install -g @scope/pkg' } }), 'npm uninstall -g @scope/pkg');
  assert.equal(uninstallCmdFor({ install: { via: 'pip', cmd: 'python -m pip install x' } }), null);
  assert.equal(uninstallCmdFor({ install: { via: 'manual', url: 'https://x' } }), null);
});

test('findBinIn finds windows launchers by extension and skips unreadable dirs', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-p-'));
  fs.writeFileSync(path.join(dir, 'mytool.cmd'), '@echo hi');
  const { findBinIn } = await import('../core/providers.js');
  assert.equal(findBinIn(['C:/no/such/dir', dir], 'mytool'), path.join(dir, 'mytool.cmd'));
  assert.equal(findBinIn([dir], 'other'), null);
});

test('detectTool reports a missing binary as not installed, without throwing', async () => {
  const out = await detectTool({ id: 'ghost', name: 'Ghost', bin: 'switchboard-no-such-binary-xyz', versionArgs: ['--version'], install: { via: 'npm', cmd: 'npm install -g ghost' } });
  assert.equal(out.installed, false);
  assert.equal(out.onPath, false);
  assert.equal(out.version, null);
});

test('detectInstalled answers for every tool in the table, without running any of them', async () => {
  const { detectInstalled } = await import('../core/providers.js');
  const out = await detectInstalled();
  assert.deepEqual(out.map((t) => t.id), TOOLS.map((t) => t.id));
  for (const t of out) {
    assert.equal(typeof t.installed, 'boolean', `${t.id} says whether it is installed`);
    assert.equal('version' in t, false, `${t.id} carries no version: asking for one means running the tool`);
    assert.ok(t.name);
  }
});
