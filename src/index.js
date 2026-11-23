import {
  constantTimeEqual,
  decryptText,
  encryptText,
  sha256Hex,
  signToken,
  verifyToken,
} from './crypto.js';
import { ensureSchema, logEvent, prepareEventStmt } from './db.js';
import {
  buildGoogleOAuthUrl,
  exchangeGoogleCode,
  getDriveConnectionInfo,
  listSharedFolders,
} from './drive.js';
import {
  exchangeUserTokenForLongLived,
  fetchTokenIdentity,
  fetchUserPages,
} from './facebook.js';
import {
  postNowForPage,
  previewNextPostForPage,
  pruneExpiredHistory,
  regenerateTodayPlanForPage,
  runCron,
  syncDriveQueueForPage,
} from './scheduler.js';
import { getLocalParts, isValidTimeZone, minutesToHHMM, parseSlotMinutes } from './timezone.js';

const SESSION_COOKIE = 'pp_session';
const GOOGLE_STATE_COOKIE = 'pp_google_state';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

function isHttpsTransport(request, env) {
  const url = new URL(request.url);
  return url.protocol === 'https:' || env?.PREVIEW_MODE === '1';
}

function getSessionCookieOptions(request, env) {
  const url = new URL(request.url);
  if (env?.PREVIEW_MODE === '1') {
    return {
      sameSite: 'None',
      secure: true,
      partitioned: true,
    };
  }
  return {
    sameSite: 'Strict',
    secure: url.protocol === 'https:',
    partitioned: false,
  };
}

function parseCookies(request) {
  const header = request.headers.get('cookie') || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  }
  return out;
}

function makeCookieHeader(name, value, { maxAge, path = '/', sameSite = 'Strict', secure = true, partitioned = false }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'HttpOnly', `SameSite=${sameSite}`];
  if (typeof maxAge === 'number') parts.push(`Max-Age=${maxAge}`);
  if (secure) parts.push('Secure');
  if (partitioned && secure) parts.push('Partitioned');
  return parts.join('; ');
}

function withSecurityHeaders(response, { noStore = true } = {}) {
  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  if (noStore) {
    headers.set('Cache-Control', 'no-store');
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(data, status = 200, extraHeaders = {}) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    ...extraHeaders,
  });
  return withSecurityHeaders(new Response(JSON.stringify(data), { status, headers }));
}

