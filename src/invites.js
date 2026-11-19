import {
  constantTimeEqual,
  decryptText,
  encryptText,
  generateRandomToken,
  sha256Hex,
  signToken,
  verifyToken,
} from './crypto.js';
import { prepareEventStmt } from './db.js';
import { fetchUserPages } from './facebook.js';

export const INVITE_SESSION_COOKIE = 'pp_invite_session';
const INVITE_SESSION_TTL_MS = 15 * 60 * 1000;
const INVITE_RATE_WINDOW_MS = 15 * 60 * 1000;
const INVITE_MAX_BAD_HITS = 15;

export async function checkInviteRateLimit(env, ip) {
  const key = `invite:${ip}`;
  const nowMs = Date.now();
  const row = await env.DB.prepare(
    `SELECT failures, locked_until FROM login_attempts WHERE ip = ?`
  )
    .bind(key)
    .first();

  if (row?.locked_until) {
    const lockedUntilMs = Date.parse(row.locked_until);
    if (!Number.isNaN(lockedUntilMs) && lockedUntilMs > nowMs) {
      return { allowed: false, retryAfterSeconds: Math.ceil((lockedUntilMs - nowMs) / 1000) };
    }
  }
  return { allowed: true };
}

export async function recordInviteBadHit(env, ip) {
  const key = `invite:${ip}`;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const row = await env.DB.prepare(
    `SELECT failures, locked_until, updated_at FROM login_attempts WHERE ip = ?`
  )
    .bind(key)
    .first();

  const expiredWindow =
    !row?.updated_at || nowMs - Date.parse(row.updated_at) > INVITE_RATE_WINDOW_MS;
  const expiredLock = row?.locked_until && Date.parse(row.locked_until) <= nowMs;
  const prev = expiredWindow || expiredLock ? 0 : Number(row?.failures || 0);
  const next = prev + 1;
  const lockedUntil =
    next >= INVITE_MAX_BAD_HITS ? new Date(nowMs + INVITE_RATE_WINDOW_MS).toISOString() : null;

  await env.DB.prepare(
    `INSERT INTO login_attempts (ip, failures, locked_until, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`
  )
    .bind(key, next, lockedUntil, nowIso)
    .run();
}

export async function lookupValidInvite(env, rawToken) {
  if (typeof rawToken !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(rawToken)) {
    return { valid: false, invite: null };
  }
  const tokenHash = await sha256Hex(rawToken);
  const row = await env.DB.prepare(`SELECT * FROM invites WHERE token_hash = ?`)
    .bind(tokenHash)
    .first();

  if (!row) return { valid: false, invite: null };

  const hashMatches = await constantTimeEqual(row.token_hash, tokenHash);
  if (!hashMatches) return { valid: false, invite: null };

  if (row.revoked_at || row.used_at) {
    return { valid: false, invite: null };
  }
  const expMs = Date.parse(row.expires_at);
  if (Number.isNaN(expMs) || expMs <= Date.now()) {
    return { valid: false, invite: null };
  }

  return { valid: true, invite: row };
}

export async function lookupValidInviteById(env, inviteId) {
  if (!Number.isInteger(inviteId) || inviteId <= 0) return null;
  const row = await env.DB.prepare(`SELECT * FROM invites WHERE id = ?`).bind(inviteId).first();
  if (!row || row.revoked_at || row.used_at) return null;
  const expMs = Date.parse(row.expires_at);
  if (Number.isNaN(expMs) || expMs <= Date.now()) return null;
  return row;
}

export function computeInviteStatus(row) {
  if (row.revoked_at) return 'revoked';
  if (row.used_at) return 'used';
  if (Date.parse(row.expires_at) <= Date.now()) return 'expired';
  return 'pending';
}

export async function createInvite(env, { label = '', expiresHours = 48, origin }) {
  const cleanLabel = String(label || '').trim().slice(0, 120);
  const hours = Math.max(1, Math.min(168, Math.round(Number(expiresHours || 48))));
  const nowMs = Date.now();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + hours * 3600_000).toISOString();

  const rawToken = generateRandomToken(24);
  const tokenHash = await sha256Hex(rawToken);

  const insertRes = await env.DB.prepare(
    `INSERT INTO invites (token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?)`
  )
    .bind(tokenHash, cleanLabel, createdAt, expiresAt)
    .run();

  const inviteId = insertRes.meta?.last_row_id;

  await env.DB.batch([
    prepareEventStmt(env.DB, {
      level: 'info',
      eventType: 'invite_created',
      message: `Created invite #${inviteId}${cleanLabel ? ` (${cleanLabel})` : ''} valid for ${hours}h`,
      details: { inviteId, label: cleanLabel, expiresAt },
    }),
  ]);

  return {
    invite: {
      id: inviteId,
      label: cleanLabel,
      created_at: createdAt,
      expires_at: expiresAt,
      used_at: null,
      revoked_at: null,
      account_id: null,
      account_name: null,
      status: 'pending',
    },
    inviteUrl: `${origin}/invite/${rawToken}`,
  };
}

