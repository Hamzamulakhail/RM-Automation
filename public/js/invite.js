import { apiFetch, esc, safeStorageGet, safeStorageSet } from './api.js';
import { translate } from './i18n.js';
import { getAvatarGradient, getInitials, icons } from './icons.js';

const rootEl = document.getElementById('invite-app');
const initialValid = rootEl?.dataset?.valid === '1';
const rawToken = rootEl?.dataset?.token || '';
const initialStep = rootEl?.dataset?.step || 'intro';
const initialErr = rootEl?.dataset?.err || '';
const inviteLabel = rootEl?.dataset?.label || '';

function resolveInitialTheme() {
  const saved = safeStorageGet('pp_theme');
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  return 'dark';
}

const state = {
  lang: safeStorageGet('pp_lang') === 'en' ? 'en' : 'ps',
  theme: resolveInitialTheme(),
  accent: safeStorageGet('pp_accent') || 'aurora',
  valid: initialValid,
  step: initialStep, // intro | select | done
  err: initialErr,
  consentChecked: false,
  loadingPages: false,
  submitting: false,
  fbUserName: '',
  pages: [],
  selected: new Set(),
  formError: '',
};

const t = (k) => translate(state.lang, k);

function isEffectiveDark() {
  if (state.theme === 'dark') return true;
  if (state.theme === 'light') return false;
  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

function applyPreferences() {
  const root = document.documentElement;
  root.lang = state.lang;
  root.dir = state.lang === 'ps' ? 'rtl' : 'ltr';
  root.dataset.theme = state.theme;
  root.dataset.accent = state.accent;
  document.title = `${t('appName')} — ${t('invitePageTitle')}`;
}

function getErrText(errCode) {
  if (!errCode) return '';
  if (errCode === 'dev_mode') return t('inviteDevModeErr');
  if (errCode === 'rate_limit') return t('inviteRateLimitErr');
  if (errCode === 'oauth_failed' || errCode === 'oauth_config') return t('inviteOauthErr');
  return t('inviteInvalidTitle');
}

async function loadSelectablePages() {
  state.loadingPages = true;
  state.formError = '';
  render();
  try {
    const res = await apiFetch('/api/invite/pages');
    state.fbUserName = res.fbUserName || '';
    state.pages = res.pages || [];
    state.selected = new Set(state.pages.map((p) => p.fb_page_id));
  } catch (err) {
    state.formError = err.message;
  } finally {
    state.loadingPages = false;
    render();
  }
}

function renderStepProgress() {
  if (!state.valid || state.err === 'invalid' || state.err === 'rate_limit') return '';
  const step1Done = true;
  const step2Done = state.step === 'select' || state.step === 'done';
  const step3Done = state.step === 'done';
  return `
    <div class="lifecycle" style="justify-content:center">
      <span class="life-step ${step1Done ? 'done' : ''}"><span class="life-dot"></span><span>${esc(t('inviteStepCreated'))}</span></span>
      <span class="life-line ${step2Done ? 'done' : ''}"></span>
      <span class="life-step ${step2Done ? 'done' : ''}"><span class="life-dot"></span><span>${esc(t('inviteStepOpened'))}</span></span>
      <span class="life-line ${step3Done ? 'done' : ''}"></span>
      <span class="life-step ${step3Done ? 'done' : ''}"><span class="life-dot"></span><span>${esc(t('inviteStepConnected'))}</span></span>
    </div>
  `;
}

function render() {
  applyPreferences();
  const headerHtml = `
    <div class="row">
      <div class="brand">
        <div class="brand-mark">RM</div>
        <div>
          <div class="brand-title">${esc(t('appName'))}</div>
          <div class="muted small-text">${esc(t('invitePageTitle'))}</div>
        </div>
      </div>
      <div class="row-start">
        <button id="invThemeBtn" class="btn btn-sm btn-icon" aria-label="${esc(isEffectiveDark() ? t('themeLight') : t('themeDark'))}">
          ${isEffectiveDark() ? icons.sun() : icons.moon()}
        </button>
        <button id="invLangBtn" class="btn btn-sm">${icons.globe()}<span>${esc(t('langToggle'))}</span></button>
      </div>
    </div>
  `;

  let bodyHtml = '';

  if (!state.valid || state.err === 'invalid' || state.err === 'rate_limit') {
    const msg = state.err === 'rate_limit' ? t('inviteRateLimitErr') : t('inviteInvalidTitle');
    bodyHtml = `
      <div class="stack">
        <div class="inline-alert inline-alert-danger">${icons.xCircle()}<strong>${esc(msg)}</strong></div>
        <p class="muted small-text" style="margin:0">${esc(t('inviteInvalidDesc'))}</p>
      </div>
    `;
  } else if (state.step === 'done') {
    bodyHtml = `
      <div class="stack">
        <div class="inline-alert inline-alert-success">${icons.checkCircle()}<strong>${esc(t('inviteDoneTitle'))}</strong></div>
        <p class="muted small-text" style="margin:0">${esc(t('inviteDoneDesc'))}</p>
      </div>
    `;
  } else if (state.step === 'select') {
    bodyHtml = `
      <div class="stack">
        <h2 class="section-title">${esc(t('inviteSelectTitle'))}</h2>
        ${state.fbUserName ? `<div class="muted small-text">${esc(t('inviteConnectedAs'))}: <strong>${esc(state.fbUserName)}</strong></div>` : ''}
        ${
          state.loadingPages
            ? `<div class="skeleton-line w-100" style="height:96px"></div>`
            : state.formError
              ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(state.formError)}</span></div>`
              : state.pages.length === 0
                ? `<div class="inline-alert inline-alert-warn">${icons.alertTriangle()}<span>${esc(t('inviteNoPagesFound'))}</span></div>`
                : `
              <p class="muted small-text" style="margin:0">${esc(t('inviteSelectHint'))}</p>
              <div class="stack-sm">
                ${state.pages
                  .map(
                    (p) => `
                  <label class="checkbox-row">
                    <input type="checkbox" class="inv-page-cb" value="${esc(p.fb_page_id)}" ${state.selected.has(p.fb_page_id) ? 'checked' : ''} />
                    <span class="avatar-circle" style="width:28px;height:28px;font-size:11px;background:${getAvatarGradient(p.name)}">${esc(getInitials(p.name))}</span>
                    <span style="flex:1"><strong>${esc(p.name)}</strong> <span class="muted small-text ltr">(${esc(p.fb_page_id)})</span></span>
                  </label>`
                  )
                  .join('')}
              </div>
              <button id="invConfirmBtn" class="btn btn-primary" ${state.submitting ? 'disabled' : ''}>
                ${state.submitting ? icons.spinner() : icons.checkCircle()}
                <span>${esc(t('inviteConfirmBtn'))}</span>
              </button>`
        }
      </div>
    `;
  } else {
    const errText = getErrText(state.err);
    bodyHtml = `
      <div class="stack">
        ${inviteLabel ? `<div class="muted small-text">${esc(t('inviteForLabel'))}: <strong>${esc(inviteLabel)}</strong></div>` : ''}
        ${errText ? `<div class="inline-alert inline-alert-danger">${icons.alertTriangle()}<span>${esc(errText)}</span></div>` : ''}

        <div class="subcard stack-sm">
          <div class="row-start">${icons.shield()}<strong>${esc(t('inviteNoticeTitle'))}</strong></div>
          <ul class="clean-list small-text">
            <li>${esc(t('inviteBullet1'))}</li>
            <li>${esc(t('inviteBullet2'))}</li>
            <li>${esc(t('inviteBullet3'))}</li>
          </ul>
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer" class="small-text">${esc(t('invitePrivacyLink'))}</a>
        </div>

        <label class="checkbox-row">
          <input id="invConsentCb" type="checkbox" ${state.consentChecked ? 'checked' : ''} />
          <span class="small-text">${esc(t('inviteConsentLabel'))}</span>
        </label>

        <button id="invContinueBtn" class="btn btn-primary" ${state.consentChecked ? '' : 'disabled'}>
          ${icons.link()}
          <span>${esc(t('inviteContinueFb'))}</span>
        </button>
      </div>
    `;
  }

  rootEl.innerHTML = `
    <main class="login-wrap">
      <div class="card invite-card stack">
        ${headerHtml}
        ${renderStepProgress()}
        <div class="divider"></div>
        ${bodyHtml}
      </div>
    </main>
  `;

  document.getElementById('invLangBtn')?.addEventListener('click', () => {
    state.lang = state.lang === 'ps' ? 'en' : 'ps';
    safeStorageSet('pp_lang', state.lang);
    render();
  });

  document.getElementById('invThemeBtn')?.addEventListener('click', () => {
    state.theme = isEffectiveDark() ? 'light' : 'dark';
    safeStorageSet('pp_theme', state.theme);
    render();
  });

  document.getElementById('invConsentCb')?.addEventListener('change', (e) => {
    state.consentChecked = e.target.checked;
    const btn = document.getElementById('invContinueBtn');
    if (btn) btn.disabled = !state.consentChecked;
  });

  document.getElementById('invContinueBtn')?.addEventListener('click', () => {
    if (!state.consentChecked) return;
    window.location.href = `/auth/facebook/start?invite=${encodeURIComponent(rawToken)}`;
  });

  document.querySelectorAll('.inv-page-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (cb.checked) state.selected.add(cb.value);
      else state.selected.delete(cb.value);
    });
  });

  document.getElementById('invConfirmBtn')?.addEventListener('click', async () => {
    const fbPageIds = Array.from(state.selected);
    if (fbPageIds.length === 0) {
      state.formError = t('invitePickOneError');
      render();
      return;
    }
    state.submitting = true;
    state.formError = '';
    render();
    try {
      await apiFetch('/api/invite/confirm', { method: 'POST', body: JSON.stringify({ fbPageIds }) });
      state.step = 'done';
    } catch (err) {
      state.formError = err.message;
    } finally {
      state.submitting = false;
      render();
    }
  });
}

applyPreferences();
if (state.valid && state.step === 'select') {
  loadSelectablePages();
} else {
  render();
}