function errorResponse(message, status = 400, extra = {}) {
  return jsonResponse({ error: message, ...extra }, status);
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function licenseScopeSql(col, licenseId) {
  return licenseId != null ? { sql: `${col} = ?`, params: [licenseId] } : { sql: `${col} IS NULL`, params: [] };
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function generateLicenseKey() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const groups = [];
  for (let g = 0; g < 4; g++) {
    let seg = '';
    for (let i = 0; i < 4; i++) {
      seg += alphabet[bytes[g * 4 + i] % alphabet.length];
    }
    groups.push(seg);
  }
  return `RM-${groups.join('-')}`;
}

async function resolveAuthContext(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  const payload = await verifyToken(token, env.SESSION_SECRET);
  if (!payload) return null;

  const role = payload.role || (payload.sub === 'admin' ? 'admin' : null);
  if (role === 'admin') {
    return { role: 'admin', licenseId: null, label: 'Super Admin', maxPages: null, license: null };
  }

  if (role === 'license' && payload.licenseId) {
    const lic = await env.DB.prepare(
      `SELECT id, label, max_pages, status, expires_at, global_pause, google_email
       FROM licenses WHERE id = ?`
    )
      .bind(Number(payload.licenseId))
      .first();
    if (!lic || lic.status !== 'active') return null;
    if (lic.expires_at) {
      const expMs = Date.parse(lic.expires_at);
      if (!Number.isNaN(expMs) && expMs <= Date.now()) return null;
    }
    return {
      role: 'license',
      licenseId: lic.id,
      label: lic.label || `License #${lic.id}`,
      maxPages: Number(lic.max_pages || 20),
      license: lic,
    };
  }

  return null;
}

async function handleLogin(request, env) {
  if (!env.SESSION_SECRET) {
    return errorResponse('SESSION_SECRET secret is not configured', 503);
  }

  const ip = getClientIp(request);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const attemptRow = await env.DB.prepare(
    `SELECT failures, locked_until FROM login_attempts WHERE ip = ?`
  )
    .bind(ip)
    .first();

  if (attemptRow?.locked_until) {
    const lockedUntilMs = Date.parse(attemptRow.locked_until);
    if (!Number.isNaN(lockedUntilMs) && lockedUntilMs > nowMs) {
      const retryAfterSeconds = Math.ceil((lockedUntilMs - nowMs) / 1000);
      return errorResponse('Too many failed login attempts. Try again later.', 429, {
        retryAfterSeconds,
      });
    }
  }

  const body = await readJsonBody(request);
  const rawInput =
    typeof body?.password === 'string'
      ? body.password
      : typeof body?.key === 'string'
        ? body.key
        : '';
  const trimmedInput = rawInput.trim();

  let auth = null;
  let licenseRejectReason = null;

  if (env.ADMIN_PASSWORD && rawInput && (await constantTimeEqual(rawInput, env.ADMIN_PASSWORD))) {
    auth = { role: 'admin', licenseId: null, label: 'Super Admin', maxPages: null };
  } else if (trimmedInput) {
    const keyHash = await sha256Hex(trimmedInput);
    const lic = await env.DB.prepare(
      `SELECT id, label, max_pages, status, expires_at FROM licenses WHERE key_hash = ?`
    )
      .bind(keyHash)
      .first();
    if (lic) {
      if (lic.status !== 'active') {
        licenseRejectReason = 'This license key has been disabled.';
      } else if (lic.expires_at && Date.parse(lic.expires_at) <= nowMs) {
        licenseRejectReason = 'This license key has expired.';
      } else {
        auth = {
          role: 'license',
          licenseId: lic.id,
          label: lic.label || `License #${lic.id}`,
          maxPages: Number(lic.max_pages || 20),
        };
      }
    }
  }

  if (licenseRejectReason) {
    await logEvent(env.DB, {
      level: 'warn',
      eventType: 'license_login_rejected',
      message: `${licenseRejectReason} (IP: ${ip})`,
      details: { ip },
    });
    return errorResponse(licenseRejectReason, 403);
  }

  if (!auth) {
    const prevFailures =
      attemptRow?.locked_until && Date.parse(attemptRow.locked_until) <= nowMs
        ? 0
        : Number(attemptRow?.failures || 0);
    const nextFailures = prevFailures + 1;
    const lockedUntil =
      nextFailures >= LOGIN_MAX_FAILURES ? new Date(nowMs + LOGIN_LOCKOUT_MS).toISOString() : null;

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO login_attempts (ip, failures, locked_until, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(ip) DO UPDATE SET failures = excluded.failures, locked_until = excluded.locked_until, updated_at = excluded.updated_at`
      ).bind(ip, nextFailures, lockedUntil, nowIso),
      prepareEventStmt(env.DB, {
        level: 'warn',
        eventType: 'login_failed',
        message: `Failed login attempt (${nextFailures}/${LOGIN_MAX_FAILURES})`,
        details: { ip },
      }),
    ]);

    if (lockedUntil) {
      return errorResponse('Too many failed login attempts. Locked for 15 minutes.', 429, {
        retryAfterSeconds: Math.ceil(LOGIN_LOCKOUT_MS / 1000),
      });
    }
    return errorResponse('Invalid license key', 401);
  }

  const token = await signToken(
    {
      sub: auth.role,
      role: auth.role,
      licenseId: auth.licenseId,
      iat: nowMs,
      exp: nowMs + SESSION_TTL_MS,
    },
    env.SESSION_SECRET
  );

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(ip),
    prepareEventStmt(env.DB, {
      licenseId: auth.licenseId,
      level: 'info',
      eventType: 'login_success',
      message: auth.role === 'admin' ? 'Super Admin signed in' : `License "${auth.label}" signed in`,
      details: { ip, role: auth.role },
    }),
  ]);

  const { sameSite, secure, partitioned } = getSessionCookieOptions(request, env);
  const cookie = makeCookieHeader(SESSION_COOKIE, token, {
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
    path: '/',
    sameSite,
    secure,
    partitioned,
  });

  return jsonResponse(
    {
      ok: true,
      role: auth.role,
      licenseId: auth.licenseId,
      label: auth.label,
      maxPages: auth.maxPages,
    },
    200,
    { 'Set-Cookie': cookie }
  );
}

async function handleLogout(request, env) {
  const { sameSite, secure, partitioned } = getSessionCookieOptions(request, env);
  const cookie = makeCookieHeader(SESSION_COOKIE, '', {
    maxAge: 0,
    path: '/',
    sameSite,
    secure,
    partitioned,
  });
  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
}

async function handleGoogleStart(request, env) {
  const url = new URL(request.url);
  const auth = await resolveAuthContext(request, env);
  if (!auth) {
    return Response.redirect(`${url.origin}/?google_error=unauthorized`, 302);
  }

  const nowMs = Date.now();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  const state = await signToken(
    {
      nonce,
      role: auth.role,
      licenseId: auth.licenseId,
      iat: nowMs,
      exp: nowMs + 10 * 60_000,
    },
    env.SESSION_SECRET
  );

  let authUrl;
  try {
    authUrl = buildGoogleOAuthUrl(env, url.origin, state);
  } catch (err) {
    return Response.redirect(
      `${url.origin}/?tab=accounts&google_error=${encodeURIComponent(err.message)}`,
      302
    );
  }

  const stateCookie = makeCookieHeader(GOOGLE_STATE_COOKIE, nonce, {
    maxAge: 600,
    path: '/auth/google',
    sameSite: 'Lax',
    secure: isHttpsTransport(request, env),
  });

  return withSecurityHeaders(
    new Response(null, {
      status: 302,
      headers: {
        Location: authUrl,
        'Set-Cookie': stateCookie,
      },
    })
  );
}

async function handleGoogleCallback(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;
  const secureFlag = isHttpsTransport(request, env);
  const clearStateCookie = makeCookieHeader(GOOGLE_STATE_COOKIE, '', {
    maxAge: 0,
    path: '/auth/google',
    sameSite: 'Lax',
    secure: secureFlag,
  });

  const redirectErr = (msg) =>
    withSecurityHeaders(
      new Response(null, {
        status: 302,
        headers: {
          Location: `${origin}/?tab=accounts&google_error=${encodeURIComponent(msg)}`,
          'Set-Cookie': clearStateCookie,
        },
      })
    );

  const googleErr = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (googleErr) {
    return redirectErr(googleErr);
  }

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(request);
  const rawStateCookie = cookies[GOOGLE_STATE_COOKIE];

  const verifiedState = state && env.SESSION_SECRET ? await verifyToken(state, env.SESSION_SECRET) : null;
  if (!code || !verifiedState || !rawStateCookie || verifiedState.nonce !== rawStateCookie) {
    return redirectErr('Invalid or expired Google OAuth state. Please try connecting again.');
  }

  const targetLicenseId = verifiedState.role === 'license' && verifiedState.licenseId ? Number(verifiedState.licenseId) : null;
  if (verifiedState.role === 'license') {
    if (!targetLicenseId) {
      return redirectErr('Invalid license workspace in OAuth state.');
    }
    const licRow = await env.DB.prepare(`SELECT id, status, expires_at FROM licenses WHERE id = ?`)
      .bind(targetLicenseId)
      .first();
    if (!licRow || licRow.status !== 'active' || (licRow.expires_at && Date.parse(licRow.expires_at) <= Date.now())) {
      return redirectErr('License is inactive or expired.');
    }
  }

  try {
    const exchanged = await exchangeGoogleCode(env, origin, code);
    const nowIso = new Date().toISOString();
    let encryptedRefresh = null;

    if (exchanged.refreshToken) {
      encryptedRefresh = await encryptText(exchanged.refreshToken, env.ENCRYPTION_KEY);
    } else {
      // Ensure we already have a refresh token stored for this workspace
      if (targetLicenseId) {
        const existing = await env.DB.prepare(
          `SELECT google_encrypted_refresh_token FROM licenses WHERE id = ?`
        )
          .bind(targetLicenseId)
          .first();
        if (!existing?.google_encrypted_refresh_token) {
          throw new Error(
            'Google did not return an offline refresh token. Remove app access in Google Security Settings and sign in again.'
          );
        }
      } else {
        const existing = await env.DB.prepare(
          `SELECT value FROM settings WHERE key = 'google_oauth_refresh_token'`
        ).first();
        if (!existing?.value) {
          throw new Error(
            'Google did not return an offline refresh token. Remove app access in Google Security Settings and sign in again.'
          );
        }
      }
    }

    const encryptedAccess = await encryptText(exchanged.accessToken, env.ENCRYPTION_KEY);
    const accessExpiresAt = Date.now() + Math.max(300_000, (Number(exchanged.expiresIn || 3600) - 600) * 1000);
    const cacheKey = `google_oauth:${targetLicenseId ? String(targetLicenseId) : 'admin'}`;

    const stmts = [
      env.DB.prepare(
        `INSERT INTO cached_tokens (cache_key, token, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(cache_key) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at`
      ).bind(cacheKey, encryptedAccess, accessExpiresAt),
      prepareEventStmt(env.DB, {
        licenseId: targetLicenseId,
        level: 'info',
        eventType: 'google_drive_connected',
        message: `Connected Google Drive (${exchanged.email})`,
        details: { email: exchanged.email },
      }),
    ];

    if (targetLicenseId) {
      stmts.unshift(
        env.DB.prepare(
          `UPDATE licenses
           SET google_email = ?,
               google_encrypted_refresh_token = COALESCE(?, google_encrypted_refresh_token),
               google_connected_at = ?,
               updated_at = ?
           WHERE id = ?`
        ).bind(exchanged.email, encryptedRefresh, nowIso, nowIso, targetLicenseId)
      );
    } else {
      stmts.unshift(
        env.DB.prepare(
          `INSERT INTO settings (key, value) VALUES ('google_oauth_email', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).bind(exchanged.email),
        env.DB.prepare(
          `INSERT INTO settings (key, value) VALUES ('google_oauth_connected_at', ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value`
        ).bind(nowIso)
      );
      if (encryptedRefresh) {
        stmts.unshift(
          env.DB.prepare(
            `INSERT INTO settings (key, value) VALUES ('google_oauth_refresh_token', ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value`
          ).bind(encryptedRefresh)
        );
      }
    }

    await env.DB.batch(stmts);

    return withSecurityHeaders(
      new Response(null, {
        status: 302,
        headers: {
          Location: `${origin}/?tab=accounts&google_connected=1`,
          'Set-Cookie': clearStateCookie,
        },
      })
    );
  } catch (err) {
    await logEvent(env.DB, {
      licenseId: targetLicenseId,
      level: 'error',
      eventType: 'google_drive_failed',
      message: `Google Drive OAuth callback failed: ${err.message}`,
    });
    return redirectErr(err.message);
  }
}

async function handleDashboard(env, auth) {
  const nowMs = Date.now();
  const sparkDates = [];
  for (let i = 6; i >= 0; i--) {
    sparkDates.push(new Date(nowMs - i * 24 * 3600_000).toISOString().slice(0, 10));
  }
  const lookbackDate = sparkDates[0];

  const pageScope = licenseScopeSql('p.license_id', auth.licenseId);
  const accScope = licenseScopeSql('license_id', auth.licenseId);

  const [settingsRes, pagesRes, planRes, blockedRes, accountsRes] = await env.DB.batch([
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'global_pause'`),
    env.DB.prepare(
      `SELECT
         p.id, p.account_id, p.fb_page_id, p.name, p.picture_url,
         p.captions_folder_id, p.captions_folder_name,
         p.media_folder_id, p.media_folder_name,
         p.timezone, p.slots, p.jitter_minutes, p.daily_cap,
         p.min_gap_minutes, p.ramp_up_enabled, p.ramp_start, p.ramp_step_days,
         p.last_drive_sync_at, p.last_drive_sync_error,
         p.status, p.last_error, p.created_at, p.updated_at,
         a.name AS account_name, a.status AS account_status, a.token_kind AS account_token_kind
       FROM pages p
       JOIN accounts a ON a.id = p.account_id
       WHERE ${pageScope.sql}
       ORDER BY p.name ASC`
    ).bind(...pageScope.params),
    env.DB.prepare(
      `SELECT pl.id, pl.page_id, pl.local_date, pl.slot_time, pl.planned_local, pl.planned_utc,
              pl.status, pl.attempts, pl.next_attempt_utc, pl.fb_post_id, pl.file_id, pl.file_name, pl.caption_number,
              substr(pl.caption_text, 1, 140) AS caption_preview,
              pl.error, pl.finished_at, pl.cleanup_pending
       FROM plan pl
       JOIN pages p ON p.id = pl.page_id
       WHERE ${pageScope.sql} AND pl.local_date >= ?
       ORDER BY pl.planned_utc ASC`
    ).bind(...pageScope.params, lookbackDate),
    env.DB.prepare(
      `SELECT bf.page_id, COUNT(*) AS cnt
       FROM blocked_files bf
       JOIN pages p ON p.id = bf.page_id
       WHERE ${pageScope.sql}
       GROUP BY bf.page_id`
    ).bind(...pageScope.params),
    env.DB.prepare(
      `SELECT id, name, status, last_error, token_kind FROM accounts WHERE ${accScope.sql}`
    ).bind(...accScope.params),
  ]);

  const ownerGlobalPause = settingsRes.results?.[0]?.value === '1';
  const licenseGlobalPause = auth.license ? Number(auth.license.global_pause) === 1 : false;
  const globalPause = auth.role === 'license' ? licenseGlobalPause : ownerGlobalPause;

  const blockedMap = new Map();
  for (const row of blockedRes.results || []) {
    blockedMap.set(row.page_id, Number(row.cnt));
  }

  const dailyPosted = new Map(sparkDates.map((d) => [d, 0]));
  const dailyFailed = new Map(sparkDates.map((d) => [d, 0]));
  const dailyPlanned = new Map(sparkDates.map((d) => [d, 0]));

  const plansByPageDate = new Map();
  for (const r of planRes.results || []) {
    const key = `${r.page_id}:${r.local_date}`;
    if (!plansByPageDate.has(key)) plansByPageDate.set(key, []);
    plansByPageDate.get(key).push(r);
    if (dailyPlanned.has(r.local_date)) {
      dailyPlanned.set(r.local_date, dailyPlanned.get(r.local_date) + 1);
      if (r.status === 'posted') dailyPosted.set(r.local_date, dailyPosted.get(r.local_date) + 1);
      if (r.status === 'failed') dailyFailed.set(r.local_date, dailyFailed.get(r.local_date) + 1);
    }
  }

  const pages = (pagesRes.results || []).map((p) => {
    const localParts = getLocalParts(nowMs, p.timezone);
    const todaySlots = plansByPageDate.get(`${p.id}:${localParts.localDate}`) || [];
    const nextPending = todaySlots.find((s) => s.status === 'pending' || s.status === 'posting') || null;
    let parsedSlots = [];
    try {
      parsedSlots = JSON.parse(p.slots || '[]');
    } catch {
      parsedSlots = [];
    }

    return {
      ...p,
      slots: parsedSlots,
      ramp_up_enabled: Boolean(p.ramp_up_enabled),
      local_date: localParts.localDate,
      local_time: localParts.localTime,
      today_slots: todaySlots,
      next_planned: nextPending
        ? {
            planned_local: nextPending.planned_local,
            planned_utc: nextPending.planned_utc,
            status: nextPending.status,
            attempts: nextPending.attempts,
            next_attempt_utc: nextPending.next_attempt_utc,
          }
        : null,
      blocked_count: blockedMap.get(p.id) || 0,
    };
  });

  const needsAttentionPages = pages.filter(
    (p) => p.status === 'needs_attention' || p.account_status === 'needs_attention'
  );

  return jsonResponse({
    globalPause,
    ownerGlobalPause: auth.role === 'license' ? ownerGlobalPause : false,
    nowUtc: new Date(nowMs).toISOString(),
    pages,
    needsAttentionCount: needsAttentionPages.length,
    accounts: accountsRes.results || [],
    sparklines: {
      dates: sparkDates,
      posted: sparkDates.map((d) => dailyPosted.get(d) || 0),
      failed: sparkDates.map((d) => dailyFailed.get(d) || 0),
      planned: sparkDates.map((d) => dailyPlanned.get(d) || 0),
    },
  });
}

async function handleListAccounts(env, auth) {
  const scope = licenseScopeSql('a.license_id', auth.licenseId);
  const res = await env.DB.prepare(
    `SELECT a.id, a.fb_user_id, a.name, a.token_kind, a.token_expires_at, a.status, a.last_error,
            a.created_at, a.updated_at, COUNT(p.id) AS page_count
     FROM accounts a
     LEFT JOIN pages p ON p.account_id = a.id
     WHERE ${scope.sql}
     GROUP BY a.id
     ORDER BY a.created_at DESC`
  )
    .bind(...scope.params)
    .all();

  return jsonResponse({ accounts: res.results || [] });
}

async function handleManualAccount(request, env, auth) {
  const body = await readJsonBody(request);
  const rawToken = typeof body?.token === 'string' ? body.token.trim() : '';
  const mode = body?.mode === 'page' ? 'page' : 'user';
  if (!rawToken) {
    return errorResponse('Access token is required', 400);
  }

  let finalToken = rawToken;
  let expiresIn = null;

  if (mode === 'user' && env.META_APP_ID && env.META_APP_SECRET) {
    try {
      const exchanged = await exchangeUserTokenForLongLived(env, rawToken);
      finalToken = exchanged.accessToken;
      expiresIn = exchanged.expiresIn;
    } catch {
      // Keep pasted token directly if already long-lived or exchange is not applicable
    }
  }

  let identity;
  try {
    identity = await fetchTokenIdentity(env, finalToken, mode);
  } catch (err) {
    return errorResponse(`Facebook token verification failed: ${err.message}`, 400);
  }

  const nowIso = new Date().toISOString();
  const encrypted = await encryptText(finalToken, env.ENCRYPTION_KEY);

  if (mode === 'page') {
    const existingPage = await env.DB.prepare(`SELECT id, license_id FROM pages WHERE fb_page_id = ?`)
      .bind(identity.id)
      .first();

    if (existingPage && (existingPage.license_id ?? null) !== (auth.licenseId ?? null)) {
      return errorResponse('This Facebook Page is already connected under another license.', 409);
    }

    if (!existingPage && auth.role === 'license') {
      const cntRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM pages WHERE license_id = ?`)
        .bind(auth.licenseId)
        .first();
      if (Number(cntRow?.cnt || 0) >= auth.maxPages) {
        return errorResponse(
          `License page limit reached (${auth.maxPages}). Ask the administrator to increase your limit.`,
          403
        );
      }
    }

    const syntheticAccId = `lic${auth.licenseId || 0}:page:${identity.id}`;
    await env.DB.prepare(
      `INSERT INTO accounts (fb_user_id, license_id, token_kind, name, encrypted_token, token_expires_at, status, last_error, created_at, updated_at)
       VALUES (?, ?, 'page_direct', ?, ?, NULL, 'active', NULL, ?, ?)
       ON CONFLICT(fb_user_id) DO UPDATE SET
         name = excluded.name,
         token_kind = 'page_direct',
         encrypted_token = excluded.encrypted_token,
         status = 'active',
         last_error = NULL,
         updated_at = excluded.updated_at`
    )
      .bind(syntheticAccId, auth.licenseId, identity.name, encrypted, nowIso, nowIso)
      .run();

    const account = await env.DB.prepare(
      `SELECT id, fb_user_id, name, token_kind, token_expires_at, status, last_error, created_at, updated_at
       FROM accounts WHERE fb_user_id = ?`
    )
      .bind(syntheticAccId)
      .first();

    await env.DB.prepare(
      `INSERT INTO pages (account_id, license_id, fb_page_id, name, picture_url, encrypted_page_token, status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
       ON CONFLICT(fb_page_id) DO UPDATE SET
         account_id = excluded.account_id,
         name = excluded.name,
         picture_url = COALESCE(NULLIF(excluded.picture_url, ''), pages.picture_url),
         encrypted_page_token = excluded.encrypted_page_token,
         status = CASE WHEN pages.status = 'needs_attention' THEN 'active' ELSE pages.status END,
         last_error = NULL,
         updated_at = excluded.updated_at`
    )
      .bind(account.id, auth.licenseId, identity.id, identity.name, identity.pictureUrl || '', encrypted, nowIso, nowIso)
      .run();

    const page = await env.DB.prepare(
      `SELECT id, account_id, fb_page_id, name, picture_url, status FROM pages WHERE fb_page_id = ?`
    )
      .bind(identity.id)
      .first();

    await logEvent(env.DB, {
      pageId: page?.id || null,
      licenseId: auth.licenseId,
      level: 'info',
      eventType: 'fb_page_token_connected',
      message: `Connected single Page "${identity.name}" (${identity.id}) via Page token`,
      details: { accountId: account?.id, fbPageId: identity.id },
    });

    return jsonResponse({ mode: 'page', account, page });
  }

  // Mode 1: Account / User Token (fetches all Pages via /me/accounts)
  try {
    await fetchUserPages(env, finalToken);
  } catch (err) {
    return errorResponse(err.message, 400);
  }

  const existingAcc = await env.DB.prepare(`SELECT id, license_id FROM accounts WHERE fb_user_id = ?`)
    .bind(identity.id)
    .first();
  if (existingAcc && (existingAcc.license_id ?? null) !== (auth.licenseId ?? null)) {
    return errorResponse('This Facebook account is already connected under another license.', 409);
  }

  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

  await env.DB.prepare(
    `INSERT INTO accounts (fb_user_id, license_id, token_kind, name, encrypted_token, token_expires_at, status, last_error, created_at, updated_at)
     VALUES (?, ?, 'user', ?, ?, ?, 'active', NULL, ?, ?)
     ON CONFLICT(fb_user_id) DO UPDATE SET
       name = excluded.name,
       token_kind = 'user',
       encrypted_token = excluded.encrypted_token,
       token_expires_at = COALESCE(excluded.token_expires_at, accounts.token_expires_at),
       status = 'active',
       last_error = NULL,
       updated_at = excluded.updated_at`
  )
    .bind(identity.id, auth.licenseId, identity.name, encrypted, expiresAt, nowIso, nowIso)
    .run();

  const account = await env.DB.prepare(
    `SELECT id, fb_user_id, name, token_kind, token_expires_at, status, last_error, created_at, updated_at
     FROM accounts WHERE fb_user_id = ?`
  )
    .bind(identity.id)
    .first();

  await logEvent(env.DB, {
    licenseId: auth.licenseId,
    level: 'info',
    eventType: 'fb_account_manual',
    message: `Connected Facebook account "${identity.name}" (${identity.id}) via User token`,
    details: { accountId: account?.id },
  });

  return jsonResponse({ mode: 'user', account });
}

