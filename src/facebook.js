const RETRIABLE_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
const NON_RETRIABLE_CODES = new Set([10, 102, 190, 368]);

export function getGraphVersion(env) {
  return env.GRAPH_VERSION || 'v21.0';
}

export async function exchangeUserTokenForLongLived(env, shortToken) {
  if (!env.META_APP_ID || !env.META_APP_SECRET) {
    return { accessToken: shortToken, expiresIn: null };
  }
  const version = getGraphVersion(env);
  const res = await fetch(`https://graph.facebook.com/${version}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: env.META_APP_ID,
      client_secret: env.META_APP_SECRET,
      fb_exchange_token: shortToken,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    const msg = data?.error?.message || `Long-lived token exchange failed (${res.status})`;
    throw new Error(msg);
  }
  return {
    accessToken: data.access_token,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
  };
}

export async function fetchMe(env, userToken) {
  const version = getGraphVersion(env);
  const res = await fetch(`https://graph.facebook.com/${version}/me?fields=id,name`, {
    headers: { Authorization: `Bearer ${userToken}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error || !data.id) {
    const info = classifyFacebookError(res.status, data);
    const err = new Error(info.message);
    err.fbInfo = info;
    throw err;
  }
  return { id: String(data.id), name: data.name || `User ${data.id}` };
}

export async function fetchTokenIdentity(env, token, expectedMode = 'user') {
  const version = getGraphVersion(env);
  if (expectedMode === 'page') {
    const res = await fetch(
      `https://graph.facebook.com/${version}/me?fields=id,name,category,picture.type(large){url}`,
      {
        headers: { Authorization: `Bearer ${token}` },
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error || !data.id) {
      const info = classifyFacebookError(res.status, data);
      if (info.code === 100 && /category/i.test(info.message)) {
        const err = new Error(
          'This looks like a User Access Token, not a Page Access Token. Use "Account Token (All Pages)" mode.'
        );
        err.fbInfo = info;
        throw err;
      }
      const err = new Error(info.message);
      err.fbInfo = info;
      throw err;
    }
    return {
      kind: 'page',
      id: String(data.id),
      name: data.name || `Page ${data.id}`,
      category: data.category || '',
      pictureUrl: data?.picture?.data?.url || '',
    };
  }

  const me = await fetchMe(env, token);
  return { kind: 'user', id: me.id, name: me.name, pictureUrl: '' };
}

export async function fetchUserPages(env, userToken) {
  const version = getGraphVersion(env);
  const pages = [];
  let nextUrl = `https://graph.facebook.com/${version}/me/accounts?fields=id,name,access_token,tasks,picture.type(large){url}&limit=100`;

  for (let i = 0; i < 10 && nextUrl; i++) {
    const res = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) {
      const info = classifyFacebookError(res.status, data);
      if (info.code === 100 && /accounts/i.test(info.message) && /page/i.test(info.message)) {
        const err = new Error(
          'This is a Single Page Access Token, not a User Account Token. Switch to "Single Page Token" mode.'
        );
        err.fbInfo = info;
        throw err;
      }
      const err = new Error(info.message);
      err.fbInfo = info;
      throw err;
    }
    if (Array.isArray(data.data)) {
      for (const p of data.data) {
        if (p.id && p.access_token) {
          pages.push({
            id: String(p.id),
            name: p.name || `Page ${p.id}`,
            access_token: p.access_token,
            tasks: Array.isArray(p.tasks) ? p.tasks : [],
            picture_url: p?.picture?.data?.url || '',
          });
        }
      }
    }
    nextUrl = data.paging?.next || '';
  }

  return pages;
}

export async function postPhotoToPage(env, { fbPageId, pageToken, blob, filename, caption }) {
  const version = getGraphVersion(env);
  const form = new FormData();
  form.append('source', blob, filename);
  if (caption) form.append('caption', caption);
  form.append('published', 'true');
  form.append('access_token', pageToken);

  let res;
  try {
    res = await fetch(`https://graph.facebook.com/${version}/${encodeURIComponent(fbPageId)}/photos`, {
      method: 'POST',
      body: form,
    });
  } catch (networkErr) {
    const err = new Error(`Network error posting photo: ${networkErr.message}`);
    err.fbInfo = classifyFacebookError(0, null, networkErr.message);
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const info = classifyFacebookError(res.status, data);
    const err = new Error(info.message);
    err.fbInfo = info;
    throw err;
  }

  return String(data.post_id || data.id || '');
}

export async function postVideoToPage(env, { fbPageId, pageToken, blob, filename, description }) {
  const version = getGraphVersion(env);
  const form = new FormData();
  form.append('source', blob, filename);
  if (description) form.append('description', description);
  form.append('access_token', pageToken);

  let res;
  try {
    res = await fetch(`https://graph-video.facebook.com/${version}/${encodeURIComponent(fbPageId)}/videos`, {
      method: 'POST',
      body: form,
    });
  } catch (networkErr) {
    const err = new Error(`Network error posting video: ${networkErr.message}`);
    err.fbInfo = classifyFacebookError(0, null, networkErr.message);
    throw err;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const info = classifyFacebookError(res.status, data);
    const err = new Error(info.message);
    err.fbInfo = info;
    throw err;
  }

  return String(data.id || '');
}

export async function fetchRecentPagePosts(env, { fbPageId, pageToken }) {
  const version = getGraphVersion(env);
  const headers = { Authorization: `Bearer ${pageToken}` };

  const [postsRes, videosRes] = await Promise.all([
    fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(fbPageId)}/posts?fields=id,message,created_time&limit=15`,
      { headers }
    ).catch(() => null),
    fetch(
      `https://graph.facebook.com/${version}/${encodeURIComponent(fbPageId)}/videos?fields=id,description,created_time&limit=15`,
      { headers }
    ).catch(() => null),
  ]);

  const items = [];
  if (postsRes && postsRes.ok) {
    const d = await postsRes.json().catch(() => ({}));
    for (const item of d.data || []) {
      items.push({ id: String(item.id), text: (item.message || '').trim(), created_time: item.created_time });
    }
  }
  if (videosRes && videosRes.ok) {
    const d = await videosRes.json().catch(() => ({}));
    for (const item of d.data || []) {
      items.push({ id: String(item.id), text: (item.description || '').trim(), created_time: item.created_time });
    }
  }
  return items;
}

export function classifyFacebookError(httpStatus, payload, fallbackMessage = '') {
  const fbErr = payload?.error || null;
  const code = fbErr && typeof fbErr.code === 'number' ? fbErr.code : null;
  const subcode = fbErr && typeof fbErr.error_subcode === 'number' ? fbErr.error_subcode : null;
  const rawMsg = fbErr?.message || fallbackMessage || `Facebook Graph API HTTP ${httpStatus}`;
  const formattedMsg = code !== null ? `FB #${code}${subcode ? `.${subcode}` : ''}: ${rawMsg}` : rawMsg;

  const isTokenError = code === 190 || code === 102;
  const isPermRange = code !== null && code >= 200 && code <= 299;
  const nonRetriable = (code !== null && NON_RETRIABLE_CODES.has(code)) || isPermRange;

  const retriable =
    !nonRetriable &&
    (httpStatus === 0 ||
      httpStatus >= 500 ||
      httpStatus === 429 ||
      (code !== null && RETRIABLE_CODES.has(code)));

  return {
    code,
    subcode,
    message: formattedMsg,
    retriable,
    nonRetriable,
    isTokenError,
  };
}
