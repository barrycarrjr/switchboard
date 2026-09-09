import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { accountScopedEnv, providerDef } from './accounts.js';
import { accountLoginState } from './doctor.js';
import { cliLaunch } from './cli-launch.js';

const runFile = promisify(execFile);

/**
 * Signing an account out, using the vendor's own logout command.
 *
 * Switchboard never deletes a credential file itself. A tool belongs here only when it
 * publishes a logout command of its own, so what happens to the credential stays the
 * vendor's decision, exactly as signing in does. Gemini CLI and Qwen Code sign out from
 * inside their own sessions and have no such command, so no button is offered for them
 * rather than a button that quietly does nothing.
 *
 * Unlike signing in, this needs no visible terminal: the command is not interactive and
 * finishes in a moment, so it runs directly, scoped to the account's own folder. The
 * folder travels in the child's environment and the arguments are constants, so nothing
 * here is assembled from text that could arrive through an imported configuration.
 */
export function signoutSupported(provider) {
  try {
    return Boolean(providerDef(provider).logout);
  } catch {
    return false;
  }
}

/** Why a provider has no sign-out button, for the card to say out loud. */
export function signoutUnsupportedNote(provider) {
  try {
    const def = providerDef(provider);
    if (def.logout) return null;
    return def.logoutNote ?? `${def.name} publishes no sign-out command.`;
  } catch {
    return 'Unknown provider.';
  }
}

/** What to run to sign one account out. Pure, so the command shape stays testable. */
export function signoutLaunch(account, executable = null) {
  const def = providerDef(account?.provider);
  if (!def.logout) throw new Error(`${def.name} has no sign-out command`);
  const launch = cliLaunch(executable || def.logout.bin, def.logout.args, { label: def.name });
  return { ...launch, env: accountScopedEnv(account, process.env) };
}

/**
 * Run the vendor's logout for one account and report what the folder looks like after.
 *
 * A logout command may exit nonzero for reasons that still leave the account signed out,
 * the way the status probe exits nonzero when logged out, so the credential folder is the
 * verdict rather than the exit code. Command output never leaves this module: it can
 * carry account detail, and there is nothing in it the caller needs.
 */
export async function signOutAccount(account, {
  runImpl = runFile,
  executable = null,
  loginStateImpl = accountLoginState,
} = {}) {
  const def = providerDef(account?.provider);
  const launch = signoutLaunch(account, executable);

  let ran = true;
  try {
    await runImpl(launch.file, launch.args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 64 * 1024,
      ...launch.options,
      env: launch.env,
    });
  } catch {
    ran = false;
  }

  const login = loginStateImpl(account);
  if (login?.signedIn === false) {
    return { ok: true, signedIn: false, detail: `${account.label ?? def.name} is signed out.` };
  }
  if (ran) {
    // The command reported success and the credential is still readable. Saying "signed
    // out" here would be a guess, and the card would contradict it on the next check.
    return {
      ok: false,
      signedIn: login?.signedIn ?? null,
      detail: `${def.name} ran its sign-out but the credential in this folder is still readable.`,
    };
  }
  return {
    ok: false,
    signedIn: login?.signedIn ?? null,
    detail: `${def.name} could not complete its sign-out. Try "${def.logout.bin} ${def.logout.args.join(' ')}" in this account's terminal.`,
  };
}