async function handleCheckAccount(env, auth, accountId) {
  const row = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!row || (row.license_id ?? null) !== (auth.licenseId ?? null)) {
    return errorResponse('Account not found', 404);
  }

  const nowIso = new Date().toISOString();
  try {
    const token = await decryptText(row.encrypted_token, env.ENCRYPTION_KEY);
    const kind = row.token_kind === 'page_direct' ? 'page' : 'user';
    const identity = await fetchTokenIdentity(env, token, kind);

    const stmts = [
      env.DB.prepare(
        `UPDATE accounts SET name = ?, status = 'active', last_error = NULL, updated_at = ? WHERE id = ?`
      ).bind(identity.name, nowIso, accountId),
    ];
    if (kind === 'page') {
      stmts.push(
        env.DB.prepare(
          `UPDATE pages SET status = CASE WHEN status = 'needs_attention' THEN 'active' ELSE status END,
                           name = ?,
                           picture_url = COALESCE(NULLIF(?, ''), picture_url),
                           last_error = NULL, updated_at = ?
           WHERE account_id = ?`
        ).bind(identity.name, identity.pictureUrl || '', nowIso, accountId)
      );
    } else {
      try {
        const fbPages = await fetchUserPages(env, token);
        for (const p of fbPages) {
          if (p.picture_url) {
            stmts.push(
              env.DB.prepare(
                `UPDATE pages SET picture_url = ?, name = ?, updated_at = ? WHERE account_id = ? AND fb_page_id = ?`
              ).bind(p.picture_url, p.name, nowIso, accountId, p.id)
            );
          }
        }
      } catch {
        // Non-fatal if /me/accounts refresh fails
      }
    }
    await env.DB.batch(stmts);
    return jsonResponse({ ok: true, status: 'active', name: identity.name });
  } catch (err) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE accounts SET status = 'needs_attention', last_error = ?, updated_at = ? WHERE id = ?`
      ).bind(err.message, nowIso, accountId),
      prepareEventStmt(env.DB, {
        licenseId: auth.licenseId,
        level: 'error',
        eventType: 'account_token_check_failed',
        message: `Account ${row.name} token health check failed: ${err.message}`,
      }),
    ]);
    return jsonResponse({ ok: false, status: 'needs_attention', error: err.message });
  }
}

async function handleAccountFbPages(env, auth, accountId) {
  const row = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!row || (row.license_id ?? null) !== (auth.licenseId ?? null)) {
    return errorResponse('Account not found', 404);
  }

  try {
    const token = await decryptText(row.encrypted_token, env.ENCRYPTION_KEY);
    if (row.token_kind === 'page_direct') {
      const pageInfo = await fetchTokenIdentity(env, token, 'page');
      const existingPage = await env.DB.prepare(`SELECT id FROM pages WHERE fb_page_id = ? AND account_id = ?`)
        .bind(pageInfo.id, accountId)
        .first();
      return jsonResponse({
        pages: [
          {
            fb_page_id: pageInfo.id,
            name: pageInfo.name,
            picture_url: pageInfo.pictureUrl || '',
            tasks: [],
            alreadyAdded: Boolean(existingPage),
            existingPageId: existingPage?.id || null,
          },
        ],
      });
    }

    const fbPages = await fetchUserPages(env, token);
    const scope = licenseScopeSql('license_id', auth.licenseId);
    const existingRes = await env.DB.prepare(`SELECT id, fb_page_id FROM pages WHERE ${scope.sql}`)
      .bind(...scope.params)
      .all();
    const existingMap = new Map();
    for (const p of existingRes.results || []) {
      existingMap.set(p.fb_page_id, p.id);
    }

    return jsonResponse({
      pages: fbPages.map((p) => ({
        fb_page_id: p.id,
        name: p.name,
        picture_url: p.picture_url || '',
        tasks: p.tasks,
        alreadyAdded: existingMap.has(p.id),
        existingPageId: existingMap.get(p.id) || null,
      })),
    });
  } catch (err) {
    return errorResponse(`Could not list Facebook Pages: ${err.message}`, 400);
  }
}

async function handleAddAccountPages(request, env, auth, accountId) {
  const account = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!account || (account.license_id ?? null) !== (auth.licenseId ?? null)) {
    return errorResponse('Account not found', 404);
  }

  const body = await readJsonBody(request);
  const selectedIds = Array.isArray(body?.fbPageIds) ? body.fbPageIds.map(String) : [];
  if (selectedIds.length === 0) {
    return errorResponse('Select at least one Page', 400);
  }

  const selectedSet = new Set(selectedIds);
  const userToken = await decryptText(account.encrypted_token, env.ENCRYPTION_KEY);

  let matched = [];
  if (account.token_kind === 'page_direct') {
    const pageInfo = await fetchTokenIdentity(env, userToken, 'page');
    if (selectedSet.has(pageInfo.id)) {
      matched = [{ id: pageInfo.id, name: pageInfo.name, picture_url: pageInfo.pictureUrl || '', access_token: userToken }];
    }
  } else {
    const fbPages = await fetchUserPages(env, userToken);
    matched = fbPages.filter((p) => selectedSet.has(p.id));
  }

  if (matched.length === 0) {
    return errorResponse('None of the selected Pages were returned by Facebook', 400);
  }

  // Check ownership conflicts across licenses & count new pages against maxPages
  let newAdditions = 0;
  for (const p of matched) {
    const existing = await env.DB.prepare(`SELECT id, license_id FROM pages WHERE fb_page_id = ?`)
      .bind(p.id)
      .first();
    if (existing) {
      if ((existing.license_id ?? null) !== (auth.licenseId ?? null)) {
        return errorResponse(`Page "${p.name}" is already connected under another license.`, 409);
      }
    } else {
      newAdditions++;
    }
  }

  if (auth.role === 'license' && newAdditions > 0) {
    const cntRow = await env.DB.prepare(`SELECT COUNT(*) AS cnt FROM pages WHERE license_id = ?`)
      .bind(auth.licenseId)
      .first();
    const currentCount = Number(cntRow?.cnt || 0);
    if (currentCount + newAdditions > auth.maxPages) {
      return errorResponse(
        `License limit allows max ${auth.maxPages} Page(s) (currently ${currentCount}).`,
        403
      );
    }
  }

  const nowIso = new Date().toISOString();
  const stmts = [];
  for (const p of matched) {
    const encryptedPageToken = await encryptText(p.access_token, env.ENCRYPTION_KEY);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO pages (account_id, license_id, fb_page_id, name, picture_url, encrypted_page_token, status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)
         ON CONFLICT(fb_page_id) DO UPDATE SET
           account_id = excluded.account_id,
           name = excluded.name,
           picture_url = COALESCE(NULLIF(excluded.picture_url, ''), pages.picture_url),
           encrypted_page_token = excluded.encrypted_page_token,
           status = CASE WHEN pages.status = 'needs_attention' THEN 'active' ELSE pages.status END,
           last_error = NULL,
           updated_at = excluded.updated_at`
      ).bind(account.id, auth.licenseId, p.id, p.name, p.picture_url || '', encryptedPageToken, nowIso, nowIso)
    );
  }
  stmts.push(
    prepareEventStmt(env.DB, {
      licenseId: auth.licenseId,
      level: 'info',
      eventType: 'pages_added',
      message: `Added/updated ${matched.length} Page(s) from account ${account.name}`,
      details: { accountId: account.id, fbPageIds: matched.map((m) => m.id) },
    })
  );

  await env.DB.batch(stmts);
  return jsonResponse({ ok: true, addedCount: matched.length });
}

