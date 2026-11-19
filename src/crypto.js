const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function base64ToBytes(b64) {
  const clean = b64.replace(/\s+/g, '');
  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

export function bytesToBase64(bytes) {
  let bin = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(bin);
}

export function base64UrlEncode(input) {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input;
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlDecodeToBytes(str) {
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  return base64ToBytes(b64);
}

export function base64UrlDecodeToString(str) {
  return decoder.decode(base64UrlDecodeToBytes(str));
}

export async function constantTimeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const [hashA, hashB] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const bytesA = new Uint8Array(hashA);
  const bytesB = new Uint8Array(hashB);
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

async function importAesKey(encryptionKeyBase64) {
  if (!encryptionKeyBase64) {
    throw new Error('ENCRYPTION_KEY secret is not configured');
  }
  const raw = base64ToBytes(encryptionKeyBase64);
  if (raw.byteLength !== 32) {
    throw new Error('ENCRYPTION_KEY must be base64-encoded 32 bytes');
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function encryptText(plaintext, encryptionKeyBase64) {
  const key = await importAesKey(encryptionKeyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(plaintext)
  );
  return `v1:${bytesToBase64(iv)}:${bytesToBase64(new Uint8Array(encrypted))}`;
}

export async function decryptText(ciphertext, encryptionKeyBase64) {
  if (!ciphertext || typeof ciphertext !== 'string') {
    throw new Error('Missing encrypted value');
  }
  const parts = ciphertext.split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('Unsupported ciphertext format');
  }
  const key = await importAesKey(encryptionKeyBase64);
  const iv = base64ToBytes(parts[1]);
  const data = base64ToBytes(parts[2]);
  const decrypted = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    data
  );
  return decoder.decode(decrypted);
}

async function importHmacKey(secret) {
  if (!secret) {
    throw new Error('SESSION_SECRET is not configured');
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function signToken(payload, secret) {
  const key = await importHmacKey(secret);
  const body = base64UrlEncode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(body));
  return `${body}.${base64UrlEncode(new Uint8Array(sig))}`;
}

export async function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const dotIdx = token.indexOf('.');
  if (dotIdx <= 0) return null;
  const body = token.slice(0, dotIdx);
  const sigB64 = token.slice(dotIdx + 1);
  if (!body || !sigB64) return null;

  try {
    const key = await importHmacKey(secret);
    const sigBytes = base64UrlDecodeToBytes(sigB64);
    const valid = await crypto.subtle.verify('HMAC', key, sigBytes, encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(base64UrlDecodeToString(body));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(input)));
  const bytes = new Uint8Array(digest);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function generateRandomToken(byteLen = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLen));
  return base64UrlEncode(bytes);
}
