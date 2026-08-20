import { envValueForHome, providerDef } from './accounts.js';

/**
 * The terminal Switchboard opens for a vendor's own login flow: a visible window with
 * the account's folder already selected, so the sign-in lands in the right home.
 *
 * The folder never appears in the command text. A Windows folder name may legally
 * contain an apostrophe (C:\Jo's profiles\.claude), and pasting one into a
 * PowerShell string ends the string, so everything after it would run as further
 * statements. Handing the value to the child process as an environment variable is
 * both safe for those folders and immune to a hostile one arriving through an
 * imported configuration. The banner is the only interpolated text, and its quotes
 * are doubled, which is how PowerShell escapes a quote inside a literal string.
 *
 * Pure: it returns the command and the environment, so what gets run is testable.
 */
export function signinTerminal(account) {
  const def = providerDef(account.provider);
  const banner = `${def.name} sign-in for account: ${account.label}.${def.loginNote ? ` ${def.loginNote}` : ''}`;
  return {
    command: `Write-Host '${banner.replace(/'/g, "''")}' -ForegroundColor Cyan; ${def.loginCmd}`,
    env: { [def.envVar]: envValueForHome(def, account.home) },
  };
}