export async function listInvites(env) {
  const [res, openedRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT i.id, i.label, i.created_at, i.expires_at, i.used_at, i.revoked_at, i.account_id,
              a.name AS account_name
       FROM invites i
       LEFT JOIN accounts a ON a.id = i.account_id
       ORDER BY i.id DESC
       LIMIT 100`
    ),
    env.DB.prepare(
      `SELECT details FROM events WHERE event_type = 'invite_opened' ORDER BY id DESC LIMIT 200`
    ),
  ]);

  const openedIds = new Set();
  for (const ev of openedRes.results || []) {
    try {
      const parsed = JSON.parse(ev.details || '{}');
      if (parsed.inviteId) openedIds.add(Number(parsed.inviteId));
    } catch {
      // ignore malformed details
    }
  }

  return (res.results || []).map((row) => ({
    ...row,
    opened: openedIds.has(Number(row.id)) || Boolean(row.used_at),
    status: computeInviteStatus(row),
  }));
}

export async function revokeInvite(env, inviteId) {
  const nowIso = new Date().toISOString();
  const res = await env.DB.prepare(
    `UPDATE invites SET revoked_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL`
  )
    .bind(nowIso, inviteId)
    .run();

  if ((res.meta?.changes || 0) === 1) {
    await env.DB.batch([
      prepareEventStmt(env.DB, {
        level: 'warn',
        eventType: 'invite_revoked',
        message: `Revoked invite #${inviteId}`,
        details: { inviteId },
      }),
    ]);
    return true;
  }
  return false;
}

export async function createInviteSessionCookieValue(env, { inviteId, fbUserId, fbUserName, accessToken, expiresIn }) {
  const nowMs = Date.now();
  const encUserToken = await encryptText(accessToken, env.ENCRYPTION_KEY);
  const tokenExpiresAt = expiresIn ? new Date(nowMs + expiresIn * 1000).toISOString() : null;
  return signToken(
    {
      typ: 'invite',
      inviteId,
      fbUserId,
      fbUserName,
      encUserToken,
      tokenExpiresAt,
      iat: nowMs,
      exp: nowMs + INVITE_SESSION_TTL_MS,
    },
    env.SESSION_SECRET
  );
}

export async function verifyInviteSessionCookie(cookieValue, env) {
  if (!cookieValue || !env.SESSION_SECRET) return null;
  const payload = await verifyToken(cookieValue, env.SESSION_SECRET);
  if (!payload || payload.typ !== 'invite' || !payload.inviteId || !payload.encUserToken) {
    return null;
  }
  return payload;
}

export async function getInviteSelectablePages(env, inviteSession) {
  const invite = await lookupValidInviteById(env, Number(inviteSession.inviteId));
  if (!invite) {
    throw new Error('This invite link is invalid, expired, or already used.');
  }
  const userToken = await decryptText(inviteSession.encUserToken, env.ENCRYPTION_KEY);
  const pages = await fetchUserPages(env, userToken);
  return {
    fbUserName: inviteSession.fbUserName,
    pages: pages.map((p) => ({
      fb_page_id: p.id,
      name: p.name,
    })),
  };
}

