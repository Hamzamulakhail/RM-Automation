import { base64ToBytes, base64UrlEncode, decryptText, encryptText } from './crypto.js';
import { MAX_MEDIA_BYTES } from './pairing.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

let cachedSigningKey = null;
let cachedSaEmail = null;

export function getServiceAccount(env) {
  const raw = env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON secret is not configured');
  }
  let parsed;
  try {
    parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON missing client_email or private_key');
  }
  return parsed;
}

async function importServiceAccountKey(sa) {
  if (cachedSigningKey && cachedSaEmail === sa.client_email) {
    return cachedSigningKey;
  }
  const pemBody = sa.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const keyBytes = base64ToBytes(pemBody);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBytes.buffer,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  cachedSigningKey = key;
  cachedSaEmail = sa.client_email;
  return key;
}

export async function getDriveAccessToken(env) {
  const now = Date.now();
  try {
    const cached = await env.DB.prepare(
      `SELECT token, expires_at FROM cached_tokens WHERE cache_key = 'google_drive_sa'`
    ).first();
    if (cached && Number(cached.expires_at) > now + 60_000) {
      return await decryptText(cached.token, env.ENCRYPTION_KEY);
    }
  } catch {
    // Ignore cache read/decrypt error and mint a fresh token
  }

  const sa = getServiceAccount(env);
  const key = await importServiceAccountKey(sa);

  const nowSec = Math.floor(now / 1000);
  const headerB64 = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimsB64 = base64UrlEncode(
    JSON.stringify({
      iss: sa.client_email,
      scope: DRIVE_SCOPE,
      aud: sa.token_uri || GOOGLE_TOKEN_URL,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );

  const signingInput = `${headerB64}.${claimsB64}`;
  const sig = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64UrlEncode(new Uint8Array(sig))}`;

  const tokenRes = await fetch(sa.token_uri || GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });

  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    throw new Error(
      `Google OAuth token exchange failed (${tokenRes.status}): ${tokenData.error_description || tokenData.error || 'unknown error'}`
    );
  }

  const expiresAt = now + 50 * 60 * 1000;
  const encrypted = await encryptText(tokenData.access_token, env.ENCRYPTION_KEY);
  await env.DB.prepare(
    `INSERT INTO cached_tokens (cache_key, token, expires_at) VALUES ('google_drive_sa', ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`
  )
    .bind(encrypted, expiresAt)
    .run();

  return tokenData.access_token;
}

async function driveFetch(env, url, options = {}) {
  const token = await getDriveAccessToken(env);
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);
  const res = await fetch(url, { ...options, headers });
  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    let msg = `Drive API error ${res.status}`;
    try {
      const parsed = JSON.parse(errBody);
      if (parsed?.error?.message) msg = `Drive API (${res.status}): ${parsed.error.message}`;
    } catch {
      if (errBody) msg = `Drive API (${res.status}): ${errBody.slice(0, 200)}`;
    }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

export async function listSharedFolders(env) {
  const q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,capabilities(canEdit),driveId)',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    pageSize: '200',
    orderBy: 'name',
  });
  const res = await driveFetch(env, `${DRIVE_API}/files?${params.toString()}`);
  const data = await res.json();
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    canEdit: Boolean(f.capabilities?.canEdit),
  }));
}

export async function getFolderMetadata(env, folderId) {
  const params = new URLSearchParams({
    fields: 'id,name,trashed,capabilities(canEdit)',
    supportsAllDrives: 'true',
  });
  const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(folderId)}?${params.toString()}`);
  return res.json();
}

export async function listMediaFiles(env, folderId) {
  const safeId = folderId.replace(/'/g, "\\'");
  const q = `'${safeId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  const files = [];
  let pageToken = '';

  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      q,
      fields: 'nextPageToken,files(id,name,mimeType,size)',
      includeItemsFromAllDrives: 'true',
      supportsAllDrives: 'true',
      pageSize: '200',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const res = await driveFetch(env, `${DRIVE_API}/files?${params.toString()}`);
    const data = await res.json();
    if (Array.isArray(data.files)) {
      files.push(...data.files);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return files;
}

export async function findCaptionsFile(env, folderId) {
  const safeId = folderId.replace(/'/g, "\\'");
  const q = `'${safeId}' in parents and name = 'captions.txt' and trashed = false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,version,capabilities(canEdit))',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    pageSize: '5',
  });
  const res = await driveFetch(env, `${DRIVE_API}/files?${params.toString()}`);
  const data = await res.json();
  return data.files?.[0] || null;
}

export async function downloadTextFile(env, fileId) {
  const res = await driveFetch(
    env,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`
  );
  return res.text();
}

function guessMimeType(filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

export async function downloadMediaBlob(env, file) {
  const declaredSize = Number(file.size || 0);
  if (declaredSize > MAX_MEDIA_BYTES) {
    const mb = (declaredSize / (1024 * 1024)).toFixed(1);
    const err = new Error(`File "${file.name}" is ${mb} MB, which exceeds the 100 MB limit`);
    err.isTooLarge = true;
    throw err;
  }
  const res = await driveFetch(
    env,
    `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`
  );
  const buf = await res.arrayBuffer();
  if (buf.byteLength > MAX_MEDIA_BYTES) {
    const mb = (buf.byteLength / (1024 * 1024)).toFixed(1);
    const err = new Error(`File "${file.name}" is ${mb} MB, which exceeds the 100 MB limit`);
    err.isTooLarge = true;
    throw err;
  }
  const mime = file.mimeType || guessMimeType(file.name);
  return new Blob([buf], { type: mime });
}

export async function updateTextFile(env, fileId, text) {
  const res = await driveFetch(
    env,
    `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: text,
    }
  );
  return res.json();
}

export async function trashFile(env, fileId) {
  const res = await driveFetch(
    env,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    }
  );
  return res.json();
}
