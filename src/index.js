import {
  constantTimeEqual,
  decryptText,
  encryptText,
  signToken,
  verifyToken,
} from './crypto.js';
import { ensureSchema, logEvent, prepareEventStmt } from './db.js';
import { getServiceAccount, listSharedFolders } from './drive.js';
import {
  buildOAuthUrl,
  exchangeCodeForLongLivedToken,
  exchangeUserTokenForLongLived,
  fetchMe,
  fetchUserPages,
} from './facebook.js';
import {
  postNowForPage,
  previewNextPostForPage,
  regenerateTodayPlanForPage,
  runCron,
} from './scheduler.js';
import {
  INVITE_SESSION_COOKIE,
  checkInviteRateLimit,
  confirmInviteSelection,
  createInvite,
  createInviteSessionCookieValue,
  getInviteSelectablePages,
  isMetaDevModeAuthError,
  listInvites,
  lookupValidInvite,
  lookupValidInviteById,
  recordInviteBadHit,
  renderInviteHtml,
  revokeInvite,
  verifyInviteSessionCookie,
} from './invites.js';
import { getLocalParts, isValidTimeZone, minutesToHHMM, parseSlotMinutes } from './timezone.js';

const SESSION_COOKIE = 'pp_session';
const OAUTH_STATE_COOKIE = 'pp_fb_state';
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

async function getAuthenticatedSession(request, env) {
  if (!env.SESSION_SECRET) return null;
  const cookies = parseCookies(request);
  const token = cookies[SESSION_COOKIE];
  if (!token) return null;
  return verifyToken(token, env.SESSION_SECRET);
}