export async function confirmInviteSelection(env, inviteSession, selectedPageIds) {
  if (!Array.isArray(selectedPageIds) || selectedPageIds.length === 0) {
    throw new Error('Select at least one Page.');
  }

  const invite = await lookupValidInviteById(env, Number(inviteSession.inviteId));
  if (!invite) {
    throw new Error('This invite link is invalid, expired, or already used.');
  }

  const userToken = await decryptText(inviteSession.encUserToken, env.ENCRYPTION_KEY);
  const fbPages = await fetchUserPages(env, userToken);
  const selectedSet = new Set(selectedPageIds.map(String));
  const matched = fbPages.filter((p) => selectedSet.has(p.id));
  if (matched.length === 0) {
    throw new Error('None of the selected Pages were found on your Facebook account.');
  }

  const nowIso = new Date().toISOString();

  // Atomically mark invite as used before persisting account/pages (single-use enforcement)
  const claimRes = await env.DB.prepare(
    `UPDATE invites SET used_at = ? WHERE id = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?`
  )
    .bind(nowIso, invite.id, nowIso)
    .run();

  if ((claimRes.meta?.changes || 0) !== 1) {
    throw new Error('This invite link has already been used or expired.');
  }

  // Upsert Facebook account
  await env.DB.prepare(
    `INSERT INTO accounts (fb_user_id, name, encrypted_token, token_expires_at, status, last_error, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)
     ON CONFLICT(fb_user_id) DO UPDATE SET
       name = excluded.name,
       encrypted_token = excluded.encrypted_token,
       token_expires_at = COALESCE(excluded.token_expires_at, accounts.token_expires_at),
       status = 'active',
       last_error = NULL,
       updated_at = excluded.updated_at`
  )
    .bind(
      inviteSession.fbUserId,
      inviteSession.fbUserName,
      inviteSession.encUserToken,
      inviteSession.tokenExpiresAt || null,
      nowIso,
      nowIso
    )
    .run();

  const accountRow = await env.DB.prepare(`SELECT id FROM accounts WHERE fb_user_id = ?`)
    .bind(inviteSession.fbUserId)
    .first();

  const stmts = [
    env.DB.prepare(`UPDATE invites SET account_id = ? WHERE id = ?`).bind(accountRow.id, invite.id),
  ];

  for (const p of matched) {
    const encryptedPageToken = await encryptText(p.access_token, env.ENCRYPTION_KEY);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO pages (account_id, fb_page_id, name, encrypted_page_token, status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)
         ON CONFLICT(fb_page_id) DO UPDATE SET
           account_id = excluded.account_id,
           name = excluded.name,
           encrypted_page_token = excluded.encrypted_page_token,
           status = CASE WHEN pages.status = 'needs_attention' THEN 'active' ELSE pages.status END,
           last_error = NULL,
           updated_at = excluded.updated_at`
      ).bind(accountRow.id, p.id, p.name, encryptedPageToken, nowIso, nowIso)
    );
  }

  stmts.push(
    prepareEventStmt(env.DB, {
      level: 'info',
      eventType: 'invite_used',
      message: `Invite #${invite.id}${invite.label ? ` (${invite.label})` : ''} completed by ${inviteSession.fbUserName} with ${matched.length} Page(s)`,
      details: { inviteId: invite.id, accountId: accountRow.id, pageCount: matched.length },
    }),
    prepareEventStmt(env.DB, {
      level: 'info',
      eventType: 'account_connected',
      message: `Connected Facebook account ${inviteSession.fbUserName} via invite`,
      details: { accountId: accountRow.id, fbUserId: inviteSession.fbUserId },
    })
  );

  await env.DB.batch(stmts);
  return { ok: true, addedCount: matched.length, fbUserName: inviteSession.fbUserName };
}

export function isMetaDevModeAuthError(msg) {
  const lower = String(msg || '').toLowerCase();
  return (
    lower.includes('not active') ||
    lower.includes('not authorized') ||
    lower.includes('not accessible') ||
    lower.includes('app not setup') ||
    lower.includes('development mode') ||
    lower.includes('tester') ||
    lower.includes('1349003') ||
    lower.includes('app_not_active')
  );
}

export function renderInviteHtml({ token = '', valid = false, step = 'intro', err = '', label = '' }) {
  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const favicon =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%236366f1'/%3E%3Cstop offset='100%25' stop-color='%2306b6d4'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='32' height='32' rx='9' fill='url(%23g)'/%3E%3Ctext x='16' y='21' text-anchor='middle' font-family='system-ui,sans-serif' font-size='13' font-weight='800' fill='white'%3ERM%3C/text%3E%3C/svg%3E";

  return `<!doctype html>
<html lang="ps" dir="rtl">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
  <title>RM Automation — Connect Facebook Pages</title>
  <link rel="icon" type="image/svg+xml" href="${favicon}" />
  <link rel="stylesheet" href="/style.css" />
</head>
<body>
  <div
    id="invite-app"
    data-token="${esc(token)}"
    data-valid="${valid ? '1' : '0'}"
    data-step="${esc(step)}"
    data-err="${esc(err)}"
    data-label="${esc(label)}"
  ></div>
  <script type="module" src="/js/invite.js"></script>
</body>
</html>`;
}
