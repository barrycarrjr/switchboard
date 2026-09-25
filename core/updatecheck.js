import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { isNewerVersion } from './providers.js';

const run = promisify(execFile);

/**
 * Self-update against a GitHub repository's Releases. Public repositories work with
 * plain HTTPS (no tooling, no token). Private repositories fall back to the USER'S
 * own GitHub CLI login, and so does a public one whenever GitHub refuses the request
 * made without it (see rateLimit); no token ever ships in the app or gets stored by it. The
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

/**
 * Whether GitHub refused a request for going over its rate limit, and when the limit lifts.
 *
 * Without signing in, GitHub allows 60 API requests an hour per network address, and
 * everything on that network draws on the same 60. So this check can be refused through no
 * fault of its own. On 2026-09-25 it was, and the app said only "Update check failed; try
 * again later" on a machine whose signed-in gh could have answered at once. GitHub marks the
 * refusal as a 403 or 429 with no requests remaining, or with a Retry-After.
 */
function rateLimit(resp, now) {
  if (resp.status !== 403 && resp.status !== 429) return null;
  const header = (name) => resp.headers?.get?.(name) ?? null;
  const retryAfter = header('retry-after');
  if (header('x-ratelimit-remaining') !== '0' && retryAfter == null) return null;
  const reset = Number(header('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return { resetAt: reset * 1000 };
  const wait = Number(retryAfter);
  return { resetAt: retryAfter != null && Number.isFinite(wait) && wait >= 0 ? now + wait * 1000 : null };
}

async function publicLatest(repo, fetchImpl, now) {
  const resp = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json' },
  });
  if (resp.status === 404) return { private: true }; // or missing; the gh fallback settles it
  // Refused, which is not the same as missing: gh is asked next, and the refusal is kept in
  // case gh cannot answer either.
  if (!resp.ok) return { refused: true, limit: rateLimit(resp, now) };
  const body = await resp.json();
  const asset = (body.assets || []).find((a) => /^Switchboard-Setup-.*\.exe$/.test(a.name));
  return { tag: body.tag_name, assetUrl: asset?.browser_download_url ?? null, assetName: asset?.name ?? null };
}

/**
 * Check the latest release. Errors are named, never guessed.
 *
 * A rate limit comes back as `{ error: 'rate-limited', resetAt, ghError }`: when the limit
 * lifts (null if GitHub did not say), and why gh could not stand in, so the words shown can
 * suggest signing in only when that is what was missing.
 */
export async function checkAppUpdate({ repo, currentVersion, fetchImpl = fetch, execFn = run, now = Date.now() }) {
  if (!validRepoSlug(repo)) return { error: 'no-repo' };

  let tag = null;
  let assetUrl = null;
  let refused = null;
  try {
    const pub = await publicLatest(repo, fetchImpl, now);
    if (pub.tag) ({ tag, assetUrl } = pub);
    else if (pub.refused) refused = pub;
  } catch { /* offline or blocked; try gh below */ }

  if (!tag) {
    try {
      const { stdout } = await gh(['api', `repos/${repo}/releases/latest`, '--jq', '.tag_name'], execFn);
      tag = stdout.trim();
    } catch (e) {
      const ghError = classifyGhError(e);
      // After a refusal, gh's own errors would point the wrong way: "no-gh" is worded for a
      // private repository, and nothing said this one was private. The refusal is what
      // stopped the check, so it is what gets reported.
      if (refused?.limit) return { error: 'rate-limited', resetAt: refused.limit.resetAt, ghError };
      if (refused) return { error: 'api' };
      return { error: ghError };
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