async function handleDeleteAccount(env, auth, accountId) {
  const row = await env.DB.prepare(`SELECT id, name, license_id FROM accounts WHERE id = ?`)
    .bind(accountId)
    .first();
  if (!row || (row.license_id ?? null) !== (auth.licenseId ?? null)) {
    return errorResponse('Account not found', 404);
  }

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(accountId),
    prepareEventStmt(env.DB, {
      licenseId: auth.licenseId,
      level: 'info',
      eventType: 'account_deleted',
      message: `Deleted Facebook account ${row.name}`,
    }),
  ]);
  return jsonResponse({ ok: true });
}

async function handleDriveInfo(env, auth) {
  const info = await getDriveConnectionInfo(env, auth.licenseId);
  return jsonResponse(info);
}

async function handleDriveFolders(env, auth) {
  try {
    const folders = await listSharedFolders(env, auth.licenseId);
    return jsonResponse({ folders });
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}

async function handleDriveDisconnect(env, auth) {
  const nowIso = new Date().toISOString();
  const cacheKey = `google_oauth:${auth.licenseId ? String(auth.licenseId) : 'admin'}`;
  const stmts = [
    env.DB.prepare(`DELETE FROM cached_tokens WHERE cache_key = ?`).bind(cacheKey),
    prepareEventStmt(env.DB, {
      licenseId: auth.licenseId,
      level: 'info',
      eventType: 'google_drive_disconnected',
      message: 'Disconnected Google Drive account',
    }),
  ];

  if (auth.licenseId) {
    stmts.unshift(
      env.DB.prepare(
        `UPDATE licenses
         SET google_email = NULL, google_encrypted_refresh_token = NULL, google_connected_at = NULL, updated_at = ?
         WHERE id = ?`
      ).bind(nowIso, auth.licenseId)
    );
  } else {
    stmts.unshift(
      env.DB.prepare(
        `DELETE FROM settings WHERE key IN ('google_oauth_email', 'google_oauth_refresh_token', 'google_oauth_connected_at')`
      )
    );
  }

  await env.DB.batch(stmts);
  const info = await getDriveConnectionInfo(env, auth.licenseId);
  return jsonResponse(info);
}

async function verifyOwnedPage(env, auth, pageId) {
  const page = await env.DB.prepare(`SELECT * FROM pages WHERE id = ?`).bind(pageId).first();
  if (!page || (page.license_id ?? null) !== (auth.licenseId ?? null)) {
    return null;
  }
  return page;
}

async function handleGetPage(env, auth, pageId) {
  const owned = await verifyOwnedPage(env, auth, pageId);
  if (!owned) return errorResponse('Page not found', 404);

  const [pageRes, blockedRes, recentPlansRes, recentEventsRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.account_id, p.fb_page_id, p.name, p.picture_url,
              p.captions_folder_id, p.captions_folder_name,
              p.media_folder_id, p.media_folder_name,
              p.timezone, p.slots, p.jitter_minutes, p.daily_cap,
              p.min_gap_minutes, p.ramp_up_enabled, p.ramp_start, p.ramp_step_days,
              p.last_drive_sync_at, p.last_drive_sync_error,
              p.status, p.last_error, p.created_at, p.updated_at,
              a.name AS account_name, a.status AS account_status
       FROM pages p JOIN accounts a ON a.id = p.account_id
       WHERE p.id = ?`
    ).bind(pageId),
    env.DB.prepare(
      `SELECT id, file_id, file_name, reason, attempts, created_at FROM blocked_files WHERE page_id = ?`
    ).bind(pageId),
    env.DB.prepare(
      `SELECT id, local_date, slot_time, planned_local, planned_utc, status, attempts, fb_post_id, file_name, caption_number, error, finished_at
       FROM plan WHERE page_id = ? ORDER BY id DESC LIMIT 30`
    ).bind(pageId),
    env.DB.prepare(
      `SELECT id, level, event_type, message, created_at FROM events WHERE page_id = ? ORDER BY id DESC LIMIT 30`
    ).bind(pageId),
  ]);

  const page = pageRes.results?.[0];
  if (!page) return errorResponse('Page not found', 404);

  let parsedSlots = [];
  try {
    parsedSlots = JSON.parse(page.slots || '[]');
  } catch {
    parsedSlots = [];
  }

  return jsonResponse({
    page: {
      ...page,
      slots: parsedSlots,
      ramp_up_enabled: Boolean(page.ramp_up_enabled),
    },
    blockedFiles: blockedRes.results || [],
    recentPlans: recentPlansRes.results || [],
    recentEvents: recentEventsRes.results || [],
  });
}

async function handleUpdatePage(request, env, auth, pageId) {
  const existing = await verifyOwnedPage(env, auth, pageId);
  if (!existing) return errorResponse('Page not found', 404);

  const body = await readJsonBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400);

  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name;
  const timezone =
    typeof body.timezone === 'string' && isValidTimeZone(body.timezone.trim())
      ? body.timezone.trim()
      : existing.timezone;

  let slotsJson = existing.slots;
  if (Array.isArray(body.slots)) {
    const cleanSlots = [];
    const seen = new Set();
    for (const s of body.slots) {
      const mins = parseSlotMinutes(String(s));
      if (mins !== null) {
        const hhmm = minutesToHHMM(mins);
        if (!seen.has(hhmm)) {
          seen.add(hhmm);
          cleanSlots.push(hhmm);
        }
      }
    }
    cleanSlots.sort();
    slotsJson = JSON.stringify(cleanSlots);
  }

  const jitter =
    body.jitter_minutes != null ? Math.max(0, Math.min(180, Math.round(Number(body.jitter_minutes)))) : existing.jitter_minutes;
  const parsedCleanSlots = (() => {
    try {
      return JSON.parse(slotsJson || '[]');
    } catch {
      return [];
    }
  })();
  const dailyCap =
    body.auto_cap === true
      ? Math.max(1, parsedCleanSlots.length || 1)
      : body.daily_cap != null
        ? Math.max(1, Math.min(50, Math.round(Number(body.daily_cap))))
        : existing.daily_cap;
  const minGap =
    body.min_gap_minutes != null ? Math.max(0, Math.min(720, Math.round(Number(body.min_gap_minutes)))) : existing.min_gap_minutes;
  const rampEnabled =
    body.ramp_up_enabled != null ? (body.ramp_up_enabled ? 1 : 0) : existing.ramp_up_enabled;
  const rampStart =
    body.ramp_start != null ? Math.max(1, Math.min(50, Math.round(Number(body.ramp_start)))) : existing.ramp_start;
  const rampStepDays =
    body.ramp_step_days != null ? Math.max(1, Math.min(30, Math.round(Number(body.ramp_step_days)))) : existing.ramp_step_days;

  const captionsFolderId =
    body.captions_folder_id != null ? String(body.captions_folder_id).trim() : existing.captions_folder_id;
  const captionsFolderName =
    body.captions_folder_name != null ? String(body.captions_folder_name).trim() : existing.captions_folder_name;
  const mediaFolderId =
    body.media_folder_id != null ? String(body.media_folder_id).trim() : existing.media_folder_id;
  const mediaFolderName =
    body.media_folder_name != null ? String(body.media_folder_name).trim() : existing.media_folder_name;

  const allowedStatuses = new Set(['active', 'paused', 'needs_attention']);
  const status = allowedStatuses.has(body.status) ? body.status : existing.status;
  const lastError = status === 'active' ? null : existing.last_error;
  const nowIso = new Date().toISOString();
  const oldLocalDate = getLocalParts(Date.now(), existing.timezone).localDate;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE pages SET
         name = ?, captions_folder_id = ?, captions_folder_name = ?,
         media_folder_id = ?, media_folder_name = ?,
         timezone = ?, slots = ?, jitter_minutes = ?, daily_cap = ?,
         min_gap_minutes = ?, ramp_up_enabled = ?, ramp_start = ?, ramp_step_days = ?,
         status = ?, last_error = ?, updated_at = ?
       WHERE id = ?`
    ).bind(
      name,
      captionsFolderId,
      captionsFolderName,
      mediaFolderId,
      mediaFolderName,
      timezone,
      slotsJson,
      jitter,
      dailyCap,
      minGap,
      rampEnabled,
      rampStart,
      rampStepDays,
      status,
      lastError,
      nowIso,
      pageId
    ),
    prepareEventStmt(env.DB, {
      pageId,
      licenseId: auth.licenseId,
      level: 'info',
      eventType: 'page_updated',
      message: `Updated settings for Page "${name}"`,
    }),
  ]);

  const updated = await env.DB.prepare(`SELECT * FROM pages WHERE id = ?`).bind(pageId).first();
  if (updated && updated.status === 'active') {
    await regenerateTodayPlanForPage(env, updated, oldLocalDate);
    if (updated.captions_folder_id && updated.media_folder_id) {
      await syncDriveQueueForPage(env, updated, { force: true }).catch(() => null);
    }
  }

  return jsonResponse({ ok: true });
}

