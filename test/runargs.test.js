import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../test-support/tempdir.js';
import { parseRunArgs, parseHarnessList, drivableHarnesses, parseRunSpec, loadRunSpec, resolveSpecArgv, childStdio, childWindowsHide, parseLaneAddArgs, parseWatchArgs } from '../core/runargs.js';

test('parseRunArgs steals its own flags and leaves the rest to the child', () => {
  const parsed = parseRunArgs(['--provider', 'anthropic', '--account', 'acct1', '--no-fallback', '--yes', '--quiet', '--spec', 'spec.json', '-p', 'hello']);

  assert.equal(parsed.provider, 'anthropic');
  assert.equal(parsed.account, 'acct1');
  assert.equal(parsed.noFallback, true);
  assert.equal(parsed.yes, true);
  assert.equal(parsed.quiet, true);
  assert.equal(parsed.spec, 'spec.json');
  assert.deepEqual(parsed.commandArgs, ['-p', 'hello']);
});

test('parseRunArgs defaults keep an existing invocation unchanged', () => {
  const parsed = parseRunArgs(['-p', '--output-format', 'json']);

  assert.equal(parsed.quiet, false);
  assert.equal(parsed.spec, null);
  assert.equal(parsed.yes, false);
  assert.deepEqual(parsed.commandArgs, ['-p', '--output-format', 'json']);
});

test('parseRunArgs treats -y as --yes and does not invent a short form for --quiet', () => {
  assert.equal(parseRunArgs(['-y']).yes, true);
  const parsed = parseRunArgs(['-q']);
  assert.equal(parsed.quiet, false);
  assert.deepEqual(parsed.commandArgs, ['-q']);
});

test('parseRunArgs stops parsing at -- and passes everything after it through', () => {
  const parsed = parseRunArgs(['--quiet', '--', '--spec', 'not-a-spec.json', '--yes']);

  assert.equal(parsed.quiet, true);
  assert.equal(parsed.spec, null);
  assert.equal(parsed.yes, false);
  assert.deepEqual(parsed.commandArgs, ['--spec', 'not-a-spec.json', '--yes']);
});

test('parseRunArgs does not mistake a spec path for a command argument', () => {
  const parsed = parseRunArgs(['--spec', 'run-spec.json', 'prompt']);

  assert.equal(parsed.spec, 'run-spec.json');
  assert.deepEqual(parsed.commandArgs, ['prompt']);
});

test('parseRunArgs keeps a trailing --spec with no value as a command argument', () => {
  const parsed = parseRunArgs(['--spec']);

  assert.equal(parsed.spec, null);
  assert.deepEqual(parsed.commandArgs, ['--spec']);
});

test('parseRunArgs reads the tools a caller can drive and keeps them off the command line', () => {
  const parsed = parseRunArgs(['--harnesses', 'claude, Codex,claude', '--json']);

  assert.deepEqual(parsed.harnesses, ['claude', 'codex']);
  assert.deepEqual(parsed.commandArgs, ['--json']);
});

test('a caller that names no tools has not asked for an empty pool', () => {
  assert.equal(parseRunArgs([]).harnesses, null);
  assert.equal(parseHarnessList(''), null);
  assert.equal(parseHarnessList(' , '), null);
  assert.equal(parseHarnessList(undefined), null);

  // A trailing flag with no value is left to the child, the same as --spec.
  const parsed = parseRunArgs(['--harnesses']);
  assert.equal(parsed.harnesses, null);
  assert.deepEqual(parsed.commandArgs, ['--harnesses']);
});

test('a spec says which tools a run may use without a second flag', () => {
  const spec = { harnessArgs: { claude: ['-p'], codex: ['exec', '-'] } };

  assert.deepEqual(drivableHarnesses(parseRunArgs([]), spec), ['claude', 'codex']);
  assert.deepEqual(drivableHarnesses(parseRunArgs(['--harnesses', 'copilot,claude']), null), ['copilot', 'claude']);
  assert.equal(drivableHarnesses(parseRunArgs([]), null), null);
});

test('a lane has to satisfy both the spec and the named tools when both are given', () => {
  const spec = { harnessArgs: { claude: ['-p'], codex: ['exec', '-'] } };

  assert.deepEqual(drivableHarnesses(parseRunArgs(['--harnesses', 'codex,copilot']), spec), ['codex']);
  // Nothing in common is an empty pool, not an unrestricted one.
  assert.deepEqual(drivableHarnesses(parseRunArgs(['--harnesses', 'copilot']), spec), []);
});

test('parseRunSpec accepts a harnessArgs map', () => {
  const spec = parseRunSpec('{"harnessArgs":{"claude":["-p","--output-format","json"],"codex":["exec","-","--json"]}}');

  assert.deepEqual(spec.harnessArgs.claude, ['-p', '--output-format', 'json']);
  assert.deepEqual(spec.harnessArgs.codex, ['exec', '-', '--json']);
});

test('parseRunSpec tolerates a byte order mark', () => {
  const spec = parseRunSpec('\uFEFF{"harnessArgs":{"claude":["-p"]}}');

  assert.deepEqual(spec.harnessArgs.claude, ['-p']);
});

test('parseRunSpec rejects anything that is not a usable spec', () => {
  assert.throws(() => parseRunSpec('not json'), /not valid JSON/);
  assert.throws(() => parseRunSpec('[]'), /must be a JSON object/);
  assert.throws(() => parseRunSpec('"claude"'), /must be a JSON object/);
  assert.throws(() => parseRunSpec('{}'), /harnessArgs object/);
  assert.throws(() => parseRunSpec('{"harnessArgs":[]}'), /harnessArgs object/);
  assert.throws(() => parseRunSpec('{"harnessArgs":{"claude":"-p"}}'), /harnessArgs\.claude must be an array of strings/);
  assert.throws(() => parseRunSpec('{"harnessArgs":{"claude":["-p",3]}}'), /harnessArgs\.claude must be an array of strings/);
});

