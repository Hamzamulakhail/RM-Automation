import { base64ToBytes, base64UrlEncode, decryptText, encryptText } from './crypto.js';
import { MAX_MEDIA_BYTES } from './pairing.js';

const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';
const DRIVE_OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/userinfo.email';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';

let cachedSigningKey = null;
let cachedSaEmail = null;

export function isGoogleOAuthConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

export function buildGoogleOAuthUrl(env, origin, state) {
  if (!isGoogleOAuthConfigured(env)) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not configured');
  }
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: `${origin}/auth/google/callback`,
    response_type: 'code',
    scope: DRIVE_OAUTH_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export async function exchangeGoogleCode(env, origin, code) {
  if (!isGoogleOAuthConfigured(env)) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are not configured');
  }
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: `${origin}/auth/google/callback`,
      grant_type: 'authorization_code',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error(data.error_description || data.error || `Google token exchange failed (${res.status})`);
  }

  let email = '';
  try {
    const uRes = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${data.access_token}` },
    });
    if (uRes.ok) {
      const uData = await uRes.json().catch(() => ({}));
      email = uData.email || '';
    }
  } catch {
    // Email lookup optional
  }

  if (!email) {
    try {
      const aboutRes = await fetch(`${DRIVE_API}/about?fields=user(emailAddress)`, {
        headers: { Authorization: `Bearer ${data.access_token}` },
      });
      if (aboutRes.ok) {
        const aboutData = await aboutRes.json().catch(() => ({}));
        email = aboutData?.user?.emailAddress || '';
      }
    } catch {
      // Ignore
    }
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || '',
    expiresIn: Number(data.expires_in || 3600),
    email: email || 'Google Drive',
  };
}

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

export async function getWorkspaceGoogleOAuth(env, licenseId = null) {
  if (licenseId) {
    const row = await env.DB.prepare(
      `SELECT google_email, google_encrypted_refresh_token, google_connected_at FROM licenses WHERE id = ?`
    )
      .bind(licenseId)
      .first();
    if (row?.google_encrypted_refresh_token) {
      return {
        email: row.google_email || 'Google Drive',
        encryptedRefreshToken: row.google_encrypted_refresh_token,
        connectedAt: row.google_connected_at || null,
      };
    }
    return null;
  }

  const rows = await env.DB.prepare(
    `SELECT key, value FROM settings WHERE key IN ('google_oauth_email', 'google_oauth_refresh_token', 'google_oauth_connected_at')`
  ).all();
  const map = new Map((rows.results || []).map((r) => [r.key, r.value]));
  const enc = map.get('google_oauth_refresh_token');
  if (!enc) return null;
  return {
    email: map.get('google_oauth_email') || 'Google Drive',
    encryptedRefreshToken: enc,
    connectedAt: map.get('google_oauth_connected_at') || null,
  };
}

export async function getDriveConnectionInfo(env, licenseId = null) {
  const oauthAvailable = isGoogleOAuthConfigured(env);
  const oauthConn = await getWorkspaceGoogleOAuth(env, licenseId);

  let serviceAccountEmail = null;
  if (!licenseId) {
    try {
      serviceAccountEmail = getServiceAccount(env).client_email;
    } catch {
      serviceAccountEmail = null;
    }
  }

  if (oauthConn) {
    return {
      configured: true,
      mode: 'oauth',
      googleOAuthAvailable: oauthAvailable,
      googleEmail: oauthConn.email,
      connectedAt: oauthConn.connectedAt,
      serviceAccountEmail,
    };
  }

  if (serviceAccountEmail) {
    return {
      configured: true,
      mode: 'service_account',
      googleOAuthAvailable: oauthAvailable,
      googleEmail: null,
      connectedAt: null,
      serviceAccountEmail,
    };
  }

  return {
    configured: false,
    mode: 'none',
    googleOAuthAvailable: oauthAvailable,
    googleEmail: null,
    connectedAt: null,
    serviceAccountEmail: null,
    error: oauthAvailable
      ? 'Google Drive is not connected yet. Sign in with Google to connect your Drive.'
      : 'Google OAuth (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) is not configured on the server.',
  };
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

async function getOAuthAccessToken(env, licenseId, oauthConn) {
  const cacheKey = `google_oauth:${licenseId ? String(licenseId) : 'admin'}`;
  const now = Date.now();
  try {
    const cached = await env.DB.prepare(
      `SELECT token, expires_at FROM cached_tokens WHERE cache_key = ?`
    )
      .bind(cacheKey)
      .first();
    if (cached && Number(cached.expires_at) > now + 60_000) {
      return await decryptText(cached.token, env.ENCRYPTION_KEY);
    }
  } catch {
    // Cache miss or decrypt error -> refresh below
  }

  if (!isGoogleOAuthConfigured(env)) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET secrets are required to refresh Google Drive token');
  }

  const refreshToken = await decryptText(oauthConn.encryptedRefreshToken, env.ENCRYPTION_KEY);
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    if (data.error === 'invalid_grant') {
      throw new Error('Google Drive authorization expired or was revoked. Please sign in with Google again.');
    }
    throw new Error(
      `Google Drive token refresh failed (${res.status}): ${data.error_description || data.error || 'unknown error'}`
    );
  }

  const ttlMs = Math.max(300_000, (Number(data.expires_in || 3600) - 600) * 1000);
  const expiresAt = now + ttlMs;
  const encrypted = await encryptText(data.access_token, env.ENCRYPTION_KEY);
  await env.DB.prepare(
    `INSERT INTO cached_tokens (cache_key, token, expires_at) VALUES (?, ?, ?)
     ON CONFLICT(cache_key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`
  )
    .bind(cacheKey, encrypted, expiresAt)
    .run();

  return data.access_token;
}

export async function getDriveAccessToken(env, licenseId = null) {
  const oauthConn = await getWorkspaceGoogleOAuth(env, licenseId);
  if (oauthConn) {
    return getOAuthAccessToken(env, licenseId, oauthConn);
  }

  if (licenseId) {
    throw new Error('Google Drive is not connected for this license. Please sign in with Google.');
  }

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

async function driveFetch(env, url, options = {}, licenseId = null) {
  const token = await getDriveAccessToken(env, licenseId);
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

export async function listSharedFolders(env, licenseId = null) {
  const q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,capabilities(canEdit),driveId)',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    pageSize: '200',
    orderBy: 'name',
  });
  const res = await driveFetch(env, `${DRIVE_API}/files?${params.toString()}`, {}, licenseId);
  const data = await res.json();
  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    canEdit: Boolean(f.capabilities?.canEdit),
  }));
}

export async function getFolderMetadata(env, folderId, licenseId = null) {
  const params = new URLSearchParams({
    fields: 'id,name,trashed,capabilities(canEdit)',
    supportsAllDrives: 'true',
  });
  const res = await driveFetch(env, `${DRIVE_API}/files/${encodeURIComponent(folderId)}?${params.toString()}`, {}, licenseId);
  return res.json();
}

export async function listMediaFiles(env, folderId, licenseId = null) {
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
    const res = await driveFetch(env, `${DRIVE_API}/files?${params.toString()}`, {}, licenseId);
    const data = await res.json();
    if (Array.isArray(data.files)) {
      files.push(...data.files);
    }
    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }
  return files;
}

const GOOGLE_DOC_MIME = 'application/vnd.google-apps.document';
const CAPTION_NAME_PRIORITY = ['captions.txt', 'caption.txt', 'captions', 'caption'];

export async function findCaptionsFile(env, folderId, licenseId = null) {
  const safeId = folderId.replace(/'/g, "\\'");
  const q = `'${safeId}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name,mimeType,version,capabilities(canEdit))',
    includeItemsFromAllDrives: 'true',
    supportsAllDrives: 'true',
    pageSize: '60',
  });
  const res = await driveFetch(env, `${DRIVE_API}/files?${params.toString()}`, {}, licenseId);
  const data = await res.json();
  const candidates = (data.files || []).filter((f) => {
    const lower = String(f.name || '').trim().toLowerCase();
    if (!CAPTION_NAME_PRIORITY.includes(lower)) return false;
    const isGoogleDoc = f.mimeType === GOOGLE_DOC_MIME;
    const isText = f.mimeType === 'text/plain' || lower.endsWith('.txt') || !f.mimeType;
    return isGoogleDoc || isText;
  });

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    const aDoc = a.mimeType === GOOGLE_DOC_MIME ? 1 : 0;
    const bDoc = b.mimeType === GOOGLE_DOC_MIME ? 1 : 0;
    if (aDoc !== bDoc) return aDoc - bDoc; // Prefer plain .txt over Google Doc if both exist
    const aIdx = CAPTION_NAME_PRIORITY.indexOf(String(a.name || '').trim().toLowerCase());
    const bIdx = CAPTION_NAME_PRIORITY.indexOf(String(b.name || '').trim().toLowerCase());
    return aIdx - bIdx;
  });

  const best = candidates[0];
  return {
    ...best,
    isGoogleDoc: best.mimeType === GOOGLE_DOC_MIME,
  };
}

