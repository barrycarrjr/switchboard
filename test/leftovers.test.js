import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createFamily, addRoot, absorb, running, noteStops, parseListing, parseStops, watchLeftovers, runProgram } from '../core/leftovers.js';
import { fetchAntigravityQuota } from '../core/quota.js';
import { tempDir } from '../test-support/tempdir.js';
import path from 'node:path';

test('only proven descendants are stopped, including children listed before parents', () => {
  const family = createFamily({ keep: ['agy.exe'] });
  const root = addRoot(family, { pid: 10, startedAt: 100 });
  root.exitedAt = 200;
  absorb(family, { at: 300, rows: [
    { pid: 12, ppid: 11, created: 160, name: 'node.exe' },
    { pid: 11, ppid: 10, created: 150, name: 'cmd.exe' },
    { pid: 13, ppid: 10, created: 210, name: 'unrelated.exe' },
    { pid: 14, ppid: 10, created: 170, name: 'AGY.EXE' },
    { pid: 15, ppid: 14, created: 180, name: 'installer.exe' },
  ] });
  assert.deepEqual(running(family).map(x => x.pid), [11, 12]);
  const asked = running(family);
  noteStops(family, asked, asked.map(x => ({ pid: x.pid, state: 'stopped', at: 400 })));
  absorb(family, { at: 500, rows: [
    { pid: 16, ppid: 11, created: 350, name: 'late.exe' },
    { pid: 17, ppid: 11, created: 450, name: 'unrelated.exe' },
  ] });
  assert.deepEqual(running(family).map(x => x.pid), [16]);
});

test('a broken listing or stop reply is not a clean result', () => {
  assert.equal(parseListing(['failed']), null);
  assert.equal(parseStops(['garbage']), null);
});

test('usage failures still clean up and cleanup failures do not replace the reading', async () => {
  let swept = 0;
  const options = {
    agyBin: 'agy', agyStamp: path.join(tempDir('sb-qc-'), 'stamp'),
    watchImpl: () => ({
      run: async () => { throw new Error('timeout'); },
      sweep: async () => { swept++; throw new Error('helper failed'); },
    }),
  };
  assert.equal((await fetchAntigravityQuota(options)).error, 'unavailable');
  assert.equal(swept, 1);
  options.watchImpl = () => ({
    run: async () => ({ stdout: JSON.stringify({ groups: [{ name: 'Gemini', buckets: [{ name: '5-hour', window: '5h', used_percent: 10 }] }] }) }),
    sweep: async () => { swept++; throw new Error('helper failed'); },
  });
  assert.equal((await fetchAntigravityQuota(options)).source, 'cli');
  assert.equal(swept, 2);
});

test('a real usage-shaped run removes its leftover and leaves another session alone', async () => {
  const server = 'setInterval(() => {}, 1000); setTimeout(() => process.exit(), 20000);';
  const unrelated = spawn(process.execPath, ['-e', server], { stdio: 'ignore', windowsHide: true });
  const watch = watchLeftovers();
  let pid;
  try {
    const script = `const {spawn}=require('node:child_process'); const p=spawn(process.execPath,['-e',${JSON.stringify(server)}],{stdio:'ignore',windowsHide:true,detached:process.platform==='win32'}); console.log(p.pid); setTimeout(()=>process.exit(),1200);`;
    const result = await watch.run(process.execPath, ['-e', script], { timeout: 5000, windowsHide: true });
    pid = Number(result.stdout.trim());
    assert.ok(pid > 0);
    process.kill(pid, 0);
    const outcome = await watch.sweep();
    assert.equal(outcome.checked, true);
    assert.deepEqual(outcome.left, []);
    assert.throws(() => process.kill(pid, 0));
    process.kill(unrelated.pid, 0);
  } finally {
    await watch.sweep();
    if (pid) { try { process.kill(pid); } catch {} }
    const closed = new Promise(resolve => unrelated.once('close', resolve));
    unrelated.kill();
    await closed;
  }
});

test('a timed out program rejects rather than hanging on inherited output', async () => {
  await assert.rejects(runProgram(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 100, windowsHide: true }), /timed out/);
});
