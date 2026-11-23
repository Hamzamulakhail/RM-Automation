import {
  apiFetch,
  buildScheduleSummary,
  esc,
  formatTime12h,
  runCountUps,
  safeStorageGet,
  safeStorageSet,
  to24hHHMM,
} from './js/api.js';
import {
  renderAccountsView,
  renderAvatar,
  renderCommandPalette,
  renderConfirmModal,
  renderDashboardPagesTable,
  renderHeroToday,
  renderLicensesView,
  renderLogsView,
  renderPageDrawer,
  renderPagesDirectory,
  renderPickPagesModal,
  renderPostsView,
  renderQuickActionsSheet,
  renderSettingsView,
  renderSkeletonGrid,
  renderStatusBadge,
  renderSummaryTiles,
} from './js/components.js';
import { translate } from './js/i18n.js';
import { icons, illustrations } from './js/icons.js';

function resolveInitialTheme() {
  const saved = safeStorageGet('pp_theme');
  if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  return 'dark';
}

function resolveInitialAccent() {
  const saved = safeStorageGet('pp_accent');
  return ['aurora', 'violet', 'emerald', 'amber', 'rose'].includes(saved) ? saved : 'aurora';
}

const state = {
  lang: safeStorageGet('pp_lang') === 'en' ? 'en' : 'ps',
  theme: resolveInitialTheme(),
  accent: resolveInitialAccent(),
  density: safeStorageGet('pp_density') === 'compact' ? 'compact' : 'comfortable',
  sidebarCollapsed: safeStorageGet('pp_sidebar') === '1',
  authenticated: false,
  role: null,
  workspaceLabel: '',
  maxPages: null,
  checkingAuth: true,
  initialLoading: false,
  tab: 'dashboard', // dashboard | posts | accounts | pages | licenses | logs | settings
  dashboard: { globalPause: false, ownerGlobalPause: false, pages: [], accounts: [], sparklines: null, needsAttentionCount: 0 },
  posts: [],
  postFilters: { status: '', pageId: '' },
  accounts: [],
  licenses: [],
  createdLicenseKey: '',
  licenseKeyCopied: false,
  tokenMode: 'user',
  events: [],
  eventFilters: { pageId: '', level: '', date: '' },
  dashFilters: { search: '', accountId: '', status: '', sort: 'next' },
  dashPageNum: 1,
  pagesPageNum: 1,
  postsPageNum: 1,
  pagesSearch: '',
  activeSlotPopover: null,
  driveInfo: null,
  driveFolders: null,
  drawer: null,
  modal: null,
  confirm: null,
  quickSheetOpen: false,
  palette: { open: false, query: '' },
  busy: new Set(),
  toast: '',
  loginError: '',
  loginShowKey: false,
  manualTokenError: '',
  fbOAuthBanner: '',
  googleBanner: '',
  googleError: '',
};

let toastTimer = null;
let copiedTimer = null;

function t(key, vars = null) {
  return translate(state.lang, key, vars);
}

function applyPreferences() {
  const root = document.documentElement;
  root.lang = state.lang;
  root.dir = state.lang === 'ps' ? 'rtl' : 'ltr';
  root.dataset.theme = state.theme;
  root.dataset.accent = state.accent;
  root.dataset.density = state.density;

  const titleMap = {
    dashboard: 'navDashboard',
    posts: 'navPosts',
    accounts: 'navAccounts',
    pages: 'navPages',
    licenses: 'navLicenses',
    logs: 'navLogs',
    settings: 'navSettings',
  };
  document.title = state.authenticated
    ? `${t('appName')} — ${t(titleMap[state.tab] || 'navDashboard')}`
    : t('appName');
}

function isEffectiveDark() {
  if (state.theme === 'dark') return true;
  if (state.theme === 'light') return false;
  return Boolean(window.matchMedia?.('(prefers-color-scheme: dark)').matches);
}

function withViewTransition(fn) {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reduced && typeof document.startViewTransition === 'function') {
    document.startViewTransition(() => fn());
  } else {
    fn();
  }
}

function showToast(msg) {
  state.toast = msg;
  render();
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = '';
    render();
  }, 3400);
}

const api = (path, options = {}) =>
  apiFetch(path, options, () => {
    state.authenticated = false;
    state.role = null;
    state.drawer = null;
    state.modal = null;
    state.confirm = null;
    state.quickSheetOpen = false;
    state.palette.open = false;
    render();
  });

async function loadPosts() {
  const res = await api('/api/posts?limit=150');
  state.posts = res.posts || [];
}

async function loadAllData() {
  const requests = [api('/api/dashboard'), api('/api/accounts'), api('/api/drive/info')];
  if (state.role === 'admin') {
    requests.push(api('/api/licenses'));
  }
  const [dash, accs, driveInfo, lics] = await Promise.all(requests);
  state.dashboard = dash;
  state.accounts = accs.accounts || [];
  state.driveInfo = driveInfo;
  if (state.role === 'admin') {
    state.licenses = lics?.licenses || [];
  } else {
    state.licenses = [];
    if (state.tab === 'licenses') state.tab = 'dashboard';
  }
  if (state.tab === 'posts') {
    await loadPosts();
  } else if (state.tab === 'logs') {
    await loadEvents();
  }
}

async function loadEvents() {
  const params = new URLSearchParams();
  if (state.eventFilters.pageId) params.set('pageId', state.eventFilters.pageId);
  if (state.eventFilters.level) params.set('level', state.eventFilters.level);
  if (state.eventFilters.date) params.set('date', state.eventFilters.date);
  const res = await api(`/api/events?${params.toString()}`);
  state.events = res.events || [];
}

async function openPickPagesModal(accountId) {
  state.modal = { type: 'pickPages', accountId, loading: true, pages: [], error: '' };
  render();
  try {
    const res = await api(`/api/accounts/${accountId}/fb-pages`);
    state.modal = {
      type: 'pickPages',
      accountId,
      loading: false,
      pages: res.pages || [],
      selected: new Set((res.pages || []).filter((p) => !p.alreadyAdded).map((p) => p.fb_page_id)),
      error: '',
    };
  } catch (err) {
    state.modal = { type: 'pickPages', accountId, loading: false, pages: [], error: err.message };
  }
  render();
}

async function openDrawer(pageId, tab = 'schedule') {
  state.palette.open = false;
  state.drawer = {
    pageId,
    tab,
    loading: true,
    page: null,
    slots: [],
    newSlotHour: 8,
    newSlotMinute: 0,
    newSlotPeriod: 'PM',
    customCap: false,
    advOpen: false,
    blockedFiles: [],
    recentPlans: [],
    recentEvents: [],
    preview: null,
    previewLoading: false,
    previewError: '',
    driveFoldersLoading: false,
    driveError: '',
    formError: '',
    slotError: '',
  };
  render();
  try {
    const [pageRes, driveInfo] = await Promise.all([
      api(`/api/pages/${pageId}`),
      state.driveInfo ? Promise.resolve(state.driveInfo) : api('/api/drive/info'),
    ]);
    state.driveInfo = driveInfo;
    if (!state.drawer || state.drawer.pageId !== pageId) return;
    const loadedSlots = [...(pageRes.page.slots || [])];
    const hasCustomCap =
      loadedSlots.length > 0 && Number(pageRes.page.daily_cap) > 0 && Number(pageRes.page.daily_cap) < loadedSlots.length;
    state.drawer.loading = false;
    state.drawer.page = pageRes.page;
    state.drawer.slots = loadedSlots;
    state.drawer.customCap = hasCustomCap;
    state.drawer.blockedFiles = pageRes.blockedFiles || [];
    state.drawer.recentPlans = pageRes.recentPlans || [];
    state.drawer.recentEvents = pageRes.recentEvents || [];
    render();

    if (tab === 'drive' && driveInfo.configured && !state.driveFolders) {
      loadDriveFoldersIntoDrawer();
    } else if (tab === 'preview') {
      loadDrawerPreview();
    }
  } catch (err) {
    state.drawer = null;
    showToast(err.message);
    render();
  }
}