export async function downloadTextFile(env, fileOrId, licenseId = null) {
  const isObj = typeof fileOrId === 'object' && fileOrId !== null;
  const fileId = isObj ? fileOrId.id : String(fileOrId || '');
  const isGoogleDoc = isObj && (fileOrId.isGoogleDoc || fileOrId.mimeType === GOOGLE_DOC_MIME);

  const url = isGoogleDoc
    ? `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fplain&supportsAllDrives=true`
    : `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`;

  const res = await driveFetch(env, url, {}, licenseId);
  const text = await res.text();
  return text.replace(/^\uFEFF/, '');
}

function guessMimeType(filename) {
  const lower = (filename || '').toLowerCase();
  if (lower.endsWith('.mp4')) return 'video/mp4';
  if (lower.endsWith('.mov')) return 'video/quicktime';
  if (lower.endsWith('.png')) return 'image/png';
  return 'image/jpeg';
}

export async function downloadMediaBlob(env, file, licenseId = null) {
  const declaredSize = Number(file.size || 0);
  if (declaredSize > MAX_MEDIA_BYTES) {
    const mb = (declaredSize / (1024 * 1024)).toFixed(1);
    const err = new Error(`File "${file.name}" is ${mb} MB, which exceeds the 100 MB limit`);
    err.isTooLarge = true;
    throw err;
  }
  const res = await driveFetch(
    env,
    `${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media&supportsAllDrives=true`,
    {},
    licenseId
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

export async function updateTextFile(env, fileOrId, text, licenseId = null) {
  const fileId = typeof fileOrId === 'object' && fileOrId !== null ? fileOrId.id : String(fileOrId || '');
  const res = await driveFetch(
    env,
    `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(fileId)}?uploadType=media&supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'text/plain; charset=utf-8',
      },
      body: text,
    },
    licenseId
  );
  return res.json();
}

export async function trashFile(env, fileId, licenseId = null) {
  const res = await driveFetch(
    env,
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true`,
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ trashed: true }),
    },
    licenseId
  );
  return res.json();
}
