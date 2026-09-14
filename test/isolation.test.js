// Tests must never touch the Switchboard data the installed app uses.
//
// A machine's real usage cache was found holding two invented accounts from a test run
// (2026-09-14), because a suite reached dataDir() without pointing APPDATA elsewhere
// first. test-support/isolate-appdata.js now points it at a throwaway folder in every
// test process, and these tests are what stop that protection from quietly going away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('npm test loads the app data isolation into every test process', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--import \.\/test-support\/isolate-appdata\.js/,
    'without it, a test that forgets to set APPDATA writes into the real app data folder');
});

test('the isolation points APPDATA at a throwaway folder before any test code runs', () => {
  const realLooking = path.join(os.homedir(), 'AppData', 'Roaming');
  const seen = execFileSync(
    process.execPath,
    ['--import', './test-support/isolate-appdata.js', '-e', 'process.stdout.write(process.env.APPDATA)'],
    { cwd: root, env: { ...process.env, APPDATA: realLooking }, encoding: 'utf8' },
  );
  const inTemp = path.resolve(seen).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase());
  assert.notEqual(path.resolve(seen), path.resolve(realLooking), 'the real folder is gone from view');
  assert.ok(inTemp, `a throwaway folder under the system temp dir, not ${seen}`);
});
