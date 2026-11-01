/**
 * Low-level provider-agnostic scheduled automations for Switchboard.
 *
 * Switchboard automations are machine-level, provider-agnostic scheduled
 * prompts or maintenance routines that execute through Switchboard's lane failover
 * pool (`switchboard run`) or a specified CLI harness.
 */

import fs from 'node:fs';
import { automationsFile, writeJsonAtomic } from './paths.js';

export const AUTOMATION_INTERVAL_PRESETS = [
  { minutes: 60, label: 'Every hour' },
  { minutes: 360, label: 'Every 6 hours' },
  { minutes: 720, label: 'Every 12 hours' },
  { minutes: 1440, label: 'Daily (24h)' },
  { minutes: 10080, label: 'Weekly (7d)' },
];

export function loadAutomations(file = automationsFile()) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const list = Array.isArray(raw?.automations) ? raw.automations : [];
    return { automations: list.map(normalizeAutomation).filter(Boolean) };
  } catch {
    return { automations: [] };
  }
}

export function saveAutomations(state, file = automationsFile()) {
  const list = Array.isArray(state?.automations) ? state.automations : [];
  writeJsonAtomic(file, {
    version: 1,
    automations: list.map(normalizeAutomation).filter(Boolean),
  });
}

function normalizeAutomation(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = String(entry.id ?? '').trim();
  const name = String(entry.name ?? '').trim();
  const prompt = String(entry.prompt ?? '').trim();
  if (!id || !name || !prompt) return null;
  const intervalMinutes = Math.max(5, Math.min(43200, Number(entry.intervalMinutes) || 1440));
  return {
    id,
    name,
    prompt,
    cwd: String(entry.cwd ?? '').trim() || null,
    laneId: String(entry.laneId ?? '').trim() || null,
    enabled: entry.enabled !== false,
    intervalMinutes,
    createdAt: Number(entry.createdAt) || Date.now(),
    lastRunAt: Number(entry.lastRunAt) || null,
    lastStatus: entry.lastStatus ? String(entry.lastStatus) : null,
    lastSummary: entry.lastSummary ? String(entry.lastSummary).slice(0, 500) : null,
  };
}

export function addAutomation(state, payload = {}) {
  const name = String(payload.name ?? '').trim();
  const prompt = String(payload.prompt ?? '').trim();
  if (!name) throw new Error('Automation name is required.');
  if (!prompt) throw new Error('Automation prompt is required.');
  const intervalMinutes = Math.max(5, Math.min(43200, Number(payload.intervalMinutes) || 1440));
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'routine';
  const id = payload.id
    ? String(payload.id).trim()
    : `auto-${slug}-${Date.now().toString(36).slice(-5)}`;
  const item = normalizeAutomation({
    id,
    name,
    prompt,
    cwd: payload.cwd || null,
    laneId: payload.laneId || null,
    enabled: payload.enabled !== false,
    intervalMinutes,
    createdAt: Date.now(),
  });
  const list = Array.isArray(state?.automations) ? [...state.automations] : [];
  const idx = list.findIndex((a) => a.id === item.id);
  if (idx >= 0) list[idx] = item;
  else list.push(item);
  state.automations = list;
  return item;
}

export function removeAutomation(state, id) {
  const list = Array.isArray(state?.automations) ? state.automations : [];
  const before = list.length;
  state.automations = list.filter((a) => a.id !== id);
  return state.automations.length < before;
}

export function toggleAutomation(state, id, enabled = null) {
  const list = Array.isArray(state?.automations) ? state.automations : [];
  const target = list.find((a) => a.id === id);
  if (!target) throw new Error(`Automation not found: ${id}`);
  target.enabled = enabled == null ? !target.enabled : Boolean(enabled);
  return target;
}

export function dueAutomations(state, now = Date.now()) {
  const list = Array.isArray(state?.automations) ? state.automations : [];
  return list.filter((a) => {
    if (!a.enabled) return false;
    if (!a.lastRunAt) return true;
    const elapsedMs = now - a.lastRunAt;
    return elapsedMs >= a.intervalMinutes * 60 * 1000;
  });
}

export function recordAutomationRun(state, id, { status = 'ok', summary = '', ranAt = Date.now() } = {}) {
  const list = Array.isArray(state?.automations) ? state.automations : [];
  const target = list.find((a) => a.id === id);
  if (!target) return null;
  target.lastRunAt = ranAt;
  target.lastStatus = status;
  target.lastSummary = String(summary ?? '').slice(0, 500);
  return target;
}
