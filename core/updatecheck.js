import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { isNewerVersion } from './providers.js';

const run = promisify(execFile);

/**
 * Self-update against a GitHub repository's Releases. Public repositories work with
 * plain HTTPS (no tooling, no token). Private repositories fall back to the USER'S
 * own GitHub CLI login; no token ever ships in the app or gets stored by it. The
 * repo slug ("owner/name") comes from local settings or is stamped into release
 * builds by CI; the committed source stays name-free.
 */

export function validRepoSlug(slug) {
  return /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(String(slug ?? ''));
}

async function gh(args, execFn) {
  return execFn('gh', args, { windowsHide: true, timeout: 60000, shell: process.platform === 'win32' });
}

function classifyGhError(e) {
  const text = String(e.stderr || e.message || '');
  if (/not recognized|not found|ENOENT/i.test(text)) return 'no-gh';
  if (/HTTP 404/i.test(text)) return 'no-release';
  if (/auth|login|credentials/i.test(text)) return 'no-auth';
  return 'api';
}

async function publicLatest(repo, fetchImpl) {
  const resp = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (resp.status === 404) return { private: true }; // or missing; the gh fallback settles it
  if (!resp.ok) return { error: 'api' };
  const body = await resp.json();
  const asset = (body.assets || []).find((a) => /^Switchboard-Setup-.*\.exe$/.test(a.name));
  return { tag: body.tag_name, assetUrl: asset?.browser_download_url ?? null, assetName: asset?.name ?? null };
}

/** Check the latest release. Errors are named, never guessed. */
export async function checkAppUpdate({ repo, currentVersion, fetchImpl = fetch, execFn = run }) {
  if (!validRepoSlug(repo)) return { error: 'no-repo' };

  let tag = null;
  let assetUrl = null;
  try {
    const pub = await publicLatest(repo, fetchImpl);
    if (pub.tag) ({ tag, assetUrl } = pub);
    else if (pub.error) return { error: pub.error };
  } catch { /* offline or blocked; try gh below */ }

  if (!tag) {
    try {
      const { stdout } = await gh(['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], execFn);
      tag = stdout.trim();
    } catch (e) {
      return { error: classifyGhError(e) };
    }
  }
  if (!tag) return { error: 'api' };

  const newer = isNewerVersion(tag, currentVersion);
  if (newer == null) return { error: 'api' };
  return { available: newer, tag, assetUrl };
}

/** Download the release installer into dir and return its path. Reports progress. */
export async function downloadUpdate({ repo, tag, assetUrl, dir, fetchImpl = fetch, execFn = run, onProgress = null }) {
  if (assetUrl) {
    const resp = await fetchImpl(assetUrl);
    if (resp.ok) {
      const name = decodeURIComponent(new URL(assetUrl).pathname.split('/').pop());
      const file = path.join(dir, name);
      const total = Number(resp.headers?.get?.('content-length')) || null;
      if (resp.body?.getReader) {
        const reader = resp.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(Buffer.from(value));
          received += value.byteLength;
          if (onProgress) onProgress(received, total);
        }
        fs.writeFileSync(file, Buffer.concat(chunks));
      } else {
        fs.writeFileSync(file, Buffer.from(await resp.arrayBuffer()));
        if (onProgress) onProgress(1, 1);
      }
      return file;
    }
  }
  if (!validRepoSlug(repo)) throw new Error('no update source configured');
  await gh(['release', 'download', tag, '--repo', repo, '--pattern', 'Switchboard-Setup-*.exe', '--dir', dir, '--clobber'], execFn);
  const exe = fs.readdirSync(dir).find((f) => /^Switchboard-Setup-.*\.exe$/.test(f));
  if (!exe) throw new Error('the release had no installer asset');
  return path.join(dir, exe);
}
