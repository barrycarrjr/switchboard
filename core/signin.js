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
 * The terminal the Health panel's "Get new token" button opens. The button exists because
 * the only way to mint was typing `switchboard lane-token <laneId>` with a lane id copied
 * from a warning (2026-11-02: a lane's token died and the person had no idea what to run).
 *
 * It has to be a real window. `claude setup-token` draws its prompts only on a real
 * console and hangs when its output is captured (see mintLaneToken in bin/cli.js), and
 * Anthropic issues the token only after a person approves it in the browser.
 *
 * The window runs `claude setup-token` and reads the paste ITSELF, then hands only the
 * storing to Switchboard's command (`lane-token <laneId> --from-env`). The first version
 * had Switchboard's command do the whole mint, and the tool drew nothing: the app run as
 * Node gets no console for its input (stdin.isTTY is undefined even in a real window), so
 * the tool it started waited on an input that was not a terminal. The browser said "all
 * set" and no token ever appeared (2026-11-02). PowerShell has the real console.
 *
 * The caller passes the lane's account environment (its folder, inherited Claude tokens
 * stripped) so the token is minted for this account and no other. The pasted token reaches
 * the storing command in an environment variable, never on a command line, and is removed
 * afterwards. Every other value also travels in the environment, never in the command text,
 * for the same reasons as signinTerminal above: install paths and labels are data, not code.
 */
export function laneTokenTerminal({ laneId, label, exePath, cliPath, claudePath }) {
  const banner = `New Claude setup token for ${label || laneId}. Approve in the browser when it opens, `
    + 'then copy the long token this window prints (the browser never shows it) and paste it at the prompt.';
  return {
    // Start-Process -Wait for the app, not the & operator: the app executable is a windowed
    // program, and PowerShell does not wait for one started with & (found in a dry run,
    // 2026-11-02). -NoNewWindow keeps it on this console. [char]34 quotes the script path
    // without putting a double quote in the command text that cmd.exe passes along. Claude's
    // tool is a console program, so & runs it on this console and waits.
    command: [
      'Write-Host $env:SWITCHBOARD_TOKEN_BANNER -ForegroundColor Cyan',
      '& $env:SWITCHBOARD_CLAUDE setup-token',
      "if ($LASTEXITCODE -ne 0) { Write-Host 'The sign-in tool stopped before minting, so nothing was stored.' -ForegroundColor Yellow; return }",
      "$env:SWITCHBOARD_NEW_LANE_TOKEN = Read-Host 'Paste the token that was just printed'",
      "$env:ELECTRON_RUN_AS_NODE = '1'",
      "Start-Process -FilePath $env:SWITCHBOARD_EXE -ArgumentList ([char]34 + $env:SWITCHBOARD_CLI + [char]34), 'lane-token', $env:SWITCHBOARD_LANE_ID, '--from-env' -NoNewWindow -Wait",
      'Remove-Item Env:\\SWITCHBOARD_NEW_LANE_TOKEN, Env:\\ELECTRON_RUN_AS_NODE',
    ].join('; '),
    env: {
      SWITCHBOARD_CLAUDE: claudePath,
      SWITCHBOARD_EXE: exePath,
      SWITCHBOARD_CLI: cliPath,
      SWITCHBOARD_LANE_ID: laneId,
      SWITCHBOARD_TOKEN_BANNER: banner,
    },
  };
}