async function handleDeletePage(env, auth, pageId) {
  const row = await verifyOwnedPage(env, auth, pageId);
  if (!row) return errorResponse('Page not found', 404);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM pages WHERE id = ?`).bind(pageId),
    prepareEventStmt(env.DB, {
      licenseId: auth.licenseId,
      level: 'info',
      eventType: 'page_deleted',
      message: `Deleted Page "${row.name}"`,
    }),
  ]);
  return jsonResponse({ ok: true });
}

async function handlePausePage(request, env, auth, pageId) {
  const page = await verifyOwnedPage(env, auth, pageId);
  if (!page) return errorResponse('Page not found', 404);

  const body = await readJsonBody(request);
  const nextStatus = body?.paused ? 'paused' : 'active';
  const nowIso = new Date().toISOString();

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE pages SET status = ?, last_error = CASE WHEN ? = 'active' THEN NULL ELSE last_error END, updated_at = ? WHERE id = ?`
    ).bind(nextStatus, nextStatus, nowIso, pageId),
    prepareEventStmt(env.DB, {
      pageId,
      licenseId: auth.licenseId,
      level: 'info',
      eventType: nextStatus === 'paused' ? 'page_paused' : 'page_resumed',
      message: `Page "${page.name}" ${nextStatus === 'paused' ? 'paused' : 'resumed'}`,
    }),
  ]);

  if (nextStatus === 'active') {
    const refreshed = await env.DB.prepare(`SELECT * FROM pages WHERE id = ?`).bind(pageId).first();
    const localDate = getLocalParts(Date.now(), refreshed.timezone).localDate;
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM plan WHERE page_id = ? AND local_date = ?`
    )
      .bind(pageId, localDate)
      .first();
    if (!countRow || Number(countRow.cnt) === 0) {
      await regenerateTodayPlanForPage(env, refreshed);
    }
  }

  return jsonResponse({ ok: true, status: nextStatus });
}

async function handleRetryFailed(env, auth, pageId) {
  const page = await verifyOwnedPage(env, auth, pageId);
  if (!page) return errorResponse('Page not found', 404);

  const localDate = getLocalParts(Date.now(), page.timezone).localDate;
  const nowIso = new Date().toISOString();

  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE plan
       SET status = 'pending', attempts = 0, next_attempt_utc = ?, error = NULL, claimed_at = NULL, finished_at = NULL
       WHERE page_id = ? AND local_date = ? AND status = 'failed'`
    ).bind(nowIso, pageId, localDate),
    env.DB.prepare(
      `UPDATE pages
       SET status = CASE WHEN status = 'needs_attention' THEN 'active' ELSE status END,
           last_error = NULL,
           updated_at = ?
       WHERE id = ?`
    ).bind(nowIso, pageId),
    prepareEventStmt(env.DB, {
      pageId,
      licenseId: auth.licenseId,
      level: 'info',
      eventType: 'retry_failed_requested',
      message: `Reset failed slots for "${page.name}" to pending`,
    }),
  ]);

  return jsonResponse({ ok: true, resetCount: res[0]?.meta?.changes || 0 });
}

