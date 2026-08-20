import { envValueForHome, providerDef } from './accounts.js';

/**
 * The terminal Switchboard opens for a vendor's own login flow: a visible window with
 * the account's folder already selected, so the sign-in lands in the right home.
 *
 * The folder never appears in the command text. A Windows folder name may legally
 * contain an apostrophe (C:\Jo's profiles\.claude), and pasting one into a
 * PowerShell string ends the string, so everything after it would run as further
 * statements. Handing values to the child process as environment variables is both
 * safe for those folders and immune to hostile text arriving through an imported
 * configuration. The account label follows the same rule: cmd.exe expands percent
 * expressions before PowerShell parses a command, so even display-only text must not
 * be interpolated into the command line.
 *
 * Pure: it returns the command and the environment, so what gets run is testable.
 */
export function signinTerminal(account) {
  const def = providerDef(account.provider);
  const banner = `${def.name} sign-in for account: ${account.label}.${def.loginNote ? ` ${def.loginNote}` : ''}`;
  return {
    command: `Write-Host $env:SWITCHBOARD_SIGNIN_BANNER -ForegroundColor Cyan; ${def.loginCmd}`,
    env: {
      [def.envVar]: envValueForHome(def, account.home),
      SWITCHBOARD_SIGNIN_BANNER: banner,
    },
  };
}
