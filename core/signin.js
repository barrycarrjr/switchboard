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

/**
 * The terminal the Health panel's "Get new token" button opens: Switchboard's own
 * `lane-token <laneId>` command in a visible window, run by the app's executable as Node,
 * exactly as the installed `switchboard.cmd` shim runs it. The button exists because the
 * only way to mint was typing that command with a lane id copied from a warning
 * (2026-11-02: a lane's token died and the person had no idea what to run or where).
 *
 * It has to be a real window. `claude setup-token` draws its prompts only on a real
 * console and hangs when its output is captured (see mintLaneToken in bin/cli.js), and
 * Anthropic issues the token only after a person approves it in the browser. So the
 * window shows the token once and the command asks for it to be pasted back.
 *
 * Every value travels in the environment, never in the command text, for the same
 * reasons as signinTerminal above: install paths and labels are data, not code.
 */
export function laneTokenTerminal({ laneId, label, exePath, cliPath }) {
  const banner = `New Claude setup token for ${label || laneId}. Approve in the browser when it opens, `
    + 'then copy the long token this window prints (the browser never shows it) and paste it at the prompt below.';
  return {
    // Start-Process -Wait, not the & operator: the app executable is a windowed program,
    // and PowerShell does not wait for one started with &, so the window went straight
    // back to its prompt and the paste prompt never got the keyboard (found in a dry run,
    // 2026-11-02). -NoNewWindow keeps it on this console. [char]34 quotes the script path
    // without putting a double quote in the command text that cmd.exe passes along.
    command: 'Write-Host $env:SWITCHBOARD_TOKEN_BANNER -ForegroundColor Cyan; '
      + 'Start-Process -FilePath $env:SWITCHBOARD_EXE -ArgumentList ([char]34 + $env:SWITCHBOARD_CLI + [char]34), '
      + "'lane-token', $env:SWITCHBOARD_LANE_ID -NoNewWindow -Wait",
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      SWITCHBOARD_EXE: exePath,
      SWITCHBOARD_CLI: cliPath,
      SWITCHBOARD_LANE_ID: laneId,
      SWITCHBOARD_TOKEN_BANNER: banner,
    },
  };
}