async function loadDriveFoldersIntoDrawer() {
  if (!state.drawer) return;
  syncDrawerFormInputs();
  state.drawer.driveFoldersLoading = true;
  state.drawer.driveError = '';
  render();
  try {
    const res = await api('/api/drive/folders');
    state.driveFolders = res.folders || [];
  } catch (err) {
    if (state.drawer) state.drawer.driveError = err.message;
  } finally {
    if (state.drawer) {
      state.drawer.driveFoldersLoading = false;
      render();
    }
  }
}

async function loadDrawerPreview() {
  if (!state.drawer) return;
  const pageId = state.drawer.pageId;
  state.drawer.previewLoading = true;
  state.drawer.previewError = '';
  render();
  try {
    const pv = await api(`/api/pages/${pageId}/preview`, { method: 'POST', body: '{}' });
    if (state.drawer && state.drawer.pageId === pageId) {
      state.drawer.preview = pv;
      state.drawer.blockedFiles = pv.blockedFiles || state.drawer.blockedFiles;
    }
  } catch (err) {
    if (state.drawer && state.drawer.pageId === pageId) {
      state.drawer.previewError = err.message;
    }
  } finally {
    if (state.drawer && state.drawer.pageId === pageId) {
      state.drawer.previewLoading = false;
      render();
    }
  }
}

function syncDrawerFormInputs() {
  if (!state.drawer || !state.drawer.page) return;
  const p = state.drawer.page;
  const nameEl = document.getElementById('editPageName');
  if (nameEl) {
    p.name = nameEl.value;
    p.status = document.getElementById('editPageStatus')?.value || p.status;
    const tzSel = document.getElementById('editTzSelect');
    p.timezone =
      tzSel?.value === '__custom__'
        ? document.getElementById('editTzCustom')?.value ?? p.timezone
        : tzSel?.value ?? p.timezone;
    p.jitter_minutes = Number(document.getElementById('editJitter')?.value ?? p.jitter_minutes);
    p.daily_cap = Number(document.getElementById('editDailyCap')?.value ?? p.daily_cap);
    p.min_gap_minutes = Number(document.getElementById('editMinGap')?.value ?? p.min_gap_minutes);
    p.ramp_up_enabled = Boolean(document.getElementById('editRampEnabled')?.checked);
    p.ramp_start = Number(document.getElementById('editRampStart')?.value ?? p.ramp_start);
    p.ramp_step_days = Number(document.getElementById('editRampStep')?.value ?? p.ramp_step_days);
  }
  const hrEl = document.getElementById('newSlotHour');
  const minEl = document.getElementById('newSlotMinute');
  if (hrEl) state.drawer.newSlotHour = Number(hrEl.value);
  if (minEl) state.drawer.newSlotMinute = Number(minEl.value);

  const capSel = document.getElementById('editCaptionsFolder');
  const medSel = document.getElementById('editMediaFolder');
  if (capSel) {
    p.captions_folder_id = capSel.value;
    p.captions_folder_name = capSel.selectedOptions?.[0]?.dataset?.name || p.captions_folder_name;
  }
  if (medSel) {
    p.media_folder_id = medSel.value;
    p.media_folder_name = medSel.selectedOptions?.[0]?.dataset?.name || p.media_folder_name;
  }
}

function updateLiveScheduleSummaryInDom() {
  if (!state.drawer?.page) return;
  syncDrawerFormInputs();
  const p = state.drawer.page;
  const summaryEl = document.getElementById('scheduleLiveSummary')?.querySelector('span');
  if (summaryEl) {
    const cap = state.drawer.customCap ? p.daily_cap : Math.max(1, state.drawer.slots.length || 1);
    summaryEl.textContent = buildScheduleSummary(
      {
        slots: state.drawer.slots,
        jitter: p.jitter_minutes,
        dailyCap: cap,
        minGap: p.min_gap_minutes,
        rampEnabled: p.ramp_up_enabled,
        rampStart: p.ramp_start,
      },
      state.lang
    );
  }
}

