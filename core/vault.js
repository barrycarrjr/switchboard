import crypto from 'node:crypto';
import os from 'node:os';

const SALT = 'switchboard-vault-salt-v1';
const PREFIX = 'enc:v1:';

let activeDriver = null;

/**
 * Register a platform or environment driver (e.g. Electron safeStorage DPAPI on Windows).
 * Driver must provide:
 *   - id: string identifier (e.g. 'dpapi')
 *   - encrypt(plainText: string) -> string (base64 or hex)
 *   - decrypt(cipherText: string) -> string
 */
export function registerVaultDriver(driver) {
  if (driver && typeof driver.encrypt === 'function' && typeof driver.decrypt === 'function') {
    activeDriver = driver;
  }
}

/**
 * Reset registered driver to default pure-Node AES-256-GCM (useful for test isolation).
 */
export function resetVaultDriver() {
  activeDriver = null;
}

/**
 * Return whether a value is an encrypted secret payload.
 */
export function isEncrypted(val) {
  return typeof val === 'string' && val.startsWith(PREFIX);
}

/**
 * Derive a 256-bit machine-and-user bound key for pure Node execution.
 */
function deriveDefaultKey() {
  const username = os.userInfo?.()?.username || process.env.USERNAME || process.env.USER || 'switchboard-user';
  const hostname = os.hostname?.() || 'switchboard-host';
  const homedir = os.homedir?.() || '';
  const seed = `${username}@${hostname}:${homedir}`;
  return crypto.pbkdf2Sync(seed, SALT, 10000, 32, 'sha256');
}

/**
 * Default AES-256-GCM encryption.
 */
function encryptDefault(plaintext) {
  const key = deriveDefaultKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let enc = cipher.update(plaintext, 'utf8', 'hex');
  enc += cipher.final('hex');
  const tag = cipher.getAuthTag();
  return `${PREFIX}aes-gcm:${iv.toString('hex')}:${tag.toString('hex')}:${enc}`;
}

/**
 * Default AES-256-GCM decryption.
 */
function decryptDefault(ivHex, tagHex, dataHex) {
  try {
    const key = deriveDefaultKey();
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(dataHex, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
  } catch {
    return null;
  }
}

/**
 * Protect a secret string (API key, token, credential).
 * Returns encrypted string prefixed with enc:v1:
 */
export function protectSecret(plaintext) {
  if (typeof plaintext !== 'string' || !plaintext.trim()) return plaintext;
  if (isEncrypted(plaintext)) return plaintext;

  if (activeDriver) {
    try {
      const driverId = activeDriver.id || 'custom';
      const enc = activeDriver.encrypt(plaintext);
      return `${PREFIX}${driverId}:${enc}`;
    } catch {
      // Fallback to default AES-GCM if active driver fails
    }
  }

  return encryptDefault(plaintext);
}

/**
 * Decrypt a protected secret string.
 * Returns decrypted plaintext, or original value if not encrypted or unreadable.
 */
export function unprotectSecret(ciphertext) {
  if (typeof ciphertext !== 'string' || !isEncrypted(ciphertext)) return ciphertext;

  const body = ciphertext.slice(PREFIX.length);
  const parts = body.split(':');
  const scheme = parts[0];

  if (activeDriver && activeDriver.id === scheme) {
    try {
      const payload = parts.slice(1).join(':');
      return activeDriver.decrypt(payload);
    } catch {
      // Fall through to error
    }
  }

  if (scheme === 'aes-gcm' && parts.length === 4) {
    const dec = decryptDefault(parts[1], parts[2], parts[3]);
    if (dec !== null) return dec;
  }

  // If active driver is registered and matches custom scheme
  if (activeDriver && typeof activeDriver.decrypt === 'function') {
    try {
      const payload = parts.slice(1).join(':');
      return activeDriver.decrypt(payload);
    } catch {}
  }

  // If cannot decrypt, return null rather than corrupting
  return null;
}

/**
 * Protect specified secret keys in an object.
 */
export function protectObject(obj, secretKeys = ['token', 'apiKey', 'secret']) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const [k, v] of Object.entries(result)) {
    if (secretKeys.includes(k) && typeof v === 'string') {
      result[k] = protectSecret(v);
    } else if (v && typeof v === 'object') {
      result[k] = protectObject(v, secretKeys);
    }
  }
  return result;
}

/**
 * Unprotect specified secret keys in an object.
 */
export function unprotectObject(obj, secretKeys = ['token', 'apiKey', 'secret']) {
  if (!obj || typeof obj !== 'object') return obj;
  const result = Array.isArray(obj) ? [...obj] : { ...obj };
  for (const [k, v] of Object.entries(result)) {
    if (secretKeys.includes(k) && typeof v === 'string') {
      result[k] = unprotectSecret(v) ?? v;
    } else if (v && typeof v === 'object') {
      result[k] = unprotectObject(v, secretKeys);
    }
  }
  return result;
}