async function handleUnblockFiles(request, env, auth, pageId) {
  const page = await verifyOwnedPage(env, auth, pageId);
  if (!page) return errorResponse('Page not found', 404);

  const body = await readJsonBody(request);
  const fileId = typeof body?.fileId === 'string' && body.fileId ? body.fileId : null;

  let res;
  if (fileId) {
    res = await env.DB.batch([
      env.DB.prepare(`DELETE FROM blocked_files WHERE page_id = ? AND file_id = ?`).bind(pageId, fileId),
      prepareEventStmt(env.DB, {
        pageId,
        licenseId: auth.licenseId,
        level: 'info',
        eventType: 'file_unblocked',
        message: `Unblocked file ${fileId}`,
      }),
    ]);
  } else {
    res = await env.DB.batch([
      env.DB.prepare(`DELETE FROM blocked_files WHERE page_id = ?`).bind(pageId),
      prepareEventStmt(env.DB, {
        pageId,
        licenseId: auth.licenseId,
        level: 'info',
        eventType: 'all_files_unblocked',
        message: `Unblocked all blocked files for Page #${pageId}`,
      }),
    ]);
  }
  return jsonResponse({ ok: true, unblockedCount: res[0]?.meta?.changes || 0 });
}

async function handlePostsFeed(request, env, auth) {
  const url = new URL(request.url);
  const pageId = url.searchParams.get('pageId');
  const status = url.searchParams.get('status');
  const limit = Math.min(200, Math.max(20, Number(url.searchParams.get('limit') || 120)));

  const nowMs = Date.now();
  await pruneExpiredHistory(env.DB, nowMs).catch(() => null);
  const cutoff7dIso = new Date(nowMs - 7 * 86400_000).toISOString();

  const scope = licenseScopeSql('p.license_id', auth.licenseId);
  const where = [scope.sql, 'pl.planned_utc >= ?'];
  const params = [...scope.params, cutoff7dIso];

  if (pageId && /^\d+$/.test(pageId)) {
    where.push('pl.page_id = ?');
    params.push(Number(pageId));
  }
  if (status && ['pending', 'posting', 'posted', 'failed', 'skipped', 'missed'].includes(status)) {
    where.push('pl.status = ?');
    params.push(status);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  params.push(limit);

  const res = await env.DB.prepare(
    `SELECT pl.id, pl.page_id, pl.local_date, pl.slot_time, pl.planned_local, pl.planned_utc,
            pl.status, pl.attempts, pl.next_attempt_utc, pl.fb_post_id, pl.file_id, pl.file_name,
            pl.caption_number, substr(pl.caption_text, 1, 200) AS caption_preview,
            pl.error, pl.finished_at,
            p.name AS page_name, p.fb_page_id, p.picture_url AS page_picture_url, p.timezone AS page_timezone
     FROM plan pl
     JOIN pages p ON p.id = pl.page_id
     ${whereSql}
     ORDER BY
       CASE WHEN pl.status IN ('posting', 'pending') THEN 0 ELSE 1 END ASC,
       CASE WHEN pl.status IN ('posting', 'pending') THEN pl.planned_utc END ASC,
       pl.planned_utc DESC
     LIMIT ?`
  )
    .bind(...params)
    .all();

  return jsonResponse({ posts: res.results || [] });
}

async function handleSyncWorkspacePosts(request, env, auth) {
  const body = await readJsonBody(request);
  const targetPageId = body?.pageId ? Number(body.pageId) : null;
  const scope = licenseScopeSql('p.license_id', auth.licenseId);

  let pages = [];
  if (targetPageId) {
    const owned = await verifyOwnedPage(env, auth, targetPageId);
    if (!owned) return errorResponse('Page not found', 404);
    pages = [owned];
  } else {
    const res = await env.DB.prepare(
      `SELECT p.* FROM pages p
       JOIN accounts a ON a.id = p.account_id
       WHERE ${scope.sql} AND p.status = 'active' AND a.status = 'active'
         AND p.captions_folder_id != '' AND p.media_folder_id != ''
       ORDER BY COALESCE(p.last_drive_sync_at, '') ASC
       LIMIT 6`
    )
      .bind(...scope.params)
      .all();
    pages = res.results || [];
  }

  let syncedPages = 0;
  let filledSlots = 0;
  const results = [];

  for (const page of pages) {
    const localDate = getLocalParts(Date.now(), page.timezone).localDate;
    const countRow = await env.DB.prepare(
      `SELECT COUNT(*) AS cnt FROM plan WHERE page_id = ? AND local_date = ?`
    )
      .bind(page.id, localDate)
      .first();
    if (!countRow || Number(countRow.cnt) === 0) {
      await regenerateTodayPlanForPage(env, page);
    }

    const res = await syncDriveQueueForPage(env, page, { force: true });
    if (res.synced) {
      syncedPages++;
      filledSlots += Number(res.filledCount || 0);
    }
    results.push({ pageId: page.id, pageName: page.name, ...res });
  }

  return jsonResponse({ ok: true, syncedPages, filledSlots, results });
}

async function handleEvents(request, env, auth) {
  const url = new URL(request.url);
  const pageId = url.searchParams.get('pageId');
  const level = url.searchParams.get('level');
  const date = url.searchParams.get('date');
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit') || 100)));

  const nowMs = Date.now();
  await pruneExpiredHistory(env.DB, nowMs).catch(() => null);
  const cutoff7dIso = new Date(nowMs - 7 * 86400_000).toISOString();

  const scope = licenseScopeSql('e.license_id', auth.licenseId);
  const where = [scope.sql, 'e.created_at >= ?'];
  const params = [...scope.params, cutoff7dIso];

  if (pageId && /^\d+$/.test(pageId)) {
    where.push('e.page_id = ?');
    params.push(Number(pageId));
  }
  if (level && ['info', 'warn', 'error'].includes(level)) {
    where.push('e.level = ?');
    params.push(level);
  }
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    where.push('e.created_at >= ? AND e.created_at <= ?');
    params.push(`${date}T00:00:00.000Z`, `${date}T23:59:59.999Z`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit);

  const res = await env.DB.prepare(
    `SELECT e.id, e.page_id, p.name AS page_name, e.level, e.event_type, e.message, e.details, e.created_at
     FROM events e
     LEFT JOIN pages p ON p.id = e.page_id
     ${whereSql}
     ORDER BY e.id DESC
     LIMIT ?`
  )
    .bind(...params)
    .all();

  return jsonResponse({ events: res.results || [] });
}

// --- Super Admin License Management ---

async function handleListLicenses(env) {
  const res = await env.DB.prepare(
    `SELECT l.id, l.key_prefix, l.label, l.max_pages, l.status, l.expires_at, l.global_pause,
            l.google_email, l.google_connected_at, l.created_at, l.updated_at,
            (SELECT COUNT(*) FROM accounts a WHERE a.license_id = l.id) AS account_count,
            (SELECT COUNT(*) FROM pages p WHERE p.license_id = l.id) AS page_count
     FROM licenses l
     ORDER BY l.id DESC`
  ).all();
  return jsonResponse({ licenses: res.results || [] });
}

async function handleCreateLicense(request, env) {
  const body = await readJsonBody(request);
  const label = typeof body?.label === 'string' ? body.label.trim().slice(0, 120) : '';
  const maxPages = Math.max(1, Math.min(500, Math.round(Number(body?.maxPages ?? 20))));
  const expiresDaysRaw = body?.expiresDays;
  const expiresDays =
    expiresDaysRaw != null && Number(expiresDaysRaw) > 0
      ? Math.min(3650, Math.round(Number(expiresDaysRaw)))
      : null;

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const expiresAt = expiresDays ? new Date(nowMs + expiresDays * 86400_000).toISOString() : null;

  const rawKey = generateLicenseKey();
  const keyHash = await sha256Hex(rawKey);
  const keyPrefix = `${rawKey.slice(0, 7)}••••${rawKey.slice(-4)}`;

  const insertRes = await env.DB.prepare(
    `INSERT INTO licenses (key_hash, key_prefix, label, max_pages, status, expires_at, global_pause, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'active', ?, 0, ?, ?)`
  )
    .bind(keyHash, keyPrefix, label, maxPages, expiresAt, nowIso, nowIso)
    .run();

  const licenseId = insertRes.meta?.last_row_id;
  const license = await env.DB.prepare(
    `SELECT id, key_prefix, label, max_pages, status, expires_at, global_pause, google_email, created_at, updated_at
     FROM licenses WHERE id = ?`
  )
    .bind(licenseId)
    .first();

  await logEvent(env.DB, {
    level: 'info',
    eventType: 'license_created',
    message: `Created License Key #${licenseId}${label ? ` (${label})` : ''}, max ${maxPages} pages`,
    details: { licenseId, label, maxPages, expiresAt },
  });

  return jsonResponse({ license, rawKey }, 201);
}

async function handleUpdateLicense(request, env, licenseId) {
  const existing = await env.DB.prepare(`SELECT * FROM licenses WHERE id = ?`).bind(licenseId).first();
  if (!existing) return errorResponse('License not found', 404);

  const body = await readJsonBody(request);
  if (!body) return errorResponse('Invalid JSON body', 400);

  const label =
    typeof body.label === 'string' ? body.label.trim().slice(0, 120) : existing.label;
  const maxPages =
    body.maxPages != null
      ? Math.max(1, Math.min(500, Math.round(Number(body.maxPages))))
      : existing.max_pages;
  const status =
    body.status === 'active' || body.status === 'disabled' ? body.status : existing.status;

  let expiresAt = existing.expires_at;
  if (body.neverExpires === true) {
    expiresAt = null;
  } else if (body.extendDays != null && Number(body.extendDays) > 0) {
    const baseMs =
      existing.expires_at && Date.parse(existing.expires_at) > Date.now()
        ? Date.parse(existing.expires_at)
        : Date.now();
    expiresAt = new Date(baseMs + Math.round(Number(body.extendDays)) * 86400_000).toISOString();
  }

  const nowIso = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE licenses SET label = ?, max_pages = ?, status = ?, expires_at = ?, updated_at = ? WHERE id = ?`
    ).bind(label, maxPages, status, expiresAt, nowIso, licenseId),
    prepareEventStmt(env.DB, {
      level: status === 'disabled' ? 'warn' : 'info',
      eventType: 'license_updated',
      message: `Updated License #${licenseId} (${label || existing.key_prefix}): status=${status}, maxPages=${maxPages}`,
      details: { licenseId, status, maxPages, expiresAt },
    }),
  ]);

  return jsonResponse({ ok: true });
}