function isValidIanaTimezone(tz) {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function renderLogin() {
  return `
    <main class="login-wrap">
      <div class="login-backdrop" aria-hidden="true">
        <div class="login-grid-bg"></div>
        <div class="login-aurora-orb login-orb-1"></div>
        <div class="login-aurora-orb login-orb-2"></div>
        <div class="login-aurora-orb login-orb-3"></div>
      </div>

      <div class="login-top-controls">
        <button type="button" class="btn btn-sm btn-icon glass-pill-btn" id="themeToggleBtn" aria-label="${esc(isEffectiveDark() ? t('themeLight') : t('themeDark'))}">
          ${isEffectiveDark() ? icons.sun() : icons.moon()}
        </button>
        <button type="button" class="btn btn-sm glass-pill-btn" id="langToggleBtn">
          ${icons.globe()}<span>${esc(t('langToggle'))}</span>
        </button>
      </div>

      <div class="login-card stack">
        <div class="login-brand-row">
          <div class="brand-mark login-brand-mark">RM</div>
          <div>
            <div class="brand-title">${esc(t('appName'))}</div>
            <div class="muted small-text">${esc(t('appSubtitle'))}</div>
          </div>
        </div>

        <div class="divider"></div>

        <div>
          <h1 class="login-heading">${esc(t('loginTitle'))}</h1>
          <p class="muted small-text" style="margin:4px 0 0">${esc(t('loginHint'))}</p>
        </div>

        ${state.loginError ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(state.loginError)}</span></div>` : ''}

        <form id="loginForm" class="stack" novalidate>
          <div class="field">
            <label for="loginPassword">${esc(t('passwordLabel'))}</label>
            <div class="key-input-wrap">
              <span class="key-input-icon">${icons.key()}</span>
              <input
                id="loginPassword"
                type="${state.loginShowKey ? 'text' : 'password'}"
                class="input ltr key-input-field"
                placeholder="${esc(t('passwordPlaceholder'))}"
                required
                autocomplete="current-password"
              />
              <button
                type="button"
                id="toggleLoginKeyVis"
                class="key-vis-btn"
                aria-label="Toggle visibility"
              >
                ${state.loginShowKey ? icons.eyeOff() : icons.eye()}
              </button>
            </div>
          </div>
          <button type="submit" class="btn btn-primary login-submit-btn" ${state.busy.has('login') ? 'disabled' : ''}>
            ${state.busy.has('login') ? icons.spinner() : icons.zap()}
            <span>${esc(t('loginBtn'))}</span>
          </button>
        </form>
      </div>
    </main>
  `;
}

function getFilteredPages() {
  const pages = [...(state.dashboard.pages || [])];
  const q = state.dashFilters.search.trim().toLowerCase();
  const accId = state.dashFilters.accountId;
  const st = state.dashFilters.status;

  const filtered = pages.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q) && !String(p.fb_page_id).includes(q)) return false;
    if (accId && String(p.account_id) !== accId) return false;
    if (st && p.status !== st) return false;
    return true;
  });

  const sortBy = state.dashFilters.sort || 'next';
  filtered.sort((a, b) => {
    if (sortBy === 'name') return a.name.localeCompare(b.name);
    if (sortBy === 'status') {
      const rank = { needs_attention: 0, active: 1, paused: 2 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    }
    if (sortBy === 'posted') {
      const pa = (a.today_slots || []).filter((s) => s.status === 'posted').length;
      const pb = (b.today_slots || []).filter((s) => s.status === 'posted').length;
      return pb - pa;
    }
    const na = a.next_planned?.planned_utc ? Date.parse(a.next_planned.planned_utc) : Number.MAX_SAFE_INTEGER;
    const nb = b.next_planned?.planned_utc ? Date.parse(b.next_planned.planned_utc) : Number.MAX_SAFE_INTEGER;
    return na - nb;
  });

  return filtered;
}

function renderDashboard() {
  const { globalPause, ownerGlobalPause, pages, accounts, sparklines } = state.dashboard;
  const attentionPages = pages.filter(
    (p) => p.status === 'needs_attention' || p.account_status === 'needs_attention'
  );
  const filteredPages = getFilteredPages();
  const pageSize = 15;
  const totalPages = Math.max(1, Math.ceil(filteredPages.length / pageSize));
  const curPage = Math.max(1, Math.min(state.dashPageNum || 1, totalPages));
  const pageSlice = filteredPages.slice((curPage - 1) * pageSize, curPage * pageSize);

  return `
    <div class="stack">
      ${
        ownerGlobalPause
          ? `<div class="inline-alert inline-alert-warn">${icons.alertTriangle()}<strong>${esc(t('ownerPauseNoticeBanner'))}</strong></div>`
          : ''
      }
      ${
        globalPause
          ? `<div class="inline-alert inline-alert-danger">${icons.pause()}<strong>${esc(t('globalPauseActiveBanner'))}</strong></div>`
          : ''
      }

      ${renderHeroToday(pages, globalPause, state.lang, state.busy)}
      ${renderSummaryTiles(pages, sparklines, state.lang)}

      ${
        attentionPages.length > 0
          ? `<section class="attention-panel stack-sm" aria-label="${esc(t('needsAttentionTitle'))}">
              <div class="row">
                <div class="row-start">
                  ${icons.alertTriangle()}
                  <strong>${esc(t('needsAttentionTitle'))} (${attentionPages.length})</strong>
                </div>
                <span class="muted small-text">${esc(t('needsAttentionDesc'))}</span>
              </div>
              <div class="flat-list">
                ${attentionPages
                  .slice(0, 5)
                  .map(
                    (p) => `
                  <div class="flat-row">
                    <div class="min-w-0">
                      <strong>${esc(p.name)}</strong>
                      <div class="small-text muted">${esc(p.last_error || p.account_status)}</div>
                    </div>
                    <button class="btn btn-sm" data-action="open-drawer" data-id="${p.id}" data-drawer-tab="history">${esc(t('detailsBtn'))}</button>
                  </div>`
                  )
                  .join('')}
              </div>
            </section>`
          : ''
      }

      ${
        pages.length === 0
          ? `<div class="card empty-state">
              ${illustrations.noPages()}
              <h3>${esc(t('noPagesYet'))}</h3>
              <p class="muted" style="max-width:440px;margin:0">${esc(t('noPagesHint'))}</p>
              <button class="btn btn-primary" id="emptyGoAccountsBtn">${icons.accounts()}<span>${esc(t('goToAccountsCta'))}</span></button>
            </div>`
          : `
        <div class="card filter-toolbar">
          <div class="filter-controls-row">
            <div class="search-wrap">
              ${icons.search()}
              <input id="dashSearchInput" class="input" type="search" placeholder="${esc(t('searchPagesPlaceholder'))}" value="${esc(state.dashFilters.search)}" />
            </div>
            <select id="dashFilterAccount" class="select" aria-label="${esc(t('accountLabel'))}">
              <option value="">${esc(t('filterAllAccounts'))}</option>
              ${accounts.map((a) => `<option value="${a.id}" ${state.dashFilters.accountId === String(a.id) ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}
            </select>
            <select id="dashSortSelect" class="select" aria-label="${esc(t('sortLabel'))}">
              <option value="next" ${state.dashFilters.sort === 'next' ? 'selected' : ''}>${esc(t('sortLabel'))}: ${esc(t('sortNext'))}</option>
              <option value="name" ${state.dashFilters.sort === 'name' ? 'selected' : ''}>${esc(t('sortLabel'))}: ${esc(t('sortName'))}</option>
              <option value="status" ${state.dashFilters.sort === 'status' ? 'selected' : ''}>${esc(t('sortLabel'))}: ${esc(t('sortStatus'))}</option>
              <option value="posted" ${state.dashFilters.sort === 'posted' ? 'selected' : ''}>${esc(t('sortLabel'))}: ${esc(t('sortPosted'))}</option>
            </select>
          </div>
          <div class="chip-row" role="group" aria-label="${esc(t('pageStatusLabel'))}">
            ${[
              { v: '', lbl: t('filterAllStatuses') },
              { v: 'active', lbl: t('status_active') },
              { v: 'paused', lbl: t('status_paused') },
              { v: 'needs_attention', lbl: t('status_needs_attention') },
            ]
              .map(
                (chip) => `
              <button type="button" class="filter-chip ${state.dashFilters.status === chip.v ? 'active' : ''}" data-action="set-status-chip" data-val="${chip.v}">
                ${esc(chip.lbl)}
              </button>`
              )
              .join('')}
          </div>
        </div>

        ${
          filteredPages.length === 0
            ? `<div class="card empty-state">
                ${illustrations.noSearch()}
                <p class="muted">${esc(t('noFilterMatches'))}</p>
                <button class="btn btn-sm" id="clearDashFiltersBtn">${esc(t('clearFiltersBtn'))}</button>
              </div>`
            : renderDashboardPagesTable(pageSlice, filteredPages.length, curPage, pageSize, state.lang, state.busy)
        }
      `
      }
    </div>
  `;
}

function renderPagesTab() {
  const { pages } = state.dashboard;
  const q = (state.pagesSearch || '').trim().toLowerCase();
  const filtered = q
    ? pages.filter((p) => p.name.toLowerCase().includes(q) || String(p.fb_page_id).includes(q))
    : pages;
  const pageSize = 20;
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const curPage = Math.max(1, Math.min(state.pagesPageNum || 1, totalPages));
  const slice = filtered.slice((curPage - 1) * pageSize, curPage * pageSize);

  return `
    <div class="stack">
      <div class="card row">
        <div class="row-start" style="flex:1;min-width:220px">
          <h2 class="section-title">${esc(t('navPages'))} <span class="muted tabular">(${pages.length})</span></h2>
          ${
            pages.length > 0
              ? `<div class="search-wrap" style="max-width:280px;flex:1">
                  ${icons.search()}
                  <input id="pagesSearchInput" class="input" type="search" placeholder="${esc(t('searchPagesPlaceholder'))}" value="${esc(state.pagesSearch)}" />
                </div>`
              : ''
          }
        </div>
        <button class="btn btn-sm btn-primary" id="pagesGoAccountsBtn">${icons.plus()}<span>${esc(t('addPageAction'))}</span></button>
      </div>
      ${
        pages.length === 0
          ? `<div class="card empty-state">
              ${illustrations.noPages()}
              <h3>${esc(t('noPagesYet'))}</h3>
              <p class="muted">${esc(t('noPagesHint'))}</p>
              <button class="btn btn-primary" id="emptyGoAccountsBtn">${esc(t('goToAccountsCta'))}</button>
            </div>`
          : filtered.length === 0
            ? `<div class="card empty-state">
                ${illustrations.noSearch()}
                <p class="muted">${esc(t('noFilterMatches'))}</p>
              </div>`
            : renderPagesDirectory(slice, filtered.length, curPage, pageSize, state.lang)
      }
    </div>
  `;
}

function render() {
  applyPreferences();
  const root = document.getElementById('app');

  if (state.checkingAuth) {
    root.innerHTML = `<main class="content-area">${renderSkeletonGrid(2)}</main>`;
    return;
  }

  if (!state.authenticated) {
    root.innerHTML = renderLogin();
    bindEvents();
    return;
  }

  const isAdmin = state.role === 'admin';
  const navItems = [
    { id: 'dashboard', label: t('navDashboard'), icon: icons.dashboard() },
    { id: 'posts', label: t('navPosts'), icon: icons.posts() },
    { id: 'accounts', label: t('navAccounts'), icon: icons.accounts() },
    { id: 'pages', label: t('navPages'), icon: icons.pages() },
    ...(isAdmin ? [{ id: 'licenses', label: t('navLicenses'), icon: icons.key() }] : []),
    { id: 'logs', label: t('navLogs'), icon: icons.logs() },
  ];

  let mainContent = '';
  if (state.initialLoading) {
    mainContent = renderSkeletonGrid(4);
  } else if (state.tab === 'dashboard') {
    mainContent = renderDashboard();
  } else if (state.tab === 'posts') {
    mainContent = renderPostsView(state, state.lang, state.busy);
  } else if (state.tab === 'accounts') {
    mainContent = renderAccountsView(state, state.lang, state.busy);
  } else if (state.tab === 'pages') {
    mainContent = renderPagesTab();
  } else if (state.tab === 'licenses' && isAdmin) {
    mainContent = renderLicensesView(state, state.lang, state.busy);
  } else if (state.tab === 'logs') {
    mainContent = renderLogsView(state, state.lang);
  } else if (state.tab === 'settings') {
    mainContent = renderSettingsView(state, state.lang);
  }

  const globalPaused = state.dashboard.globalPause;
  const activeHeading =
    state.tab === 'settings'
      ? t('navSettings')
      : navItems.find((n) => n.id === state.tab)?.label || t('appName');
  const workspaceBadgeText = isAdmin
    ? t('workspaceAdmin')
    : `${state.workspaceLabel || t('workspaceLicense')}${state.maxPages ? ` · ${t('workspaceMaxPages', { max: state.maxPages })}` : ''}`;

  root.innerHTML = `
    <div class="app-shell">
      <aside class="sidebar ${state.sidebarCollapsed ? 'collapsed' : ''}" aria-label="Main navigation">
        <div class="sidebar-head">
          <div class="brand">
            <div class="brand-mark">RM</div>
            <div class="brand-text">
              <div class="brand-title">${esc(t('appName'))}</div>
            </div>
          </div>
          <button type="button" class="btn btn-icon btn-ghost" id="sidebarCollapseBtn" aria-label="${esc(state.sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar'))}" title="${esc(state.sidebarCollapsed ? t('expandSidebar') : t('collapseSidebar'))}">
            ${icons.panelToggle()}
          </button>
        </div>

        <nav class="sidebar-nav">
          ${navItems
            .map(
              (n) => `
            <button class="nav-item ${state.tab === n.id ? 'active' : ''}" data-tab="${n.id}" aria-current="${state.tab === n.id ? 'page' : 'false'}" title="${esc(n.label)}">
              ${n.icon}<span class="sidebar-label">${esc(n.label)}</span>
            </button>`
            )
            .join('')}
        </nav>

        <div class="sidebar-footer">
          <div class="sidebar-workspace-meta">${esc(workspaceBadgeText)}</div>
          <button class="nav-item ${state.tab === 'settings' ? 'active' : ''}" data-tab="settings" aria-current="${state.tab === 'settings' ? 'page' : 'false'}" title="${esc(t('navSettings'))}">
            ${icons.settings()}<span class="sidebar-label">${esc(t('navSettings'))}</span>
          </button>
        </div>
      </aside>

      <div class="app-main">
        <header class="topbar">
          <div class="topbar-inner">
            <div class="topbar-left">
              <div class="brand topbar-brand-mobile">
                <div class="brand-mark">RM</div>
                <div class="brand-title">${esc(t('appName'))}</div>
              </div>
              <div class="topbar-title-desktop">
                <h1 class="page-heading">${esc(activeHeading)}</h1>
              </div>
            </div>

            <div class="topbar-actions">
              <button type="button" id="cmdPaletteBtn" class="cmd-trigger" aria-label="${esc(t('cmdButtonLabel'))}">
                ${icons.search()}
                <span>${esc(t('cmdButtonLabel'))}</span>
                <span class="kbd ltr">⌘K</span>
              </button>
              <button type="button" id="mobileSearchBtn" class="btn btn-sm btn-ghost btn-icon mobile-search-btn" aria-label="${esc(t('cmdButtonLabel'))}">
                ${icons.search()}
              </button>
              <button
                id="globalPauseBtn"
                class="btn btn-sm ${globalPaused ? 'btn-danger' : 'btn-kill-idle'}"
                aria-pressed="${globalPaused ? 'true' : 'false'}"
              >
                ${globalPaused ? icons.play() : icons.pause()}
                <span class="hide-sm">${esc(globalPaused ? t('resumeAllBtn') : t('pauseAllBtn'))}</span>
              </button>
              <button id="refreshBtn" class="btn btn-sm btn-ghost btn-icon" aria-label="${esc(t('refreshBtn'))}" title="${esc(t('refreshBtn'))}">
                ${state.busy.has('refresh') ? icons.spinner() : icons.refresh()}
              </button>
              <button id="themeToggleBtn" class="btn btn-sm btn-ghost btn-icon" aria-label="${esc(isEffectiveDark() ? t('themeLight') : t('themeDark'))}" title="${esc(isEffectiveDark() ? t('themeLight') : t('themeDark'))}">
                ${isEffectiveDark() ? icons.sun() : icons.moon()}
              </button>
              <button id="langToggleBtn" class="btn btn-sm btn-ghost">
                ${icons.globe()}<span class="hide-sm">${esc(t('langToggle'))}</span>
              </button>
              <button id="logoutBtn" class="btn btn-sm btn-ghost btn-icon" aria-label="${esc(t('logoutBtn'))}" title="${esc(t('logoutBtn'))}">
                ${icons.logout()}
              </button>
            </div>
          </div>
        </header>

        <main class="content-area">${mainContent}</main>
      </div>

      <nav class="mobile-bottom-nav" aria-label="Mobile navigation">
        <button class="bottom-nav-item ${state.tab === 'dashboard' ? 'active' : ''}" data-tab="dashboard">${icons.dashboard()}<span>${esc(t('navDashboard'))}</span></button>
        <button class="bottom-nav-item ${state.tab === 'posts' ? 'active' : ''}" data-tab="posts">${icons.posts()}<span>${esc(t('navPosts'))}</span></button>
        <button type="button" id="mobileFabBtn" class="mobile-fab" aria-label="${esc(t('quickActionsLabel'))}">${icons.zap()}</button>
        <button class="bottom-nav-item ${state.tab === 'accounts' ? 'active' : ''}" data-tab="accounts">${icons.accounts()}<span>${esc(t('navAccounts'))}</span></button>
        <button class="bottom-nav-item ${state.tab === 'pages' ? 'active' : ''}" data-tab="pages">${icons.pages()}<span>${esc(t('navPages'))}</span></button>
      </nav>
    </div>

    ${renderPageDrawer(state.drawer, state.driveInfo, state.driveFolders, state.lang, state.busy)}
    ${renderPickPagesModal(state.modal, state.lang)}
    ${renderConfirmModal(state.confirm, state.lang)}
    ${renderQuickActionsSheet(state.quickSheetOpen, globalPaused, state.lang, isAdmin)}
    ${renderCommandPalette(state.palette, state.dashboard.pages || [], globalPaused, state.lang, isAdmin)}
    ${state.toast ? `<div class="toast" role="status" aria-live="polite">${esc(state.toast)}</div>` : ''}
  `;

  runCountUps();
  bindEvents();
}

function switchTab(nextTab) {
  withViewTransition(async () => {
    state.tab = nextTab;
    state.quickSheetOpen = false;
    state.palette.open = false;
    if (nextTab === 'posts') {
      await loadPosts().catch((e) => showToast(e.message));
    } else if (nextTab === 'logs') {
      await loadEvents().catch((e) => showToast(e.message));
    }
    render();
  });
}

function triggerGlobalPauseConfirm() {
  const nextPaused = !state.dashboard.globalPause;
  state.confirm = {
    title: nextPaused ? t('confirmPauseAllTitle') : t('confirmResumeAllTitle'),
    message: nextPaused ? t('confirmPauseAllBody') : t('confirmResumeAllBody'),
    danger: nextPaused,
    onConfirm: async () => {
      await api('/api/settings/global-pause', {
        method: 'POST',
        body: JSON.stringify({ paused: nextPaused }),
      });
      await loadAllData();
    },
  };
  render();
}

function bindEvents() {
  document.getElementById('langToggleBtn')?.addEventListener('click', () => {
    state.lang = state.lang === 'ps' ? 'en' : 'ps';
    safeStorageSet('pp_lang', state.lang);
    render();
  });
  document.getElementById('settingsLangBtn')?.addEventListener('click', () => {
    state.lang = state.lang === 'ps' ? 'en' : 'ps';
    safeStorageSet('pp_lang', state.lang);
    render();
  });

  document.getElementById('themeToggleBtn')?.addEventListener('click', () => {
    state.theme = isEffectiveDark() ? 'light' : 'dark';
    safeStorageSet('pp_theme', state.theme);
    render();
  });

  document.getElementById('toggleLoginKeyVis')?.addEventListener('click', () => {
    const inp = document.getElementById('loginPassword');
    const curVal = inp?.value || '';
    state.loginShowKey = !state.loginShowKey;
    render();
    const nextInp = document.getElementById('loginPassword');
    if (nextInp) {
      nextInp.value = curVal;
      nextInp.focus();
    }
  });

  document.getElementById('sidebarCollapseBtn')?.addEventListener('click', () => {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    safeStorageSet('pp_sidebar', state.sidebarCollapsed ? '1' : '0');
    render();
  });

  document.getElementById('cmdPaletteBtn')?.addEventListener('click', () => {
    state.palette = { open: true, query: '' };
    render();
    document.getElementById('paletteInput')?.focus();
  });
  document.getElementById('mobileSearchBtn')?.addEventListener('click', () => {
    state.palette = { open: true, query: '' };
    render();
    document.getElementById('paletteInput')?.focus();
  });
  document.getElementById('mobileFabBtn')?.addEventListener('click', () => {
    state.quickSheetOpen = true;
    render();
  });

  document.getElementById('paletteInput')?.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    state.palette.query = e.target.value;
    render();
    const el = document.getElementById('paletteInput');
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  });

  document.getElementById('loginForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const password = document.getElementById('loginPassword').value;
    if (!password) {
      state.loginError = t('passwordRequired');
      render();
      return;
    }
    state.loginError = '';
    state.busy.add('login');
    render();
    try {
      const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
      state.authenticated = true;
      state.role = res.role || 'admin';
      state.workspaceLabel = res.label || '';
      state.maxPages = res.maxPages ?? null;
      state.initialLoading = true;
      render();
      await loadAllData();
    } catch (err) {
      state.loginError = err.message;
    } finally {
      state.busy.delete('login');
      state.initialLoading = false;
      render();
    }
  });

  document.getElementById('logoutBtn')?.addEventListener('click', async () => {
    await api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
    state.authenticated = false;
    state.role = null;
    state.workspaceLabel = '';
    state.maxPages = null;
    state.licenses = [];
    state.createdLicenseKey = '';
    state.accounts = [];
    state.posts = [];
    state.driveInfo = null;
    state.driveFolders = null;
    state.dashboard = { globalPause: false, ownerGlobalPause: false, pages: [], accounts: [], sparklines: null, needsAttentionCount: 0 };
    state.tab = 'dashboard';
    state.drawer = null;
    state.modal = null;
    state.confirm = null;
    state.quickSheetOpen = false;
    state.palette.open = false;
    render();
  });

  document.getElementById('refreshBtn')?.addEventListener('click', async () => {
    state.busy.add('refresh');
    render();
    try {
      await loadAllData();
      showToast('OK');
    } catch (err) {
      showToast(err.message);
    } finally {
      state.busy.delete('refresh');
      render();
    }
  });

  async function runSyncAllDrive() {
    state.busy.add('sync-all-posts');
    render();
    try {
      const res = await api('/api/posts/sync', { method: 'POST', body: '{}' });
      await loadAllData();
      showToast(t('syncDoneToast', { n: res.filledSlots || 0 }));
    } catch (err) {
      showToast(err.message);
    } finally {
      state.busy.delete('sync-all-posts');
      render();
    }
  }

  document.getElementById('syncAllPostsBtn')?.addEventListener('click', runSyncAllDrive);

  document.getElementById('postFilterPage')?.addEventListener('change', (e) => {
    state.postFilters.pageId = e.target.value;
    state.postsPageNum = 1;
    render();
  });

  document.querySelectorAll('[data-tab]').forEach((btn) => {
    if (btn.dataset.action === 'switch-drawer-tab') return;
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('emptyGoAccountsBtn')?.addEventListener('click', () => switchTab('accounts'));
  document.getElementById('pagesGoAccountsBtn')?.addEventListener('click', () => switchTab('accounts'));
  document.getElementById('globalPauseBtn')?.addEventListener('click', triggerGlobalPauseConfirm);

  // Dashboard & Pages filters
  document.getElementById('dashSearchInput')?.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    state.dashFilters.search = e.target.value;
    state.dashPageNum = 1;
    render();
    const el = document.getElementById('dashSearchInput');
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  });
  document.getElementById('pagesSearchInput')?.addEventListener('input', (e) => {
    const pos = e.target.selectionStart;
    state.pagesSearch = e.target.value;
    state.pagesPageNum = 1;
    render();
    const el = document.getElementById('pagesSearchInput');
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  });
  document.getElementById('dashFilterAccount')?.addEventListener('change', (e) => {
    state.dashFilters.accountId = e.target.value;
    state.dashPageNum = 1;
    render();
  });
  document.getElementById('dashSortSelect')?.addEventListener('change', (e) => {
    state.dashFilters.sort = e.target.value;
    state.dashPageNum = 1;
    render();
  });
  document.getElementById('clearDashFiltersBtn')?.addEventListener('click', () => {
    state.dashFilters = { search: '', accountId: '', status: '', sort: 'next' };
    state.dashPageNum = 1;
    render();
  });

  // 2-Mode Facebook Token Form
  document.getElementById('manualTokenForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const inputEl = document.getElementById('manualTokenInput');
    const token = inputEl.value.trim();
    if (!token) {
      state.manualTokenError = t('manualTokenRequired');
      render();
      return;
    }
    state.manualTokenError = '';
    state.busy.add('manual-account');
    render();
    try {
      const res = await api('/api/accounts/manual', {
        method: 'POST',
        body: JSON.stringify({ token, mode: state.tokenMode }),
      });
      await loadAllData();
      if (res.mode === 'page') {
        showToast(t('pageConnectedSuccess', { name: res.page?.name || '' }));
        if (state.driveInfo?.configured && res.page?.id) {
          await openDrawer(res.page.id, 'drive');
        }
      } else if (res.account?.id) {
        await openPickPagesModal(res.account.id);
      }
    } catch (err) {
      state.manualTokenError = err.message;
    } finally {
      state.busy.delete('manual-account');
      render();
    }
  });

  // Super Admin Create License Form
  document.getElementById('createLicenseForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const label = document.getElementById('licLabelInput')?.value.trim() || '';
    const maxPages = Number(document.getElementById('licMaxPagesInput')?.value || 20);
    const expiresDays = Number(document.getElementById('licExpirySelect')?.value || 0);
    state.busy.add('create-license');
    render();
    try {
      const res = await api('/api/licenses', {
        method: 'POST',
        body: JSON.stringify({ label, maxPages, expiresDays }),
      });
      state.createdLicenseKey = res.rawKey || '';
      state.licenseKeyCopied = false;
      await loadAllData();
    } catch (err) {
      showToast(err.message);
    } finally {
      state.busy.delete('create-license');
      render();
    }
  });

  document.getElementById('copyCreatedKeyBtn')?.addEventListener('click', async () => {
    if (!state.createdLicenseKey) return;
    await navigator.clipboard?.writeText(state.createdLicenseKey).catch(() => {});
    state.licenseKeyCopied = true;
    showToast(t('copiedMsg'));
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      state.licenseKeyCopied = false;
      render();
    }, 2200);
  });

  document.getElementById('shareCreatedKeyBtn')?.addEventListener('click', async () => {
    if (state.createdLicenseKey && navigator.share) {
      await navigator.share({ title: t('appName'), text: state.createdLicenseKey }).catch(() => {});
    }
  });

  document.getElementById('dismissCreatedKeyBtn')?.addEventListener('click', () => {
    state.createdLicenseKey = '';
    state.licenseKeyCopied = false;
    render();
  });

  // Generic [data-action] delegation
  document.querySelectorAll('[data-action]').forEach((el) => {
    el.addEventListener('click', async (evt) => {
      const action = el.dataset.action;
      const id = Number(el.dataset.id);

      if (action === 'close-drawer') {
        state.drawer = null;
        render();
      } else if (action === 'close-drawer-backdrop' && evt.target === el) {
        state.drawer = null;
        render();
      } else if (action === 'close-modal') {
        state.modal = null;
        render();
      } else if (action === 'close-confirm') {
        state.confirm = null;
        render();
      } else if (action === 'close-quick') {
        state.quickSheetOpen = false;
        render();
      } else if (action === 'close-quick-backdrop' && evt.target === el) {
        state.quickSheetOpen = false;
        render();
      } else if (action === 'close-palette-backdrop' && evt.target === el) {
        state.palette.open = false;
        render();
      } else if (action === 'set-post-status') {
        state.postFilters.status = el.dataset.val || '';
        state.postsPageNum = 1;
        render();
      } else if (action === 'sync-all-drive') {
        await runSyncAllDrive();
      } else if (action === 'paginate') {
        const nextP = Math.max(1, Number(el.dataset.page || 1));
        const scope = el.dataset.scope;
        if (scope === 'dash') state.dashPageNum = nextP;
        else if (scope === 'pages') state.pagesPageNum = nextP;
        else if (scope === 'posts') state.postsPageNum = nextP;
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      } else if (action === 'set-token-mode') {
        state.tokenMode = el.dataset.val === 'page' ? 'page' : 'user';
        state.manualTokenError = '';
        render();
      } else if (action === 'prepare-update-token') {
        state.tokenMode = el.dataset.mode === 'page' ? 'page' : 'user';
        state.manualTokenError = '';
        render();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        document.getElementById('manualTokenInput')?.focus();
      } else if (action === 'confirm-disconnect-google') {
        state.confirm = {
          title: t('confirmDisconnectGoogleTitle'),
          message: t('confirmDisconnectGoogleBody'),
          danger: true,
          onConfirm: async () => {
            state.busy.add('disconnect-google');
            render();
            try {
              state.driveInfo = await api('/api/drive/disconnect', { method: 'POST', body: '{}' });
              state.driveFolders = null;
              state.googleBanner = '';
            } finally {
              state.busy.delete('disconnect-google');
              render();
            }
          },
        };
        render();
      } else if (action === 'set-status-chip') {
        state.dashFilters.status = el.dataset.val || '';
        state.dashPageNum = 1;
        render();
      } else if (action === 'set-theme') {
        state.theme = el.dataset.val;
        safeStorageSet('pp_theme', state.theme);
        render();
      } else if (action === 'set-density') {
        state.density = el.dataset.val;
        safeStorageSet('pp_density', state.density);
        render();
      } else if (action === 'set-accent') {
        state.accent = el.dataset.val;
        safeStorageSet('pp_accent', state.accent);
        render();
      } else if (action === 'inspect-slot') {
        const pageId = Number(el.dataset.pageId);
        const slotId = el.dataset.slotId;
        const same = state.activeSlotPopover?.pageId === pageId && state.activeSlotPopover?.slotId === slotId;
        state.activeSlotPopover = same ? null : { pageId, slotId };
        render();
      } else if (action === 'run-palette-action') {
        const cmd = el.dataset.cmd;
        state.palette.open = false;
        state.quickSheetOpen = false;
        if (cmd === 'cmd-posts') switchTab('posts');
        else if (cmd === 'cmd-pause') triggerGlobalPauseConfirm();
        else if (cmd === 'cmd-licenses') switchTab('licenses');
        else if (cmd === 'cmd-add-page') switchTab('accounts');
        else if (cmd === 'cmd-logs') switchTab('logs');
        else if (cmd === 'cmd-settings') switchTab('settings');
      } else if (action === 'open-drawer') {
        await openDrawer(id, el.dataset.drawerTab || 'schedule');
      } else if (action === 'sync-page-drive') {
        state.busy.add(`sync:${id}`);
        render();
        try {
          const res = await api(`/api/pages/${id}/sync`, { method: 'POST', body: '{}' });
          await loadAllData();
          if (state.drawer?.pageId === id && state.drawer.tab === 'preview') {
            await loadDrawerPreview();
          }
          showToast(t('syncDoneToast', { n: res.filledCount || 0 }));
        } catch (err) {
          showToast(err.message);
        } finally {
          state.busy.delete(`sync:${id}`);
          render();
        }
      } else if (action === 'switch-drawer-tab' && state.drawer) {
        syncDrawerFormInputs();
        state.drawer.tab = el.dataset.tab;
        render();
        if (state.drawer.tab === 'drive' && state.driveInfo?.configured && !state.driveFolders) {
          loadDriveFoldersIntoDrawer();
        } else if (state.drawer.tab === 'preview' && !state.drawer.preview && !state.drawer.previewLoading) {
          loadDrawerPreview();
        }
      } else if (action === 'set-slot-period' && state.drawer) {
        syncDrawerFormInputs();
        state.drawer.newSlotPeriod = el.dataset.val === 'AM' ? 'AM' : 'PM';
        render();
      } else if (action === 'set-jitter' && state.drawer) {
        syncDrawerFormInputs();
        state.drawer.page.jitter_minutes = Number(el.dataset.val || 0);
        render();
      } else if (action === 'step' && state.drawer) {
        const inp = document.getElementById(el.dataset.target);
        if (inp) {
          const min = Number(el.dataset.min);
          const max = Number(el.dataset.max);
          const next = Math.max(min, Math.min(max, Number(inp.value || 0) + Number(el.dataset.delta || 0)));
          inp.value = String(next);
          if (el.dataset.target === 'editDailyCap') {
            state.drawer.customCap = true;
          }
          syncDrawerFormInputs();
          render();
        }
      } else if (action === 'quick-add-slot' && state.drawer) {
        syncDrawerFormInputs();
        const slotVal = el.dataset.slot;
        if (slotVal && !state.drawer.slots.includes(slotVal)) {
          state.drawer.slots.push(slotVal);
          state.drawer.slots.sort();
          state.drawer.slotError = '';
          render();
        }
      } else if (action === 'remove-slot' && state.drawer) {
        syncDrawerFormInputs();
        state.drawer.slots.splice(Number(el.dataset.idx), 1);
        render();
      } else if (action === 'toggle-pause') {
        const currentlyPaused = el.dataset.paused === '1';
        state.busy.add(`pause:${id}`);
        render();
        try {
          await api(`/api/pages/${id}/pause`, { method: 'POST', body: JSON.stringify({ paused: !currentlyPaused }) });
          await loadAllData();
        } catch (err) {
          showToast(err.message);
        } finally {
          state.busy.delete(`pause:${id}`);
          render();
        }
      } else if (action === 'confirm-post-now') {
        state.confirm = {
          title: t('confirmPostNowTitle'),
          message: `${el.dataset.name || ''} — ${t('confirmPostNow')}`,
          danger: false,
          onConfirm: async () => {
            state.busy.add(`post:${id}`);
            render();
            try {
              const res = await api(`/api/pages/${id}/post-now`, { method: 'POST', body: '{}' });
              await loadAllData();
              showToast(res.status === 'posted' ? `${t('slot_posted')} (${res.fileName})` : res.error || res.status);
            } finally {
              state.busy.delete(`post:${id}`);
              render();
            }
          },
        };
        render();
      } else if (action === 'confirm-delete-page') {
        state.confirm = {
          title: t('confirmDeletePageTitle'),
          message: `${el.dataset.name || ''} — ${t('confirmDeletePage')}`,
          danger: true,
          onConfirm: async () => {
            await api(`/api/pages/${id}`, { method: 'DELETE' });
            if (state.drawer?.pageId === id) state.drawer = null;
            await loadAllData();
          },
        };
        render();
      } else if (action === 'confirm-delete-account') {
        state.confirm = {
          title: t('confirmDeleteAccountTitle'),
          message: `${el.dataset.name || ''} — ${t('confirmDeleteAccount')}`,
          danger: true,
          onConfirm: async () => {
            await api(`/api/accounts/${id}`, { method: 'DELETE' });
            await loadAllData();
          },
        };
        render();
      } else if (action === 'toggle-license') {
        const nextStatus = el.dataset.status === 'active' ? 'disabled' : 'active';
        await api(`/api/licenses/${id}`, { method: 'PATCH', body: JSON.stringify({ status: nextStatus }) })
          .then(() => loadAllData())
          .catch((e) => showToast(e.message));
        render();
      } else if (action === 'extend-license') {
        await api(`/api/licenses/${id}`, { method: 'PATCH', body: JSON.stringify({ extendDays: 30 }) })
          .then(async () => {
            await loadAllData();
            showToast('+30d');
          })
          .catch((e) => showToast(e.message));
        render();
      } else if (action === 'confirm-delete-license') {
        state.confirm = {
          title: t('confirmDeleteLicenseTitle'),
          message: `${el.dataset.name || ''} — ${t('confirmDeleteLicenseBody')}`,
          danger: true,
          onConfirm: async () => {
            await api(`/api/licenses/${id}`, { method: 'DELETE' });
            await loadAllData();
          },
        };
        render();
      } else if (action === 'select-pages') {
        await openPickPagesModal(id);
      } else if (action === 'check-account') {
        const res = await api(`/api/accounts/${id}/check`, { method: 'POST', body: '{}' }).catch((e) => ({
          ok: false,
          error: e.message,
        }));
        await loadAllData();
        render();
        showToast(res.ok ? 'Token OK' : res.error || 'Token invalid');
      } else if (action === 'retry-failed') {
        await api(`/api/pages/${id}/retry-failed`, { method: 'POST', body: '{}' })
          .then(async () => {
            await loadAllData();
            if (state.drawer?.pageId === id) await openDrawer(id, 'history');
            else render();
          })
          .catch((e) => showToast(e.message));
      } else if (action === 'unblock-one' && state.drawer) {
        const fileId = el.dataset.fileId;
        await api(`/api/pages/${state.drawer.pageId}/unblock`, { method: 'POST', body: JSON.stringify({ fileId }) });
        await loadAllData();
        await openDrawer(state.drawer.pageId, 'preview');
      }
    });
  });

  // Confirm modal OK
  document.getElementById('confirmOkBtn')?.addEventListener('click', async () => {
    const fn = state.confirm?.onConfirm;
    state.confirm = null;
    render();
    if (fn) {
      await fn().catch((e) => showToast(e.message));
      render();
    }
  });

  // Pick Pages modal
  document.querySelectorAll('.pick-page-cb').forEach((cb) => {
    cb.addEventListener('change', () => {
      if (state.modal?.type !== 'pickPages') return;
      if (cb.checked) state.modal.selected.add(cb.value);
      else state.modal.selected.delete(cb.value);
    });
  });

  document.getElementById('savePickedPagesBtn')?.addEventListener('click', async () => {
    if (state.modal?.type !== 'pickPages') return;
    const fbPageIds = Array.from(state.modal.selected);
    try {
      await api(`/api/accounts/${state.modal.accountId}/pages`, { method: 'POST', body: JSON.stringify({ fbPageIds }) });
      state.modal = null;
      await loadAllData();
      state.tab = 'pages';
      render();
    } catch (err) {
      showToast(err.message);
    }
  });

  // Drawer interactions
  document.getElementById('copySaEmailBtn')?.addEventListener('click', async () => {
    if (state.driveInfo?.serviceAccountEmail) {
      await navigator.clipboard?.writeText(state.driveInfo.serviceAccountEmail).catch(() => {});
      showToast(t('copiedMsg'));
    }
  });

  document.getElementById('loadFoldersBtn')?.addEventListener('click', loadDriveFoldersIntoDrawer);
  document.getElementById('refreshPreviewBtn')?.addEventListener('click', loadDrawerPreview);

  ['editCaptionsFolder', 'editMediaFolder'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      syncDrawerFormInputs();
      render();
    });
  });

  document.getElementById('editDailyCap')?.addEventListener('input', () => {
    if (state.drawer) state.drawer.customCap = true;
    updateLiveScheduleSummaryInDom();
  });

  document.getElementById('advSchedulePanel')?.addEventListener('toggle', (e) => {
    if (state.drawer) state.drawer.advOpen = Boolean(e.target.open);
  });

  ['editJitter', 'editMinGap', 'editRampEnabled', 'editRampStart', 'editRampStep'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', updateLiveScheduleSummaryInDom);
    document.getElementById(id)?.addEventListener('change', updateLiveScheduleSummaryInDom);
  });

  document.getElementById('editTzSelect')?.addEventListener('change', (e) => {
    const customWrap = document.getElementById('customTzWrap');
    const customInput = document.getElementById('editTzCustom');
    if (e.target.value === '__custom__') {
      customWrap.style.display = '';
    } else {
      customWrap.style.display = 'none';
      customInput.value = e.target.value;
    }
  });

  document.getElementById('addSlotBtn')?.addEventListener('click', () => {
    if (!state.drawer) return;
    syncDrawerFormInputs();
    const hour12 = Number(document.getElementById('newSlotHour')?.value || state.drawer.newSlotHour || 8);
    const minute = Number(document.getElementById('newSlotMinute')?.value ?? state.drawer.newSlotMinute ?? 0);
    const val = to24hHHMM(hour12, minute, state.drawer.newSlotPeriod || 'PM');
    if (!val || state.drawer.slots.includes(val)) {
      state.drawer.slotError = t('slotInvalid');
      render();
      return;
    }
    state.drawer.slotError = '';
    state.drawer.slots.push(val);
    state.drawer.slots.sort();
    render();
  });

  document.getElementById('drawerScheduleForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!state.drawer) return;
    syncDrawerFormInputs();
    const p = state.drawer.page;
    if (!isValidIanaTimezone(p.timezone)) {
      state.drawer.formError = t('invalidTimezoneMsg');
      render();
      return;
    }
    state.drawer.formError = '';
    state.busy.add(`save:${p.id}`);
    render();
    try {
      await api(`/api/pages/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: p.name.trim(),
          status: p.status,
          timezone: p.timezone.trim(),
          slots: state.drawer.slots,
          jitter_minutes: p.jitter_minutes,
          auto_cap: !state.drawer.customCap,
          daily_cap: p.daily_cap,
          min_gap_minutes: p.min_gap_minutes,
          ramp_up_enabled: p.ramp_up_enabled,
          ramp_start: p.ramp_start,
          ramp_step_days: p.ramp_step_days,
        }),
      });
      await loadAllData();
      showToast(t('savedSuccess'));
    } catch (err) {
      if (state.drawer) state.drawer.formError = err.message;
    } finally {
      state.busy.delete(`save:${p.id}`);
      render();
    }
  });

  document.getElementById('saveDriveFoldersBtn')?.addEventListener('click', async () => {
    if (!state.drawer) return;
    syncDrawerFormInputs();
    const p = state.drawer.page;
    state.busy.add(`save:${p.id}`);
    render();
    try {
      await api(`/api/pages/${p.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          captions_folder_id: p.captions_folder_id,
          captions_folder_name: p.captions_folder_name,
          media_folder_id: p.media_folder_id,
          media_folder_name: p.media_folder_name,
        }),
      });
      await loadAllData();
      showToast(t('savedSuccess'));
    } catch (err) {
      showToast(err.message);
    } finally {
      state.busy.delete(`save:${p.id}`);
      render();
    }
  });

  document.getElementById('drawerUnblockAllBtn')?.addEventListener('click', async () => {
    if (!state.drawer) return;
    await api(`/api/pages/${state.drawer.pageId}/unblock`, { method: 'POST', body: '{}' });
    await loadAllData();
    await openDrawer(state.drawer.pageId, 'preview');
  });

  // Logs filters
  const bindLogFilter = (elId, key) => {
    document.getElementById(elId)?.addEventListener('change', async (e) => {
      state.eventFilters[key] = e.target.value;
      await loadEvents().catch((err) => showToast(err.message));
      render();
    });
  };
  bindLogFilter('logFilterPage', 'pageId');
  bindLogFilter('logFilterLevel', 'level');
  bindLogFilter('logFilterDate', 'date');
}

