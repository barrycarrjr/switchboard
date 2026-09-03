import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TOOLS } from '../core/providers.js';
import {
  LIVE_SOURCES,
  STATIC_SOURCES,
  componentLevel,
  humanStatus,
  worstLevel,
  classifyLiveResponse,
  fetchAllProviderStatus,
} from '../core/provider-status.js';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-provider-status-')), 'status-cache.json');
}

test('every tool in the Providers tab is accounted for, live or static, never both', () => {
  const liveIds = Object.keys(LIVE_SOURCES);
  const staticIds = Object.keys(STATIC_SOURCES);
  assert.equal(new Set([...liveIds, ...staticIds]).size, liveIds.length + staticIds.length, 'no id appears in both lists');
  const toolIds = TOOLS.map((t) => t.id);
  for (const id of [...liveIds, ...staticIds]) assert.ok(toolIds.includes(id), `${id} is a real tool in core/providers.js`);
  for (const id of toolIds) assert.ok(liveIds.includes(id) || staticIds.includes(id), `${id} has a health source of some kind`);
});

test('componentLevel speaks statuspage severity in Switchboard\'s own words', () => {
  assert.equal(componentLevel('operational'), 'ok');
  assert.equal(componentLevel('degraded_performance'), 'warn');
  assert.equal(componentLevel('partial_outage'), 'bad');
  assert.equal(componentLevel('major_outage'), 'bad');
  assert.equal(componentLevel('under_maintenance'), 'info');
  assert.equal(componentLevel('something_a_vendor_invents_next_year'), 'info', 'an unrecognized status is unknown, not assumed fine');
});

test('humanStatus turns snake_case into a sentence-case word', () => {
  assert.equal(humanStatus('degraded_performance'), 'Degraded performance');
  assert.equal(humanStatus('operational'), 'Operational');
  assert.equal(humanStatus(undefined), 'Unknown');
  assert.equal(humanStatus(''), 'Unknown');
});

test('worstLevel picks bad over warn over ok, and defaults to ok on nothing', () => {
  assert.equal(worstLevel([]), 'ok');
  assert.equal(worstLevel(['ok', 'info']), 'ok');
  assert.equal(worstLevel(['ok', 'warn']), 'warn');
  assert.equal(worstLevel(['warn', 'bad', 'ok']), 'bad');
});

test('classifyLiveResponse matches only the components a card is about, not the whole page', () => {
  const data = {
    status: { indicator: 'minor', description: 'Minor Service Outage' },
    components: [
      { name: 'claude.ai', status: 'partial_outage' },
      { name: 'Claude API (api.anthropic.com)', status: 'partial_outage' },
      { name: 'Claude Code', status: 'partial_outage' },
      { name: 'Claude Console (platform.claude.com)', status: 'operational' },
      { name: 'Claude for Government', status: 'operational' },
    ],
  };
  const result = classifyLiveResponse(data, LIVE_SOURCES.claude);
  assert.deepEqual(result.components.map((c) => c.name), ['Claude API (api.anthropic.com)', 'Claude Code'], 'claude.ai and Claude Console are a different product from the CLI');
  assert.equal(result.level, 'bad');
  assert.equal(result.summary, 'Minor Service Outage');
});

test('classifyLiveResponse falls back to the page-level indicator when nothing named matches', () => {
  const data = { status: { indicator: 'none', description: 'All Systems Operational' }, components: [{ name: 'Something Renamed', status: 'operational' }] };
  const result = classifyLiveResponse(data, LIVE_SOURCES.claude);
  assert.deepEqual(result.components, []);
  assert.equal(result.level, 'ok');
  assert.equal(result.summary, 'All Systems Operational');
});

test('classifyLiveResponse never throws on a malformed body', () => {
  assert.deepEqual(classifyLiveResponse({}, LIVE_SOURCES.claude), { level: 'info', components: [], summary: null });
  assert.deepEqual(classifyLiveResponse(null, LIVE_SOURCES.claude), { level: 'info', components: [], summary: null });
  assert.deepEqual(classifyLiveResponse({ components: 'not-an-array' }, LIVE_SOURCES.claude), { level: 'info', components: [], summary: null });
});

function fakeFetchAlwaysOk() {
  return async () => ({
    ok: true,
    json: async () => ({ status: { indicator: 'none', description: 'All Systems Operational' }, components: [] }),
  });
}

test('fetchAllProviderStatus answers for every tool, live entries carrying a checkedAt and static ones not', async () => {
  const file = tmpFile();
  const result = await fetchAllProviderStatus({ fetchImpl: fakeFetchAlwaysOk(), now: 1000, file });
  for (const id of Object.keys(LIVE_SOURCES)) {
    assert.equal(result[id].tier, 'live', id);
    assert.equal(result[id].error, null, id);
    assert.equal(result[id].checkedAt, 1000, id);
  }
  for (const [id, def] of Object.entries(STATIC_SOURCES)) {
    assert.equal(result[id].tier, def.tier, id);
    assert.equal(result[id].pageUrl, def.pageUrl, id);
    assert.equal(result[id].summary, def.summary, id);
    assert.equal(result[id].checkedAt, null, `${id} was never actually checked over the network`);
  }
});

test('a live fetch that fails degrades to an honest unknown instead of throwing or guessing', async () => {
  const file = tmpFile();
  const flaky = async () => { throw new Error('network is down'); };
  const result = await fetchAllProviderStatus({ fetchImpl: flaky, now: 1000, file });
  assert.equal(result.claude.tier, 'live');
  assert.equal(result.claude.level, 'info');
  assert.equal(result.claude.error, 'unreachable');
  assert.ok(result.claude.summary, 'the card still has something to say about why');
});

test('a non-OK HTTP response is treated the same as a network failure', async () => {
  const file = tmpFile();
  const notFound = async () => ({ ok: false, status: 404 });
  const result = await fetchAllProviderStatus({ fetchImpl: notFound, now: 1000, file });
  assert.equal(result.codex.error, 'unreachable');
});

test('a fresh shared reading is served without calling the network again', async () => {
  const file = tmpFile();
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, json: async () => ({ status: { indicator: 'none' }, components: [] }) }; };
  await fetchAllProviderStatus({ fetchImpl: counting, now: 1000, file });
  assert.equal(calls, Object.keys(LIVE_SOURCES).length, 'one request per live source on the first call');
  await fetchAllProviderStatus({ fetchImpl: counting, now: 2000, file });
  assert.equal(calls, Object.keys(LIVE_SOURCES).length, 'the second call rode the shared cache instead of asking again');
});

test('force skips the cache Check-now sends this when the person asks for a fresh read', async () => {
  const file = tmpFile();
  let calls = 0;
  const counting = async () => { calls += 1; return { ok: true, json: async () => ({ status: { indicator: 'none' }, components: [] }) }; };
  await fetchAllProviderStatus({ fetchImpl: counting, now: 1000, file });
  await fetchAllProviderStatus({ fetchImpl: counting, now: 2000, file, force: true });
  assert.equal(calls, Object.keys(LIVE_SOURCES).length * 2);
});
