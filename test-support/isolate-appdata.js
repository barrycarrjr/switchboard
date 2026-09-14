// Keeps every test process out of the Switchboard data folder the real app uses.
//
// dataDir() is %APPDATA%\Switchboard, the same folder the installed tray app and the CLI
// read and write, and a test that forgot to point APPDATA somewhere else wrote straight
// into it. A machine's real usage cache was found holding two invented accounts,
// `claude-primary` and `claude-secondary` at 99% and 100%, left by test/status.test.js
// (found 2026-09-14), and test/handoff.test.js was writing handoff files beside the real
// ones. Nothing broke only because no real account has those ids: a test sharing an id
// with a real account would have fed made-up usage to the watch that decides which
// account every new terminal uses.
//
// Fixing each test only lasts until the next one forgets, so `npm test` loads this into
// every test process before any test runs (see the "test" script in package.json, and
// test/isolation.test.js, which fails if that line goes). APPDATA then points at a
// throwaway folder from the first line of every suite. A test that sets its own still
// can, and putting the previous value back restores this folder, never the real one.
// It also keeps tests from reading real data, such as Claude Desktop's usage history
// under %APPDATA%\Claude, so no result depends on the machine the suite runs on.
import { tempDir } from './tempdir.js';

process.env.APPDATA = tempDir('sb-isolated-appdata-');
