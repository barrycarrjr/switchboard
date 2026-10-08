/**
 * Safe DevTools cURL / Cookie Parser
 *
 * Direct, safe parser for "Copy as cURL (bash)" snippets copied from
 * browser Developer Tools (Chrome, Edge, Firefox, Safari).
 *
 * Security Guarantees:
 * 1. NEVER executes a shell or subprocess. Pure lexical tokenizer.
 * 2. 64 KB maximum payload size to prevent memory or ReDoS abuse.
 * 3. Rejects null bytes.
 * 4. Strict HTTPS validation and domain allowlist to prevent token exfiltration.
 */

export const DEFAULT_ALLOWED_DOMAINS = [
  'anthropic.com',
  'claude.ai',
  'openai.com',
  'chatgpt.com',
  'cursor.sh',
  'cursor.com',
  'github.com',
  'google.com',
];

export const MAX_CURL_SIZE = 64 * 1024; // 64 KB

/**
 * Tokenize a bash-style cURL command line safely into argument array.
 */
export function tokenizeBashArgs(commandLine) {
  const args = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  // Normalize line continuations (backslash followed by newline)
  const normalized = commandLine.replace(/\\\r?\n/g, ' ');

  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }

    if (char === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (char === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (/\s/.test(char) && !inSingleQuote && !inDoubleQuote) {
      if (current.length > 0) {
        args.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}

/**
 * Parse raw cookie header string into a key-value dictionary.
 */
export function parseCookieString(cookieStr) {
  const cookies = {};
  if (typeof cookieStr !== 'string') return cookies;

  const parts = cookieStr.split(';');
  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx > 0) {
      const name = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * Check if a hostname matches an allowed domain pattern.
 */
export function isAllowedHost(hostname, allowedDomains = DEFAULT_ALLOWED_DOMAINS) {
  if (!hostname) return false;
  const host = hostname.toLowerCase();
  return allowedDomains.some((domain) => {
    const d = domain.toLowerCase();
    return host === d || host.endsWith('.' + d);
  });
}

/**
 * Infer AI/model provider based on hostname.
 */
export function inferProvider(hostname) {
  if (!hostname) return null;
  const host = hostname.toLowerCase();
  if (host === 'claude.ai' || host.endsWith('.anthropic.com')) return 'claude';
  if (host === 'chatgpt.com' || host.endsWith('.openai.com')) return 'chatgpt';
  if (host.endsWith('cursor.com') || host.endsWith('cursor.sh')) return 'cursor';
  if (host.endsWith('github.com')) return 'github';
  if (host.endsWith('google.com')) return 'google';
  return null;
}

/**
 * Safely parse a DevTools cURL command snippet.
 *
 * @param {string} curlText - Copied curl command string
 * @param {object} [options]
 * @param {string[]} [options.allowedDomains] - List of permitted domains
 * @param {boolean} [options.allowAnyHost] - Skip domain allowlist check if true
 * @param {number} [options.maxSize] - Max byte length permitted
 */
export function parseCurlCommand(curlText, options = {}) {
  const {
    allowedDomains = DEFAULT_ALLOWED_DOMAINS,
    allowAnyHost = false,
    maxSize = MAX_CURL_SIZE,
  } = options;

  if (typeof curlText !== 'string' || !curlText.trim()) {
    return { ok: false, error: 'empty-command' };
  }

  if (curlText.length > maxSize) {
    return { ok: false, error: 'payload-too-large' };
  }

  if (curlText.includes('\0')) {
    return { ok: false, error: 'contains-null-byte' };
  }

  const trimmed = curlText.trim();
  if (!trimmed.toLowerCase().startsWith('curl')) {
    return { ok: false, error: 'not-a-curl-command' };
  }

  const args = tokenizeBashArgs(trimmed);
  if (args.length < 2 || args[0].toLowerCase() !== 'curl') {
    return { ok: false, error: 'invalid-curl-syntax' };
  }

  let rawUrl = null;
  const headers = {};
  let rawCookies = null;

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];

    if (arg === '-H' || arg === '--header') {
      const headerVal = args[++i];
      if (headerVal) {
        const colonIdx = headerVal.indexOf(':');
        if (colonIdx > 0) {
          const name = headerVal.slice(0, colonIdx).trim().toLowerCase();
          const val = headerVal.slice(colonIdx + 1).trim();
          headers[name] = val;
          if (name === 'cookie') {
            rawCookies = val;
          }
        }
      }
    } else if (arg === '-b' || arg === '--cookie') {
      const cookieVal = args[++i];
      if (cookieVal) {
        rawCookies = cookieVal;
      }
    } else if (arg === '--url') {
      rawUrl = args[++i];
    } else if (!arg.startsWith('-') && !rawUrl) {
      // Positional argument likely the URL
      rawUrl = arg;
    }
  }

  if (!rawUrl) {
    return { ok: false, error: 'missing-url' };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return { ok: false, error: 'invalid-url' };
  }

  if (parsedUrl.protocol !== 'https:') {
    return { ok: false, error: 'insecure-protocol' };
  }

  if (!allowAnyHost && !isAllowedHost(parsedUrl.hostname, allowedDomains)) {
    return { ok: false, error: 'disallowed-host' };
  }

  const cookies = parseCookieString(rawCookies);
  const authorization = headers['authorization'] || null;
  const provider = inferProvider(parsedUrl.hostname);

  return {
    ok: true,
    url: parsedUrl.href,
    hostname: parsedUrl.hostname,
    provider,
    headers,
    cookies,
    rawCookies,
    authorization,
  };
}
