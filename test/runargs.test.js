import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseRunArgs, parseRunSpec, loadRunSpec, resolveSpecArgv, childStdio } from '../core/runargs.js';

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
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'switchboard-spec-')), 'spec.json');
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