test('loadRunSpec reads a file and reports an unreadable one clearly', () => {
  const file = path.join(tempDir('switchboard-spec-'), 'spec.json');
  fs.writeFileSync(file, '{"harnessArgs":{"claude":["-p"]}}', 'utf8');

  assert.deepEqual(loadRunSpec(file).harnessArgs.claude, ['-p']);
  assert.throws(() => loadRunSpec(path.join(path.dirname(file), 'missing.json')), /Cannot read run spec/);

  fs.rmSync(path.dirname(file), { recursive: true, force: true });
});

test('resolveSpecArgv returns the argv for the harness that will actually run', () => {
  const spec = { harnessArgs: { claude: ['-p', '--output-format', 'json'], codex: ['exec', '-', '--json'] } };

  assert.deepEqual(resolveSpecArgv(spec, 'claude'), ['-p', '--output-format', 'json']);
  assert.deepEqual(resolveSpecArgv(spec, 'codex'), ['exec', '-', '--json']);
});

test('resolveSpecArgv appends the handoff prompt instead of replacing the argv', () => {
  const spec = { harnessArgs: { codex: ['exec', '-', '--json'] } };

  assert.deepEqual(resolveSpecArgv(spec, 'codex', 'Read the handoff.'), ['exec', '-', '--json', 'Read the handoff.']);
  // The spec itself must survive being used for a second lane.
  assert.deepEqual(spec.harnessArgs.codex, ['exec', '-', '--json']);
});

test('resolveSpecArgv returns null for a harness the spec does not cover', () => {
  const spec = { harnessArgs: { claude: ['-p'] } };

  assert.equal(resolveSpecArgv(spec, 'codex'), null);
  assert.equal(resolveSpecArgv(spec, 'codex', 'Read the handoff.'), null);
  assert.equal(resolveSpecArgv(null, 'claude'), null);
});

test('childStdio leaves a terminal alone and only captures stdout for an automated caller', () => {
  // A person at a keyboard keeps the terminal, so an interactive harness still renders its
  // own interface; capturing it would silently downgrade every hand-typed run.
  assert.deepEqual(childStdio(true), ['inherit', 'inherit', 'pipe']);
  assert.deepEqual(childStdio(false), ['inherit', 'pipe', 'pipe']);
});

test('childStdio gives the child a pipe of its own when the caller piped its prompt in', () => {
  // The prompt is replayed into it, so a lane the run falls back to gets the question
  // too. Inheriting the caller's pipe only ever worked for the first lane to read it.
  assert.deepEqual(childStdio(false, true), ['pipe', 'pipe', 'pipe']);
  // A person typing keeps the real terminal whatever else is true.
  assert.deepEqual(childStdio(true, false), ['inherit', 'inherit', 'pipe']);
});

test('childWindowsHide keeps a console window off an automated run and leaves a typed one alone', () => {
  // Without this, a bot answering a Slack message pops a command window onto the desktop:
  // switchboard runs as an Electron binary in node mode, which has no console of its own,
  // so Windows gives the harness a fresh one and shows it.
  assert.equal(childWindowsHide(false), true);
  assert.equal(childWindowsHide(true), false);
});

test('parseLaneAddArgs reads the account, the billing and the budget', () => {
  assert.deepEqual(parseLaneAddArgs(['claude-work']), { accountId: 'claude-work', billing: 'subscription', budget: null });
  assert.deepEqual(parseLaneAddArgs(['claude-work', '--metered', '--budget', '25']), { accountId: 'claude-work', billing: 'metered', budget: '25' });
});

test('the value after --budget is never mistaken for the account', () => {
  const parsed = parseLaneAddArgs(['--metered', '--budget', '25', 'claude-work']);
  assert.equal(parsed.accountId, 'claude-work');
  assert.equal(parsed.budget, '25');
});

test('parseLaneAddArgs refuses input that would register the wrong thing', () => {
  assert.throws(() => parseLaneAddArgs([]), /name the account/);
  assert.throws(() => parseLaneAddArgs(['a', 'b']), /exactly one account/);
  assert.throws(() => parseLaneAddArgs(['a', '--nope']), /unknown option/);
  assert.throws(() => parseLaneAddArgs(['a', '--budget']), /needs an amount/);
});

test('a budget on a subscription lane is refused rather than stored and ignored', () => {
  assert.throws(() => parseLaneAddArgs(['claude-work', '--budget', '25']), /metered lanes only/);
});

test('parseWatchArgs defaults to a five-minute loop that follows the stored mode', () => {
  assert.deepEqual(parseWatchArgs([]), { once: false, intervalMinutes: 5, mode: null, json: false });
});

test('parseWatchArgs reads the one-shot, interval, mode and json options', () => {
  assert.deepEqual(parseWatchArgs(['--once', '--interval', '15', '--mode', 'auto', '--json']), {
    once: true,
    intervalMinutes: 15,
    mode: 'auto',
    json: true,
  });
});

test('parseWatchArgs refuses an interval or mode it cannot honour', () => {
  assert.throws(() => parseWatchArgs(['--interval', '0']), /at least 1 minute/);
  assert.throws(() => parseWatchArgs(['--interval', 'soon']), /at least 1 minute/);
  assert.throws(() => parseWatchArgs(['--mode', 'off']), /notify or auto/);
  assert.throws(() => parseWatchArgs(['--every', '5']), /unknown option/);
});
