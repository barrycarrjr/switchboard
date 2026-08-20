import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './paths.js';

const MAX_HANDOFF_SIZE = 4096; // 4 KB target

const REDACT_PATTERNS = [
  new RegExp('sk' + '-ant-api03-[a-zA-Z0-9_-]{90,}', 'g'), // Anthropic API Key
  new RegExp('ya29' + '\\.[a-zA-Z0-9_-]+', 'g'),             // Google OAuth Token
  new RegExp('gh[pousr]_[a-zA-Z0-9]{36,}', 'g'),       // GitHub Token
  new RegExp('sk' + '-[a-zA-Z0-9]{48,}', 'g'),              // OpenAI API Key
];

function redact(text) {
  if (!text) return '';
  let safe = text;
  for (const pattern of REDACT_PATTERNS) {
    safe = safe.replace(pattern, '***REDACTED***');
  }
  return safe;
}

export function getHandoffPath(workspaceDir) {
  const normalized = path.resolve(workspaceDir).toLowerCase();
  const hash = crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
  const dir = path.join(dataDir(), 'handoffs');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${hash}.md`);
}

export function writeHandoff(workspaceDir, data) {
  const filePath = getHandoffPath(workspaceDir);
  const content = formatHandoff(data);
  
  if (Buffer.byteLength(content, 'utf8') > MAX_HANDOFF_SIZE) {
    throw new Error('Handoff document exceeds 4 KB size limit');
  }

  // Atomic write via temp file
  const tempPath = `${filePath}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, content, 'utf8');
  fs.renameSync(tempPath, filePath);
  
  return filePath;
}

export function readHandoff(workspaceDir) {
  const filePath = getHandoffPath(workspaceDir);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

export function formatHandoff(data = {}) {
  const section = (title, content) => {
    const safeContent = redact(String(content || 'None provided').trim());
    return `${title}:\n${safeContent}\n`;
  };

  return [
    '# Task handoff\n',
    section('Objective', data.objective),
    section('Constraints', data.constraints),
    section('Decisions made', data.decisions),
    section('Current repository state', data.state),
    section('Next actions', data.nextActions),
    section('Verification already run', data.verification),
    section('Blockers or risks', data.blockers)
  ].join('\n').trim() + '\n';
}

export function generateHandoffPrompt(workspaceDir) {
  const filePath = getHandoffPath(workspaceDir);
  return `Read ${filePath} and continue from its Next actions section.`;
}