document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k' && state.authenticated) {
    e.preventDefault();
    state.palette = { open: !state.palette.open, query: '' };
    render();
    if (state.palette.open) document.getElementById('paletteInput')?.focus();
    return;
  }
  if (e.key !== 'Escape') return;
  if (state.palette.open) {
    state.palette.open = false;
    render();
  } else if (state.quickSheetOpen) {
    state.quickSheetOpen = false;
    render();
  } else if (state.confirm) {
    state.confirm = null;
    render();
  } else if (state.modal) {
    state.modal = null;
    render();
  } else if (state.drawer) {
    state.drawer = null;
    render();
  }
});

async function init() {
  applyPreferences();
  const url = new URL(window.location.href);
  const tabParam = url.searchParams.get('tab');
  const fbError = url.searchParams.get('fb_error');
  const googleConnected = url.searchParams.get('google_connected');
  const googleError = url.searchParams.get('google_error');

  if (tabParam && ['dashboard', 'posts', 'accounts', 'pages', 'licenses', 'logs', 'settings'].includes(tabParam)) {
    state.tab = tabParam;
  }
  if (fbError) {
    state.fbOAuthBanner = fbError;
  }
  if (googleConnected === '1') {
    state.googleBanner = t('googleConnectedSuccess');
  }
  if (googleError) {
    state.googleError = googleError;
  }

  try {
    const sess = await api('/api/session');
    state.authenticated = Boolean(sess.authenticated);
    state.role = sess.role || null;
    state.workspaceLabel = sess.label || '';
    state.maxPages = sess.maxPages ?? null;
  } catch {
    state.authenticated = false;
    state.role = null;
  }
  state.checkingAuth = false;

  if (state.authenticated) {
    if (state.tab === 'licenses' && state.role !== 'admin') {
      state.tab = 'dashboard';
    }
    state.initialLoading = true;
    render();
    await loadAllData().catch((e) => showToast(e.message));
    state.initialLoading = false;
  }

  if (fbError || googleConnected || googleError || tabParam) {
    window.history.replaceState({}, '', '/');
  }

  render();
}

init();