function getClientIp(request) {
  return (
    request.headers.get('CF-Connecting-IP') ||
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

async function handleLogin(request, env) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) {
    return errorResponse('ADMIN_PASSWORD or SESSION_SECRET secret is not configured', 503);
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
  const password = typeof body?.password === 'string' ? body.password : '';
  const ok = await constantTimeEqual(password, env.ADMIN_PASSWORD);

  if (!ok) {
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
        message: `Failed admin login attempt (${nextFailures}/${LOGIN_MAX_FAILURES})`,
        details: { ip },
      }),
    ]);

    if (lockedUntil) {
      return errorResponse('Too many failed login attempts. Locked for 15 minutes.', 429, {
        retryAfterSeconds: Math.ceil(LOGIN_LOCKOUT_MS / 1000),
      });
    }
    return errorResponse('Invalid password', 401);
  }

  const token = await signToken(
    { sub: 'admin', iat: nowMs, exp: nowMs + SESSION_TTL_MS },
    env.SESSION_SECRET
  );

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(ip),
    prepareEventStmt(env.DB, {
      level: 'info',
      eventType: 'login_success',
      message: 'Admin logged in',
      details: { ip },
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

  return jsonResponse({ ok: true }, 200, { 'Set-Cookie': cookie });
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

async function handleFacebookStart(request, env) {
  const url = new URL(request.url);
  const inviteToken = url.searchParams.get('invite');
  const nowMs = Date.now();
  const nonceBytes = crypto.getRandomValues(new Uint8Array(16));
  const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, '0')).join('');

  if (inviteToken) {
    const ip = getClientIp(request);
    const rate = await checkInviteRateLimit(env, ip);
    if (!rate.allowed) {
      return Response.redirect(`${url.origin}/invite/${encodeURIComponent(inviteToken)}?err=rate_limit`, 302);
    }

    const { valid, invite } = await lookupValidInvite(env, inviteToken);
    if (!valid || !invite) {
      await recordInviteBadHit(env, ip);
      return Response.redirect(`${url.origin}/invite/${encodeURIComponent(inviteToken)}?err=invalid`, 302);
    }

    const state = await signToken(
      { nonce, inviteId: invite.id, iat: nowMs, exp: nowMs + 10 * 60_000 },
      env.SESSION_SECRET
    );
    const cookiePayload = await signToken(
      { nonce, inviteId: invite.id, inviteToken, iat: nowMs, exp: nowMs + 10 * 60_000 },
      env.SESSION_SECRET
    );

    let authUrl;
    try {
      authUrl = buildOAuthUrl(env, url.origin, state);
    } catch (err) {
      return Response.redirect(
        `${url.origin}/invite/${encodeURIComponent(inviteToken)}?err=oauth_config`,
        302
      );
    }

    const stateCookie = makeCookieHeader(OAUTH_STATE_COOKIE, cookiePayload, {
      maxAge: 600,
      path: '/auth/facebook',
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

  const session = await getAuthenticatedSession(request, env);
  if (!session) {
    return Response.redirect(new URL('/?fb_error=unauthorized', request.url).toString(), 302);
  }

  const state = await signToken({ nonce, iat: nowMs, exp: nowMs + 10 * 60_000 }, env.SESSION_SECRET);

  let authUrl;
  try {
    authUrl = buildOAuthUrl(env, url.origin, state);
  } catch (err) {
    return Response.redirect(
      `${url.origin}/?tab=accounts&fb_error=${encodeURIComponent(err.message)}`,
      302
    );
  }

  const stateCookie = makeCookieHeader(OAUTH_STATE_COOKIE, nonce, {
    maxAge: 600,
    path: '/auth/facebook',
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

async function handleFacebookCallback(request, env) {
  const url = new URL(request.url);
  const origin = url.origin;
  const secureFlag = isHttpsTransport(request, env);
  const clearStateCookie = makeCookieHeader(OAUTH_STATE_COOKIE, '', {
    maxAge: 0,
    path: '/auth/facebook',
    sameSite: 'Lax',
    secure: secureFlag,
  });

  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const cookies = parseCookies(request);
  const rawStateCookie = cookies[OAUTH_STATE_COOKIE];

  const verifiedState = state ? await verifyToken(state, env.SESSION_SECRET) : null;

  // Check if this callback belongs to a public Invite flow
  if (verifiedState?.inviteId) {
    const cookiePayload = rawStateCookie ? await verifyToken(rawStateCookie, env.SESSION_SECRET) : null;
    const inviteToken = cookiePayload?.inviteToken || '';
    const redirectInviteErr = (errCode) =>
      withSecurityHeaders(
        new Response(null, {
          status: 302,
          headers: {
            Location: inviteToken
              ? `${origin}/invite/${encodeURIComponent(inviteToken)}?err=${encodeURIComponent(errCode)}`
              : `${origin}/invite/invalid?err=${encodeURIComponent(errCode)}`,
            'Set-Cookie': clearStateCookie,
          },
        })
      );

    if (
      !cookiePayload ||
      cookiePayload.nonce !== verifiedState.nonce ||
      Number(cookiePayload.inviteId) !== Number(verifiedState.inviteId)
    ) {
      return redirectInviteErr('invalid');
    }

    const invite = await lookupValidInviteById(env, Number(verifiedState.inviteId));
    if (!invite) {
      return redirectInviteErr('invalid');
    }

    const fbErr = url.searchParams.get('error_description') || url.searchParams.get('error_message') || url.searchParams.get('error');
    if (fbErr) {
      return redirectInviteErr(isMetaDevModeAuthError(fbErr) ? 'dev_mode' : 'oauth_failed');
    }
    if (!code) {
      return redirectInviteErr('oauth_failed');
    }

    try {
      const { accessToken, expiresIn } = await exchangeCodeForLongLivedToken(env, origin, code);
      const me = await fetchMe(env, accessToken);
      const inviteCookieVal = await createInviteSessionCookieValue(env, {
        inviteId: invite.id,
        fbUserId: me.id,
        fbUserName: me.name,
        accessToken,
        expiresIn,
      });

      const inviteSessionCookie = makeCookieHeader(INVITE_SESSION_COOKIE, inviteCookieVal, {
        maxAge: 900,
        path: '/',
        sameSite: 'Lax',
        secure: secureFlag,
      });

      const headers = new Headers({
        Location: `${origin}/invite/${encodeURIComponent(inviteToken)}?step=select`,
      });
      headers.append('Set-Cookie', clearStateCookie);
      headers.append('Set-Cookie', inviteSessionCookie);

      return withSecurityHeaders(new Response(null, { status: 302, headers }));
    } catch (err) {
      await logEvent(env.DB, {
        level: 'error',
        eventType: 'invite_oauth_failed',
        message: `Invite OAuth callback failed for invite #${invite.id}: ${err.message}`,
      });
      return redirectInviteErr(isMetaDevModeAuthError(err.message) ? 'dev_mode' : 'oauth_failed');
    }
  }

  // Standard Admin OAuth Flow
  const redirectErr = (msg) =>
    withSecurityHeaders(
      new Response(null, {
        status: 302,
        headers: {
          Location: `${origin}/?tab=accounts&fb_error=${encodeURIComponent(msg)}`,
          'Set-Cookie': clearStateCookie,
        },
      })
    );

  const session = await getAuthenticatedSession(request, env);
  if (!session) {
    return redirectErr('Admin session required before connecting Facebook.');
  }

  const fbErr = url.searchParams.get('error_description') || url.searchParams.get('error');
  if (fbErr) {
    return redirectErr(fbErr);
  }

  if (!code || !verifiedState || !rawStateCookie || verifiedState.nonce !== rawStateCookie) {
    return redirectErr('Invalid or expired OAuth state. Please try connecting again.');
  }

  try {
    const { accessToken, expiresIn } = await exchangeCodeForLongLivedToken(env, origin, code);
    const me = await fetchMe(env, accessToken);
    const encrypted = await encryptText(accessToken, env.ENCRYPTION_KEY);
    const nowIso = new Date().toISOString();
    const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

    await env.DB.prepare(
      `INSERT INTO accounts (fb_user_id, name, encrypted_token, token_expires_at, status, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', NULL, ?, ?)
       ON CONFLICT(fb_user_id) DO UPDATE SET
         name = excluded.name,
         encrypted_token = excluded.encrypted_token,
         token_expires_at = excluded.token_expires_at,
         status = 'active',
         last_error = NULL,
         updated_at = excluded.updated_at`
    )
      .bind(me.id, me.name, encrypted, expiresAt, nowIso, nowIso)
      .run();

    const accountRow = await env.DB.prepare(`SELECT id FROM accounts WHERE fb_user_id = ?`)
      .bind(me.id)
      .first();

    await logEvent(env.DB, {
      level: 'info',
      eventType: 'account_connected',
      message: `Connected Facebook account ${me.name} (${me.id}) via OAuth`,
      details: { accountId: accountRow?.id, fbUserId: me.id },
    });

    return withSecurityHeaders(
      new Response(null, {
        status: 302,
        headers: {
          Location: `${origin}/?tab=accounts&connected_account=${encodeURIComponent(String(accountRow?.id || ''))}`,
          'Set-Cookie': clearStateCookie,
        },
      })
    );
  } catch (err) {
    await logEvent(env.DB, {
      level: 'error',
      eventType: 'fb_oauth_failed',
      message: `Facebook OAuth callback failed: ${err.message}`,
    });
    return redirectErr(err.message);
  }
}

async function handleDashboard(env) {
  const nowMs = Date.now();
  const sparkDates = [];
  for (let i = 6; i >= 0; i--) {
    sparkDates.push(new Date(nowMs - i * 24 * 3600_000).toISOString().slice(0, 10));
  }
  const lookbackDate = sparkDates[0];

  const [settingsRes, pagesRes, planRes, blockedRes, accountsRes] = await env.DB.batch([
    env.DB.prepare(`SELECT value FROM settings WHERE key = 'global_pause'`),
    env.DB.prepare(
      `SELECT
         p.id, p.account_id, p.fb_page_id, p.name,
         p.captions_folder_id, p.captions_folder_name,
         p.media_folder_id, p.media_folder_name,
         p.timezone, p.slots, p.jitter_minutes, p.daily_cap,
         p.min_gap_minutes, p.ramp_up_enabled, p.ramp_start, p.ramp_step_days,
         p.status, p.last_error, p.created_at, p.updated_at,
         a.name AS account_name, a.status AS account_status
       FROM pages p
       JOIN accounts a ON a.id = p.account_id
       ORDER BY p.name ASC`
    ),
    env.DB.prepare(
      `SELECT id, page_id, local_date, slot_time, planned_local, planned_utc,
              status, attempts, next_attempt_utc, fb_post_id, file_name, caption_number,
              substr(caption_text, 1, 140) AS caption_preview,
              error, finished_at, cleanup_pending
       FROM plan
       WHERE local_date >= ?
       ORDER BY planned_utc ASC`
    ).bind(lookbackDate),
    env.DB.prepare(`SELECT page_id, COUNT(*) AS cnt FROM blocked_files GROUP BY page_id`),
    env.DB.prepare(`SELECT id, name, status, last_error FROM accounts`),
  ]);

  const globalPause = settingsRes.results?.[0]?.value === '1';
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

async function handleListAccounts(env) {
  const res = await env.DB.prepare(
    `SELECT a.id, a.fb_user_id, a.name, a.token_expires_at, a.status, a.last_error,
            a.created_at, a.updated_at, COUNT(p.id) AS page_count
     FROM accounts a
     LEFT JOIN pages p ON p.account_id = a.id
     GROUP BY a.id
     ORDER BY a.created_at DESC`
  ).all();

  return jsonResponse({ accounts: res.results || [] });
}

async function handleManualAccount(request, env) {
  const body = await readJsonBody(request);
  const rawToken = typeof body?.token === 'string' ? body.token.trim() : '';
  if (!rawToken) {
    return errorResponse('Access token is required', 400);
  }

  let finalToken = rawToken;
  let expiresIn = null;
  if (env.META_APP_ID && env.META_APP_SECRET) {
    try {
      const exchanged = await exchangeUserTokenForLongLived(env, rawToken);
      finalToken = exchanged.accessToken;
      expiresIn = exchanged.expiresIn;
    } catch {
      // Keep pasted token directly if already long-lived or exchange not applicable
    }
  }

  let me;
  try {
    me = await fetchMe(env, finalToken);
  } catch (err) {
    return errorResponse(`Facebook token verification failed: ${err.message}`, 400);
  }

  const encrypted = await encryptText(finalToken, env.ENCRYPTION_KEY);
  const nowIso = new Date().toISOString();
  const expiresAt = expiresIn ? new Date(Date.now() + expiresIn * 1000).toISOString() : null;

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
    .bind(me.id, me.name, encrypted, expiresAt, nowIso, nowIso)
    .run();

  const account = await env.DB.prepare(
    `SELECT id, fb_user_id, name, token_expires_at, status, last_error, created_at, updated_at
     FROM accounts WHERE fb_user_id = ?`
  )
    .bind(me.id)
    .first();

  await logEvent(env.DB, {
    level: 'info',
    eventType: 'fb_account_manual',
    message: `Connected Facebook account ${me.name} (${me.id}) via token`,
    details: { accountId: account?.id },
  });

  return jsonResponse({ account });
}

async function handleCheckAccount(env, accountId) {
  const row = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!row) return errorResponse('Account not found', 404);

  const nowIso = new Date().toISOString();
  try {
    const token = await decryptText(row.encrypted_token, env.ENCRYPTION_KEY);
    const me = await fetchMe(env, token);
    await env.DB.prepare(
      `UPDATE accounts SET name = ?, status = 'active', last_error = NULL, updated_at = ? WHERE id = ?`
    )
      .bind(me.name, nowIso, accountId)
      .run();
    return jsonResponse({ ok: true, status: 'active', name: me.name });
  } catch (err) {
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE accounts SET status = 'needs_attention', last_error = ?, updated_at = ? WHERE id = ?`
      ).bind(err.message, nowIso, accountId),
      prepareEventStmt(env.DB, {
        level: 'error',
        eventType: 'account_token_check_failed',
        message: `Account ${row.name} token health check failed: ${err.message}`,
      }),
    ]);
    return jsonResponse({ ok: false, status: 'needs_attention', error: err.message });
  }
}

async function handleAccountFbPages(env, accountId) {
  const row = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!row) return errorResponse('Account not found', 404);

  try {
    const token = await decryptText(row.encrypted_token, env.ENCRYPTION_KEY);
    const fbPages = await fetchUserPages(env, token);
    const existingRes = await env.DB.prepare(`SELECT id, fb_page_id FROM pages`).all();
    const existingMap = new Map();
    for (const p of existingRes.results || []) {
      existingMap.set(p.fb_page_id, p.id);
    }

    return jsonResponse({
      pages: fbPages.map((p) => ({
        fb_page_id: p.id,
        name: p.name,
        tasks: p.tasks,
        alreadyAdded: existingMap.has(p.id),
        existingPageId: existingMap.get(p.id) || null,
      })),
    });
  } catch (err) {
    return errorResponse(`Could not list Facebook Pages: ${err.message}`, 400);
  }
}

async function handleAddAccountPages(request, env, accountId) {
  const account = await env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!account) return errorResponse('Account not found', 404);

  const body = await readJsonBody(request);
  const selectedIds = Array.isArray(body?.fbPageIds) ? body.fbPageIds.map(String) : [];
  if (selectedIds.length === 0) {
    return errorResponse('Select at least one Page', 400);
  }

  const selectedSet = new Set(selectedIds);
  const userToken = await decryptText(account.encrypted_token, env.ENCRYPTION_KEY);
  const fbPages = await fetchUserPages(env, userToken);
  const matched = fbPages.filter((p) => selectedSet.has(p.id));

  if (matched.length === 0) {
    return errorResponse('None of the selected Pages were returned by Facebook', 400);
  }

  const nowIso = new Date().toISOString();
  const stmts = [];
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
      ).bind(account.id, p.id, p.name, encryptedPageToken, nowIso, nowIso)
    );
  }
  stmts.push(
    prepareEventStmt(env.DB, {
      level: 'info',
      eventType: 'pages_added',
      message: `Added/updated ${matched.length} Page(s) from account ${account.name}`,
      details: { accountId: account.id, fbPageIds: matched.map((m) => m.id) },
    })
  );

  await env.DB.batch(stmts);
  return jsonResponse({ ok: true, addedCount: matched.length });
}

async function handleDeleteAccount(env, accountId) {
  const row = await env.DB.prepare(`SELECT id, name FROM accounts WHERE id = ?`).bind(accountId).first();
  if (!row) return errorResponse('Account not found', 404);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM accounts WHERE id = ?`).bind(accountId),
    prepareEventStmt(env.DB, {
      level: 'info',
      eventType: 'account_deleted',
      message: `Deleted Facebook account ${row.name}`,
    }),
  ]);
  return jsonResponse({ ok: true });
}

async function handleDriveInfo(env) {
  try {
    const sa = getServiceAccount(env);
    return jsonResponse({
      configured: true,
      serviceAccountEmail: sa.client_email,
    });
  } catch (err) {
    return jsonResponse({
      configured: false,
      serviceAccountEmail: null,
      error: err.message,
    });
  }
}

async function handleDriveFolders(env) {
  try {
    const folders = await listSharedFolders(env);
    return jsonResponse({ folders });
  } catch (err) {
    return errorResponse(err.message, 400);
  }
}

async function handleGetPage(env, pageId) {
  const [pageRes, blockedRes, recentPlansRes, recentEventsRes] = await env.DB.batch([
    env.DB.prepare(
      `SELECT p.id, p.account_id, p.fb_page_id, p.name,
              p.captions_folder_id, p.captions_folder_name,
              p.media_folder_id, p.media_folder_name,
              p.timezone, p.slots, p.jitter_minutes, p.daily_cap,
              p.min_gap_minutes, p.ramp_up_enabled, p.ramp_start, p.ramp_step_days,
              p.status, p.last_error, p.created_at, p.updated_at,
              a.name AS account_name, a.status AS account_status
       FROM pages p JOIN accounts a ON a.id = p.account_id
       WHERE p.id = ?`
    ).bind(pageId),
    env.DB.prepare(`SELECT id, file_id, file_name, reason, attempts, created_at FROM blocked_files WHERE page_id = ?`).bind(
      pageId
    ),
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

async function handleUpdatePage(request, env, pageId) {
  const existing = await env.DB.prepare(`SELECT * FROM pages WHERE id = ?`).bind(pageId).first();
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
  const dailyCap =
    body.daily_cap != null ? Math.max(1, Math.min(24, Math.round(Number(body.daily_cap)))) : existing.daily_cap;
  const minGap =
    body.min_gap_minutes != null ? Math.max(0, Math.min(720, Math.round(Number(body.min_gap_minutes)))) : existing.min_gap_minutes;
  const rampEnabled =
    body.ramp_up_enabled != null ? (body.ramp_up_enabled ? 1 : 0) : existing.ramp_up_enabled;
  const rampStart =
    body.ramp_start != null ? Math.max(1, Math.min(24, Math.round(Number(body.ramp_start)))) : existing.ramp_start;
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
      level: 'info',
      eventType: 'page_updated',
      message: `Updated settings for Page "${name}"`,
    }),
  ]);

  const updated = await env.DB.prepare(`SELECT * FROM pages WHERE id = ?`).bind(pageId).first();
  if (updated && updated.status === 'active') {
    await regenerateTodayPlanForPage(env, updated);
  }

  return jsonResponse({ ok: true });
}

async function handleDeletePage(env, pageId) {
  const row = await env.DB.prepare(`SELECT id, name FROM pages WHERE id = ?`).bind(pageId).first();
  if (!row) return errorResponse('Page not found', 404);

  await env.DB.batch([
    env.DB.prepare(`DELETE FROM pages WHERE id = ?`).bind(pageId),
    prepareEventStmt(env.DB, {
      level: 'info',
      eventType: 'page_deleted',
      message: `Deleted Page "${row.name}"`,
    }),
  ]);
  return jsonResponse({ ok: true });
}

async function handlePausePage(request, env, pageId) {
  const page = await env.DB.prepare(`SELECT * FROM pages WHERE id = ?`).bind(pageId).first();
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

async function handleRetryFailed(env, pageId) {
  const page = await env.DB.prepare(`SELECT * FROM pages WHERE id = ?`).bind(pageId).first();
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
      level: 'info',
      eventType: 'retry_failed_requested',
      message: `Reset failed slots for "${page.name}" to pending`,
    }),
  ]);

  return jsonResponse({ ok: true, resetCount: res[0]?.meta?.changes || 0 });
}

