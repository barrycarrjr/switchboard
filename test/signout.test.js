import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { signOutAccount, signoutLaunch, signoutSupported, signoutUnsupportedNote } from '../core/signout.js';

/**
 * Signing out is the one account action that removes something, so what it promises has
 * to be exactly what happened. Two rules are pinned here: Switchboard runs the vendor's
 * own logout rather than deleting a credential file itself, and it reports the folder as
 * it actually stands afterwards rather than trusting the command's own exit code.
 */
function tmpAccount(provider = 'claude', credFile = '.credentials.json', signedIn = true) {
  const home = tempDir('sb-so-');
  if (signedIn) {
    const body = provider === 'claude'
      ? JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } })
      : '{}';
    fs.writeFileSync(path.join(home, credFile), body);
  }
  return { id: 'acct-1', provider, label: 'Work', home };
}

test('only a tool with its own logout command is offered one', () => {
  assert.equal(signoutSupported('claude'), true);
  assert.equal(signoutSupported('codex'), true);
  assert.equal(signoutSupported('gemini'), false, 'Gemini CLI signs out inside its own session');
  assert.equal(signoutSupported('qwen'), false);
  assert.equal(signoutSupported('nothing-like-this'), false);
  assert.match(signoutUnsupportedNote('gemini'), /no command to offer/);
  assert.equal(signoutUnsupportedNote('claude'), null);
});

test('the account folder travels in the environment, never in the command', () => {
  const account = tmpAccount();
  const launch = signoutLaunch(account, 'claude');
  assert.equal(launch.file, 'claude');
  assert.deepEqual(launch.args, ['auth', 'logout']);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.env.CLAUDE_CONFIG_DIR, path.resolve(account.home));
  assert.equal(launch.args.join(' ').includes(account.home), false);
  // The same credential pins a sign-in terminal strips must not survive into a logout,
  // or the command can act on an account other than the folder it was pointed at.
  assert.equal(
    Object.keys(launch.env).some((name) => name.toUpperCase() === 'CLAUDE_CODE_OAUTH_TOKEN'),
    false,
  );
});

test('a Windows npm shim goes through cmd.exe with expansion switched off', () => {
  const executable = 'C:\Program Files (x86)\Claude & Co\claude.cmd';
  const launch = signoutLaunch(tmpAccount(), executable);
  assert.equal(launch.file, 'cmd.exe');
  assert.deepEqual(launch.args, ['/d', '/s', '/v:off', '/c', `""${executable}" auth logout"`]);
  assert.equal(launch.options.windowsVerbatimArguments, true);
});

test('a tool with no logout command refuses rather than inventing one', () => {
  assert.throws(() => signoutLaunch({ provider: 'gemini', home: 'C:\h\.gemini' }), /no sign-out command/);
});

test('the credential folder is the verdict, not the exit code', async () => {
  const account = tmpAccount();
  let invocation = null;
  const result = await signOutAccount(account, {
    executable: 'claude',
    runImpl: async (file, args, options) => {
      invocation = { file, args, options };
      // Vendors exit nonzero on a logout that had nothing left to remove. That is not a
      // failure, and the folder says so.
      fs.rmSync(path.join(account.home, '.credentials.json'));
      const error = new Error('Command failed with exit code 1');
      error.code = 1;
      throw error;
    },
  });
  assert.equal(invocation.options.env.CLAUDE_CONFIG_DIR, path.resolve(account.home));
  assert.equal(result.ok, true);
  assert.equal(result.signedIn, false);
  assert.match(result.detail, /signed out/i);
});

test('a command that says it worked while the login is still readable is not called a sign-out', async () => {
  const account = tmpAccount();
  const result = await signOutAccount(account, {
    executable: 'claude',
    runImpl: async () => ({ stdout: 'Logged out.\n' }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.signedIn, true);
  assert.match(result.detail, /still readable/);
});

test('a logout that could not run says how to finish it by hand', async () => {
  const account = tmpAccount('codex', 'auth.json');
  const result = await signOutAccount(account, {
    executable: null,
    runImpl: async () => { throw new Error('spawn ENOENT'); },
  });
  assert.equal(result.ok, false);
  assert.match(result.detail, /codex logout/);
  assert.equal(result.detail.includes('ENOENT'), false, 'command output never reaches the card');
});