async function handleDeleteLicense(env, licenseId) {
  const existing = await env.DB.prepare(`SELECT id, label, key_prefix FROM licenses WHERE id = ?`)
    .bind(licenseId)
    .first();
  if (!existing) return errorResponse('License not found', 404);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM events WHERE license_id = ?`).bind(licenseId),
    env.DB.prepare(`DELETE FROM pages WHERE license_id = ?`).bind(licenseId),
    env.DB.prepare(`DELETE FROM accounts WHERE license_id = ?`).bind(licenseId),
    env.DB.prepare(`DELETE FROM cached_tokens WHERE cache_key = ?`).bind(`google_oauth:${licenseId}`),
    env.DB.prepare(`DELETE FROM licenses WHERE id = ?`).bind(licenseId),
    prepareEventStmt(env.DB, {
      level: 'warn',
      eventType: 'license_deleted',
      message: `Deleted License #${licenseId} (${existing.label || existing.key_prefix}) and all its workspace data`,
    }),
  ]);

  return jsonResponse({ ok: true });
}

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();

      // Public auth/session endpoints
      if (path === '/api/session' && method === 'GET') {
        const auth = await resolveAuthContext(request, env);
        return jsonResponse({
          authenticated: Boolean(auth),
          role: auth?.role || null,
          licenseId: auth?.licenseId ?? null,
          label: auth?.label || null,
          maxPages: auth?.maxPages ?? null,
        });
      }
      if (path === '/api/login' && method === 'POST') {
        return handleLogin(request, env);
      }
      if (path === '/api/logout' && method === 'POST') {
        return handleLogout(request, env);
      }

      // Google Drive OAuth endpoints
      if (path === '/auth/google/start' && method === 'GET') {
        return handleGoogleStart(request, env);
      }
      if (path === '/auth/google/callback' && method === 'GET') {
        return handleGoogleCallback(request, env);
      }

      // Protected /api/* routes (Super Admin OR Active License)
      if (path.startsWith('/api/')) {
        const auth = await resolveAuthContext(request, env);
        if (!auth) {
          return errorResponse('Unauthorized', 401);
        }

        if (path === '/api/dashboard' && method === 'GET') {
          return handleDashboard(env, auth);
        }

        if (path === '/api/settings/global-pause' && method === 'POST') {
          const body = await readJsonBody(request);
          const paused = Boolean(body?.paused);
          const nowIso = new Date().toISOString();

          if (auth.licenseId) {
            await env.DB.batch([
              env.DB.prepare(`UPDATE licenses SET global_pause = ?, updated_at = ? WHERE id = ?`).bind(
                paused ? 1 : 0,
                nowIso,
                auth.licenseId
              ),
              prepareEventStmt(env.DB, {
                licenseId: auth.licenseId,
                level: paused ? 'warn' : 'info',
                eventType: paused ? 'global_paused' : 'global_resumed',
                message: paused ? 'Workspace pause enabled' : 'Workspace pause disabled',
              }),
            ]);
          } else {
            await env.DB.batch([
              env.DB.prepare(
                `INSERT INTO settings (key, value) VALUES ('global_pause', ?)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value`
              ).bind(paused ? '1' : '0'),
              prepareEventStmt(env.DB, {
                level: paused ? 'warn' : 'info',
                eventType: paused ? 'global_paused' : 'global_resumed',
                message: paused ? 'Global pause enabled (kill switch)' : 'Global pause disabled',
              }),
            ]);
          }
          return jsonResponse({ globalPause: paused });
        }

        if (path === '/api/accounts' && method === 'GET') {
          return handleListAccounts(env, auth);
        }
        if (path === '/api/accounts/manual' && method === 'POST') {
          return handleManualAccount(request, env, auth);
        }

        let m;
        if ((m = /^\/api\/accounts\/(\d+)\/check$/.exec(path)) && method === 'POST') {
          return handleCheckAccount(env, auth, Number(m[1]));
        }
        if ((m = /^\/api\/accounts\/(\d+)\/fb-pages$/.exec(path)) && method === 'GET') {
          return handleAccountFbPages(env, auth, Number(m[1]));
        }
        if ((m = /^\/api\/accounts\/(\d+)\/pages$/.exec(path)) && method === 'POST') {
          return handleAddAccountPages(request, env, auth, Number(m[1]));
        }
        if ((m = /^\/api\/accounts\/(\d+)$/.exec(path)) && method === 'DELETE') {
          return handleDeleteAccount(env, auth, Number(m[1]));
        }

        if (path === '/api/drive/info' && method === 'GET') {
          return handleDriveInfo(env, auth);
        }
        if (path === '/api/drive/folders' && method === 'GET') {
          return handleDriveFolders(env, auth);
        }
        if (path === '/api/drive/disconnect' && method === 'POST') {
          return handleDriveDisconnect(env, auth);
        }

        if ((m = /^\/api\/pages\/(\d+)$/.exec(path))) {
          const pageId = Number(m[1]);
          if (method === 'GET') return handleGetPage(env, auth, pageId);
          if (method === 'PATCH') return handleUpdatePage(request, env, auth, pageId);
          if (method === 'DELETE') return handleDeletePage(env, auth, pageId);
        }
        if ((m = /^\/api\/pages\/(\d+)\/pause$/.exec(path)) && method === 'POST') {
          return handlePausePage(request, env, auth, Number(m[1]));
        }
        if ((m = /^\/api\/pages\/(\d+)\/preview$/.exec(path)) && method === 'POST') {
          const pageId = Number(m[1]);
          const owned = await verifyOwnedPage(env, auth, pageId);
          if (!owned) return errorResponse('Page not found', 404);
          try {
            const preview = await previewNextPostForPage(env, pageId);
            return jsonResponse(preview);
          } catch (err) {
            return errorResponse(err.message, 400);
          }
        }
        if ((m = /^\/api\/pages\/(\d+)\/post-now$/.exec(path)) && method === 'POST') {
          const pageId = Number(m[1]);
          const owned = await verifyOwnedPage(env, auth, pageId);
          if (!owned) return errorResponse('Page not found', 404);
          try {
            const result = await postNowForPage(env, pageId);
            return jsonResponse(result);
          } catch (err) {
            return errorResponse(err.message, 400);
          }
        }
        if ((m = /^\/api\/pages\/(\d+)\/retry-failed$/.exec(path)) && method === 'POST') {
          return handleRetryFailed(env, auth, Number(m[1]));
        }
        if ((m = /^\/api\/pages\/(\d+)\/blocked-files$/.exec(path)) && method === 'GET') {
          const pageId = Number(m[1]);
          const owned = await verifyOwnedPage(env, auth, pageId);
          if (!owned) return errorResponse('Page not found', 404);
          const res = await env.DB.prepare(
            `SELECT id, file_id, file_name, reason, attempts, created_at FROM blocked_files WHERE page_id = ? ORDER BY id DESC`
          )
            .bind(pageId)
            .all();
          return jsonResponse({ blockedFiles: res.results || [] });
        }
        if ((m = /^\/api\/pages\/(\d+)\/sync$/.exec(path)) && method === 'POST') {
          const pageId = Number(m[1]);
          const owned = await verifyOwnedPage(env, auth, pageId);
          if (!owned) return errorResponse('Page not found', 404);
          const localDate = getLocalParts(Date.now(), owned.timezone).localDate;
          const cntRow = await env.DB.prepare(
            `SELECT COUNT(*) AS cnt FROM plan WHERE page_id = ? AND local_date = ?`
          )
            .bind(pageId, localDate)
            .first();
          if ((!cntRow || Number(cntRow.cnt) === 0) && owned.status === 'active') {
            await regenerateTodayPlanForPage(env, owned);
          }
          const result = await syncDriveQueueForPage(env, owned, { force: true });
          return jsonResponse({ ok: true, ...result });
        }
        if ((m = /^\/api\/pages\/(\d+)\/unblock$/.exec(path)) && method === 'POST') {
          return handleUnblockFiles(request, env, auth, Number(m[1]));
        }

        if (path === '/api/posts' && method === 'GET') {
          return handlePostsFeed(request, env, auth);
        }
        if (path === '/api/posts/sync' && method === 'POST') {
          return handleSyncWorkspacePosts(request, env, auth);
        }
        if (path === '/api/events' && method === 'GET') {
          return handleEvents(request, env, auth);
        }

        // Super Admin only: License Key Management
        if (path === '/api/licenses' && method === 'GET') {
          if (auth.role !== 'admin') return errorResponse('Forbidden', 403);
          return handleListLicenses(env);
        }
        if (path === '/api/licenses' && method === 'POST') {
          if (auth.role !== 'admin') return errorResponse('Forbidden', 403);
          return handleCreateLicense(request, env);
        }
        if ((m = /^\/api\/licenses\/(\d+)$/.exec(path))) {
          if (auth.role !== 'admin') return errorResponse('Forbidden', 403);
          const licId = Number(m[1]);
          if (method === 'PATCH') return handleUpdateLicense(request, env, licId);
          if (method === 'DELETE') return handleDeleteLicense(env, licId);
        }

        return errorResponse('API route not found', 404);
      }

      if (env.ASSETS) {
        return withSecurityHeaders(await env.ASSETS.fetch(request), { noStore: false });
      }
      return withSecurityHeaders(new Response('Not Found', { status: 404 }));
    } catch (err) {
      return errorResponse(err?.message || 'Unexpected server error', 500);
    }
  },

  async scheduled(event, env, ctx) {
    await ensureSchema(env.DB);
    ctx.waitUntil(runCron(env));
  },
};