async function handleUnblockFiles(request, env, pageId) {
  const body = await readJsonBody(request);
  const fileId = typeof body?.fileId === 'string' && body.fileId ? body.fileId : null;

  let res;
  if (fileId) {
    res = await env.DB.batch([
      env.DB.prepare(`DELETE FROM blocked_files WHERE page_id = ? AND file_id = ?`).bind(pageId, fileId),
      prepareEventStmt(env.DB, {
        pageId,
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
        level: 'info',
        eventType: 'all_files_unblocked',
        message: `Unblocked all blocked files for Page #${pageId}`,
      }),
    ]);
  }
  return jsonResponse({ ok: true, unblockedCount: res[0]?.meta?.changes || 0 });
}

async function handleEvents(request, env) {
  const url = new URL(request.url);
  const pageId = url.searchParams.get('pageId');
  const level = url.searchParams.get('level');
  const date = url.searchParams.get('date');
  const limit = Math.min(200, Math.max(10, Number(url.searchParams.get('limit') || 100)));

  const where = [];
  const params = [];

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

export default {
  async fetch(request, env, ctx) {
    try {
      await ensureSchema(env.DB);
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();

    // Public auth/session endpoints
    if (path === '/api/session' && method === 'GET') {
      const session = await getAuthenticatedSession(request, env);
      return jsonResponse({ authenticated: Boolean(session) });
    }
    if (path === '/api/login' && method === 'POST') {
      return handleLogin(request, env);
    }
    if (path === '/api/logout' && method === 'POST') {
      return handleLogout(request, env);
    }

    // Public Invite page (no admin login required)
    let inviteMatch;
    if ((inviteMatch = /^\/invite\/([^/]+)$/.exec(path)) && method === 'GET') {
      const ip = getClientIp(request);
      const rate = await checkInviteRateLimit(env, ip);
      if (!rate.allowed) {
        return withSecurityHeaders(
          new Response(
            renderInviteHtml({ valid: false, err: 'rate_limit' }),
            { status: 429, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          )
        );
      }

      const rawToken = decodeURIComponent(inviteMatch[1]);
      const { valid, invite } = await lookupValidInvite(env, rawToken);
      const errParam = url.searchParams.get('err') || '';
      const stepParam = url.searchParams.get('step') || 'intro';

      if (!valid || !invite) {
        await recordInviteBadHit(env, ip);
        return withSecurityHeaders(
          new Response(
            renderInviteHtml({ valid: false, err: errParam || 'invalid' }),
            { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
          )
        );
      }

      let step = 'intro';
      if (stepParam === 'select') {
        const cookies = parseCookies(request);
        const invSession = await verifyInviteSessionCookie(cookies[INVITE_SESSION_COOKIE], env);
        if (invSession && Number(invSession.inviteId) === Number(invite.id)) {
          step = 'select';
        }
      }

      if (step === 'intro' && !errParam) {
        await logEvent(env.DB, {
          level: 'info',
          eventType: 'invite_opened',
          message: `Invite #${invite.id}${invite.label ? ` (${invite.label})` : ''} opened`,
          details: { inviteId: invite.id },
        });
      }

      return withSecurityHeaders(
        new Response(
          renderInviteHtml({
            token: rawToken,
            valid: true,
            step,
            err: errParam,
            label: invite.label || '',
          }),
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        )
      );
    }

    // Public Invite APIs (strictly scoped to signed pp_invite_session cookie)
    if (path === '/api/invite/pages' && method === 'GET') {
      const ip = getClientIp(request);
      const rate = await checkInviteRateLimit(env, ip);
      if (!rate.allowed) return errorResponse('Too many requests. Please try again later.', 429);

      const cookies = parseCookies(request);
      const invSession = await verifyInviteSessionCookie(cookies[INVITE_SESSION_COOKIE], env);
      if (!invSession) {
        await recordInviteBadHit(env, ip);
        return errorResponse('Your invite session has expired. Please open the invite link again.', 401);
      }
      try {
        const data = await getInviteSelectablePages(env, invSession);
        return jsonResponse(data);
      } catch (err) {
        return errorResponse(err.message, 400);
      }
    }

    if (path === '/api/invite/confirm' && method === 'POST') {
      const ip = getClientIp(request);
      const rate = await checkInviteRateLimit(env, ip);
      if (!rate.allowed) return errorResponse('Too many requests. Please try again later.', 429);

      const cookies = parseCookies(request);
      const invSession = await verifyInviteSessionCookie(cookies[INVITE_SESSION_COOKIE], env);
      if (!invSession) {
        await recordInviteBadHit(env, ip);
        return errorResponse('Your invite session has expired. Please open the invite link again.', 401);
      }
      const body = await readJsonBody(request);
      try {
        const result = await confirmInviteSelection(env, invSession, body?.fbPageIds);
        const clearInviteCookie = makeCookieHeader(INVITE_SESSION_COOKIE, '', {
          maxAge: 0,
          path: '/',
          sameSite: 'Lax',
          secure: isHttpsTransport(request, env),
        });
        return jsonResponse(result, 200, { 'Set-Cookie': clearInviteCookie });
      } catch (err) {
        return errorResponse(err.message, 400);
      }
    }

    // Facebook OAuth endpoints
    if (path === '/auth/facebook/start' && method === 'GET') {
      return handleFacebookStart(request, env);
    }
    if (path === '/auth/facebook/callback' && method === 'GET') {
      return handleFacebookCallback(request, env);
    }

    // Protected /api/* routes (Admin only)
    if (path.startsWith('/api/')) {
      const session = await getAuthenticatedSession(request, env);
      if (!session) {
        return errorResponse('Unauthorized', 401);
      }

      if (path === '/api/dashboard' && method === 'GET') {
        return handleDashboard(env);
      }

      if (path === '/api/settings/global-pause' && method === 'POST') {
        const body = await readJsonBody(request);
        const paused = Boolean(body?.paused);
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
        return jsonResponse({ globalPause: paused });
      }

      if (path === '/api/accounts' && method === 'GET') {
        return handleListAccounts(env);
      }
      if (path === '/api/accounts/manual' && method === 'POST') {
        return handleManualAccount(request, env);
      }

      if (path === '/api/invites' && method === 'GET') {
        return jsonResponse({ invites: await listInvites(env) });
      }
      if (path === '/api/invites' && method === 'POST') {
        const body = await readJsonBody(request);
        const result = await createInvite(env, {
          label: body?.label || '',
          expiresHours: body?.expiresHours ?? 48,
          origin: url.origin,
        });
        return jsonResponse(result);
      }

      let m;
      if ((m = /^\/api\/invites\/(\d+)\/revoke$/.exec(path)) && method === 'POST') {
        const revoked = await revokeInvite(env, Number(m[1]));
        if (!revoked) return errorResponse('Invite not found or already used/revoked', 404);
        return jsonResponse({ ok: true });
      }

      if ((m = /^\/api\/accounts\/(\d+)\/check$/.exec(path)) && method === 'POST') {
        return handleCheckAccount(env, Number(m[1]));
      }
      if ((m = /^\/api\/accounts\/(\d+)\/fb-pages$/.exec(path)) && method === 'GET') {
        return handleAccountFbPages(env, Number(m[1]));
      }
      if ((m = /^\/api\/accounts\/(\d+)\/pages$/.exec(path)) && method === 'POST') {
        return handleAddAccountPages(request, env, Number(m[1]));
      }
      if ((m = /^\/api\/accounts\/(\d+)$/.exec(path)) && method === 'DELETE') {
        return handleDeleteAccount(env, Number(m[1]));
      }

      if (path === '/api/drive/info' && method === 'GET') {
        return handleDriveInfo(env);
      }
      if (path === '/api/drive/folders' && method === 'GET') {
        return handleDriveFolders(env);
      }

      if ((m = /^\/api\/pages\/(\d+)$/.exec(path))) {
        const pageId = Number(m[1]);
        if (method === 'GET') return handleGetPage(env, pageId);
        if (method === 'PATCH') return handleUpdatePage(request, env, pageId);
        if (method === 'DELETE') return handleDeletePage(env, pageId);
      }
      if ((m = /^\/api\/pages\/(\d+)\/pause$/.exec(path)) && method === 'POST') {
        return handlePausePage(request, env, Number(m[1]));
      }
      if ((m = /^\/api\/pages\/(\d+)\/preview$/.exec(path)) && method === 'POST') {
        try {
          const preview = await previewNextPostForPage(env, Number(m[1]));
          return jsonResponse(preview);
        } catch (err) {
          return errorResponse(err.message, 400);
        }
      }
      if ((m = /^\/api\/pages\/(\d+)\/post-now$/.exec(path)) && method === 'POST') {
        try {
          const result = await postNowForPage(env, Number(m[1]));
          return jsonResponse(result);
        } catch (err) {
          return errorResponse(err.message, 400);
        }
      }
      if ((m = /^\/api\/pages\/(\d+)\/retry-failed$/.exec(path)) && method === 'POST') {
        return handleRetryFailed(env, Number(m[1]));
      }
      if ((m = /^\/api\/pages\/(\d+)\/blocked-files$/.exec(path)) && method === 'GET') {
        const res = await env.DB.prepare(
          `SELECT id, file_id, file_name, reason, attempts, created_at FROM blocked_files WHERE page_id = ? ORDER BY id DESC`
        )
          .bind(Number(m[1]))
          .all();
        return jsonResponse({ blockedFiles: res.results || [] });
      }
      if ((m = /^\/api\/pages\/(\d+)\/unblock$/.exec(path)) && method === 'POST') {
        return handleUnblockFiles(request, env, Number(m[1]));
      }

      if (path === '/api/events' && method === 'GET') {
        return handleEvents(request, env);
      }

      return errorResponse('API route not found', 404);
    }

    // Friendly fallback if static asset wasn't matched directly
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
