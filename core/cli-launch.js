/**
 * How Switchboard runs one of the vendor CLIs directly, without a shell.
 *
 * Node can hand a native executable straight to `execFile`, including an absolute path
 * with spaces in it. A Windows npm shim is a batch file, though, and CreateProcess
 * cannot run one, so those alone go through cmd.exe with AutoRun and delayed expansion
 * switched off. The executable path is the only interpolated value, it stays inside
 * quotes, and characters cmd would expand even inside quotes are refused rather than
 * risked. Arguments are Switchboard's own constants, never anything typed or imported,
 * and the check below keeps that true if a future caller forgets.
 *
 * Pure: it returns what to run, so what gets run is testable.
 */
const WINDOWS_BATCH_SHIM = /\.(?:cmd|bat)$/i;
const PLAIN_ARGUMENT = /^[A-Za-z0-9._:@=/\-]+$/;

export function cliLaunch(executable, args, { label = 'CLI' } = {}) {
  const file = String(executable ?? '').trim();
  if (!file) throw new Error(`${label} executable is required`);

  const list = (args ?? []).map((value) => String(value));
  if (!list.every((value) => PLAIN_ARGUMENT.test(value))) {
    throw new Error(`Unsafe ${label} argument`);
  }

  if (!WINDOWS_BATCH_SHIM.test(file)) {
    return { file, args: list, options: { shell: false } };
  }

  // Quotes and control characters cannot occur in a normal Windows filename. Percent is
  // legal but would trigger cmd.exe environment expansion even inside a quoted token, so
  // decline that pathological path rather than risk executing a different command.
  if (/[\u0000-\u001f"%]/.test(file)) {
    throw new Error(`Unsafe ${label} batch-shim path`);
  }

  return {
    file: 'cmd.exe',
    args: ['/d', '/s', '/v:off', '/c', `""${file}"${list.map((value) => ` ${value}`).join('')}"`],
    options: {
      shell: false,
      // Preserve the canonical cmd.exe /s /c outer-quote form above. Node must not apply
      // a second Windows argv quoting pass to the command string.
      windowsVerbatimArguments: true,
    },
  };
}
