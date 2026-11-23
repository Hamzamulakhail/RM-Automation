import {
  buildScheduleSummary,
  esc,
  formatExactUtc,
  formatRelativeTime,
  formatTime12h,
  minutesFromHHMM,
} from './api.js';
import { translate } from './i18n.js';
import { getAvatarGradient, getInitials, icons, illustrations } from './icons.js';

export const COMMON_TIMEZONES = [
  'Asia/Kabul',
  'Asia/Dubai',
  'Asia/Karachi',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kolkata',
  'UTC',
];

export const ACCENT_PRESETS = [
  { id: 'aurora', c1: '#6366f1', c2: '#06b6d4' },
  { id: 'violet', c1: '#8b5cf6', c2: '#ec4899' },
  { id: 'emerald', c1: '#10b981', c2: '#06b6d4' },
  { id: 'amber', c1: '#f59e0b', c2: '#ea580c' },
  { id: 'rose', c1: '#f43f5e', c2: '#ec4899' },
];

export function renderAvatar(name, pictureUrl = '', sizePx = 36) {
  const fontSize = sizePx <= 28 ? 11 : sizePx >= 42 ? 15 : 13;
  return `
    <span class="avatar-circle" style="width:${sizePx}px;height:${sizePx}px;font-size:${fontSize}px;background:${getAvatarGradient(name)}">
      <span class="avatar-initials">${esc(getInitials(name))}</span>
      ${
        pictureUrl
          ? `<img class="avatar-img" src="${esc(pictureUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />`
          : ''
      }
    </span>
  `;
}

export function renderStatusBadge(status, label) {
  let iconHtml = icons.info();
  if (status === 'active' || status === 'posted' || status === 'used') {
    iconHtml = icons.checkCircle();
  } else if (status === 'posting') {
    iconHtml = icons.spinner();
  } else if (status === 'paused' || status === 'retrying' || status === 'warn' || status === 'pending') {
    iconHtml = status === 'warn' ? icons.alertTriangle() : status === 'pending' ? icons.clock() : icons.pause();
  } else if (status === 'needs_attention' || status === 'failed' || status === 'revoked' || status === 'error') {
    iconHtml = status === 'failed' || status === 'error' ? icons.xCircle() : icons.alertTriangle();
  } else if (status === 'missed' || status === 'skipped' || status === 'expired') {
    iconHtml = icons.clock();
  }
  return `<span class="badge badge-${esc(status)}">${iconHtml}<span>${esc(label)}</span></span>`;
}

export function renderSkeletonGrid(count = 4) {
  return `<div class="page-grid">${Array.from({ length: count })
    .map(
      () => `
      <div class="card skeleton-card" aria-hidden="true">
        <div class="row-start">
          <div class="skeleton-line" style="width:42px;height:42px;border-radius:50%"></div>
          <div class="stack-sm" style="flex:1">
            <div class="skeleton-line w-60"></div>
            <div class="skeleton-line w-40"></div>
          </div>
        </div>
        <div class="skeleton-line w-100" style="height:34px"></div>
        <div class="skeleton-line w-80"></div>
      </div>`
    )
    .join('')}</div>`;
}

function renderSparklineSvg(values, strokeColor) {
  const arr = Array.isArray(values) && values.length > 0 ? values : [0, 0, 0, 0, 0, 0, 0];
  const max = Math.max(1, ...arr);
  const w = 76;
  const h = 26;
  const pad = 3;
  const pts = arr.map((v, i) => {
    const x = arr.length === 1 ? w / 2 : (i / (arr.length - 1)) * (w - pad * 2) + pad;
    const y = h - pad - ((Number(v) || 0) / max) * (h - pad * 2);
    return [x.toFixed(1), y.toFixed(1)];
  });
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ');
  const area = `${pts[0][0]},${h} ${line} ${pts[pts.length - 1][0]},${h}`;
  return `
    <svg class="stat-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true">
      <polygon points="${area}" fill="${strokeColor}" fill-opacity="0.14"/>
      <polyline points="${line}" fill="none" stroke="${strokeColor}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `;
}

export function renderHeroToday(pages, globalPause, lang, busyMap = null) {
  const t = (k, v) => translate(lang, k, v);
  let posted = 0;
  let planned = 0;
  let attention = 0;

  for (const p of pages) {
    if (p.status === 'needs_attention' || p.account_status === 'needs_attention') attention++;
    for (const s of p.today_slots || []) {
      planned++;
      if (s.status === 'posted') posted++;
    }
  }

  const pct = planned > 0 ? Math.min(100, Math.round((posted / planned) * 100)) : 0;
  const r = 30;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;
  const syncingAll = busyMap ? busyMap.has('sync-all-posts') : false;

  const healthBadge = globalPause
    ? renderStatusBadge('failed', t('heroSystemPaused'))
    : attention > 0
      ? renderStatusBadge('warn', t('heroSystemAttention', { n: attention }))
      : renderStatusBadge('active', t('heroSystemHealthy'));

  return `
    <section class="hero-today" aria-label="${esc(t('heroTodayTitle'))}">
      <div class="hero-ring-wrap">
        <div class="ring-center">
          <svg class="progress-ring-svg" viewBox="0 0 74 74" aria-hidden="true">
            <defs>
              <linearGradient id="auroraRingGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="var(--accent-1)"/>
                <stop offset="100%" stop-color="var(--accent-2)"/>
              </linearGradient>
            </defs>
            <circle class="ring-track" cx="37" cy="37" r="${r}"/>
            <circle class="ring-fill" cx="37" cy="37" r="${r}" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
          </svg>
          <span class="ring-center-label ltr tabular">${pct}%</span>
        </div>
        <div class="stack-sm">
          <h2 class="section-title">${esc(t('heroTodayTitle'))}</h2>
          <div class="hero-meta-line">
            <span class="tabular">${esc(t('heroPostedOfPlanned', { posted, total: planned }))}</span>
            <span aria-hidden="true">·</span>
            <span class="tabular">${pages.length} ${esc(t('statTotalPages'))}</span>
          </div>
        </div>
      </div>
      <div class="row-start">
        ${healthBadge}
        ${
          pages.length > 0
            ? `<button type="button" class="btn btn-sm" data-action="sync-all-drive" ${syncingAll ? 'disabled' : ''}>
                ${syncingAll ? icons.spinner() : icons.refresh()}
                <span>${esc(t('syncAllDriveBtn'))}</span>
              </button>`
            : ''
        }
      </div>
    </section>
  `;
}

export function renderSummaryTiles(pages, sparklines, lang) {
  const t = (k) => translate(lang, k);
  let postedToday = 0;
  let pendingToday = 0;
  let failedToday = 0;
  let attentionCount = 0;

  for (const p of pages) {
    if (p.status === 'needs_attention' || p.account_status === 'needs_attention') {
      attentionCount++;
    }
    for (const s of p.today_slots || []) {
      if (s.status === 'posted') postedToday++;
      else if (s.status === 'pending' || s.status === 'posting') pendingToday++;
      else if (s.status === 'failed') failedToday++;
    }
  }

  const sp = sparklines || {};
  const tiles = [
    {
      label: t('statPostsToday'),
      value: postedToday,
      tone: 'success',
      series: sp.posted,
      stroke: 'var(--emerald)',
    },
    {
      label: t('statPending'),
      value: pendingToday,
      tone: 'primary',
      series: sp.planned,
      stroke: 'var(--accent-2)',
    },
    {
      label: t('statFailed'),
      value: failedToday,
      tone: failedToday > 0 ? 'danger' : 'neutral',
      series: sp.failed,
      stroke: failedToday > 0 ? 'var(--rose)' : 'var(--text-dim)',
    },
    {
      label: t('statAttention'),
      value: attentionCount,
      tone: attentionCount > 0 ? 'danger' : 'neutral',
      series: null,
      stroke: 'var(--rose)',
    },
  ];

  return `
    <section class="stats-strip" aria-label="KPI Summary">
      ${tiles
        .map(
          (tile) => `
        <div class="stat-cell stat-${tile.tone}">
          <span class="stat-label">${esc(tile.label)}</span>
          <div class="stat-bottom">
            <div class="stat-value ltr tabular" data-countup="${tile.value}">${tile.value}</div>
            ${tile.series ? renderSparklineSvg(tile.series, tile.stroke) : ''}
          </div>
        </div>`
        )
        .join('')}
    </section>
  `;
}

export function renderPaginationBar(total, pageNum, pageSize, scope, lang) {
  if (total <= pageSize) return '';
  const t = (k, v) => translate(lang, k, v);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(Math.max(1, pageNum), totalPages);
  const from = (cur - 1) * pageSize + 1;
  const to = Math.min(total, cur * pageSize);

  return `
    <div class="pagination-bar">
      <span class="muted small-text tabular">${esc(t('showingRange', { from, to, total }))}</span>
      <div class="row-start">
        <button type="button" class="btn btn-sm" data-action="paginate" data-scope="${esc(scope)}" data-page="${cur - 1}" ${cur <= 1 ? 'disabled' : ''}>
          ${esc(t('prevPageBtn'))}
        </button>
        <span class="small-text ltr tabular muted">${cur} / ${totalPages}</span>
        <button type="button" class="btn btn-sm" data-action="paginate" data-scope="${esc(scope)}" data-page="${cur + 1}" ${cur >= totalPages ? 'disabled' : ''}>
          ${esc(t('nextPageBtn'))}
        </button>
      </div>
    </div>
  `;
}

export function renderDashboardPagesTable(pagesSlice, totalFiltered, pageNum, pageSize, lang, busyMap) {
  const t = (k) => translate(lang, k);

  return `
    <section class="card table-card">
      <div class="data-list">
        <div class="dash-data-head" aria-hidden="true">
          <span>${esc(t('colPage'))}</span>
          <span>${esc(t('colTodayProgress'))}</span>
          <span>${esc(t('colNextPost'))}</span>
          <span>${esc(t('colStatus'))}</span>
          <span>${esc(t('colActions'))}</span>
        </div>
        ${pagesSlice
          .map((p) => {
            const isPaused = p.status === 'paused';
            const hasFolders = Boolean(p.captions_folder_id && p.media_folder_id);
            const todaySlots = p.today_slots || [];
            const postedCnt = todaySlots.filter((s) => s.status === 'posted').length;
            const totalCnt = todaySlots.length;
            const pct = totalCnt > 0 ? Math.min(100, Math.round((postedCnt / totalCnt) * 100)) : 0;
            const nextUtc = p.next_planned?.planned_utc;
            const nextRel = nextUtc ? formatRelativeTime(nextUtc, lang) : '';
            const nextQueuedFile = todaySlots.find((s) => s.status === 'pending' && s.file_name)?.file_name || '';
            const postBusy = busyMap.has(`post:${p.id}`);
            const pauseBusy = busyMap.has(`pause:${p.id}`);

            return `
              <div class="dash-data-row" data-page-id="${p.id}">
                <div class="dash-col-page">
                  <div class="page-cell-main">
                    ${renderAvatar(p.name, p.picture_url, 36)}
                    <div class="min-w-0">
                      <div class="page-row-name">${esc(p.name)}</div>
                      <div class="muted small-text page-row-sub">
                        <span>${esc(p.account_name)}</span>
                        <span aria-hidden="true">·</span>
                        <span class="ltr">${esc(p.timezone)}</span>
                        <span aria-hidden="true">·</span>
                        <span class="ltr tabular">${esc(formatTime12h(p.local_time))}</span>
                      </div>
                      ${
                        p.last_error
                          ? `<div class="field-error small-text" style="margin-top:2px">${esc(p.last_error)}</div>`
                          : !hasFolders
                            ? `<div class="muted small-text" style="color:var(--amber);margin-top:2px">${esc(t('folderNotSet'))}</div>`
                            : ''
                      }
                    </div>
                  </div>
                </div>

                <div class="dash-col-progress">
                  <div class="progress-mini-wrap">
                    <div class="row" style="gap:8px">
                      <span class="small-text ltr tabular"><strong>${postedCnt}</strong> / ${totalCnt}</span>
                      <span class="small-text ltr tabular muted">${pct}%</span>
                    </div>
                    <div class="progress-mini-bar" aria-hidden="true">
                      <span class="progress-mini-fill" style="width:${pct}%"></span>
                    </div>
                  </div>
                </div>

                <div class="dash-col-next min-w-0">
                  ${
                    p.next_planned
                      ? `<div class="min-w-0">
                           <div class="ltr tabular small-text">
                             <strong>${esc(formatTime12h(p.next_planned.planned_local))}</strong>
                             <span class="muted"> · ${esc(nextRel)}</span>
                           </div>
                           ${
                             nextQueuedFile
                               ? `<div class="queued-file-inline ltr muted small-text">${esc(nextQueuedFile)}</div>`
                               : ''
                           }
                         </div>`
                      : `<span class="muted small-text">${esc(t('noNextPlanned'))}</span>`
                  }
                </div>

                <div class="dash-col-status">
                  ${renderStatusBadge(p.status, t(`status_${p.status}`))}
                </div>

                <div class="dash-col-actions">
                  <div class="row-start row-actions-compact">
                    <button type="button" class="btn btn-sm" data-action="open-drawer" data-id="${p.id}" data-drawer-tab="schedule">
                      ${icons.sliders()}
                      <span>${esc(t('detailsBtn'))}</span>
                    </button>
                    <button type="button" class="btn btn-sm btn-icon" data-action="toggle-pause" data-id="${p.id}" data-paused="${isPaused ? '1' : '0'}" title="${esc(isPaused ? t('resumePage') : t('pausePage'))}" aria-label="${esc(isPaused ? t('resumePage') : t('pausePage'))}" ${pauseBusy ? 'disabled' : ''}>
                      ${pauseBusy ? icons.spinner() : isPaused ? icons.play() : icons.pause()}
                    </button>
                    <button type="button" class="btn btn-sm btn-icon btn-primary" data-action="confirm-post-now" data-id="${p.id}" data-name="${esc(p.name)}" title="${esc(t('postNow'))}" aria-label="${esc(t('postNow'))}" ${postBusy ? 'disabled' : ''}>
                      ${postBusy ? icons.spinner() : icons.send()}
                    </button>
                  </div>
                </div>
              </div>`;
          })
          .join('')}
      </div>
      ${renderPaginationBar(totalFiltered, pageNum, pageSize, 'dash', lang)}
    </section>
  `;
}

export function renderPagesDirectory(pagesSlice, totalFiltered, pageNum, pageSize, lang) {
  const t = (k) => translate(lang, k);
  return `
    <section class="card table-card">
      <div class="directory-list">
        ${pagesSlice
          .map((p) => {
            const slots = p.slots || [];
            const hasFolders = Boolean(p.captions_folder_id && p.media_folder_id);
            const folderLabel = hasFolders
              ? `${p.captions_folder_name || p.captions_folder_id} / ${p.media_folder_name || p.media_folder_id}`
              : t('folderNotSet');

            return `
              <div class="directory-row" data-page-id="${p.id}">
                <div class="directory-row-top">
                  <div class="page-cell-main min-w-0" style="flex:1">
                    ${renderAvatar(p.name, p.picture_url, 38)}
                    <div class="min-w-0">
                      <div class="page-row-name">${esc(p.name)}</div>
                      <div class="muted small-text page-row-sub">
                        <span>${esc(p.account_name)}</span>
                        <span aria-hidden="true">·</span>
                        <span class="ltr">${esc(p.timezone)}</span>
                        <span aria-hidden="true">·</span>
                        <span style="${hasFolders ? '' : 'color:var(--amber)'}">${esc(folderLabel)}</span>
                      </div>
                    </div>
                  </div>

                  <div class="directory-row-actions">
                    ${renderStatusBadge(p.status, t(`status_${p.status}`))}
                    <button type="button" class="btn btn-sm btn-primary" data-action="open-drawer" data-id="${p.id}" data-drawer-tab="schedule">
                      ${icons.sliders()}<span>${esc(t('drawerTabSchedule'))}</span>
                    </button>
                    <button type="button" class="btn btn-sm" data-action="open-drawer" data-id="${p.id}" data-drawer-tab="drive">
                      ${icons.folder()}<span>${esc(t('driveFoldersShort'))}</span>
                    </button>
                    <button type="button" class="btn btn-sm btn-icon btn-danger-outline" data-action="confirm-delete-page" data-id="${p.id}" data-name="${esc(p.name)}" aria-label="${esc(t('deleteBtn'))}">
                      ${icons.trash()}
                    </button>
                  </div>
                </div>

                <div class="directory-times-bar">
                  <span class="muted small-text ltr tabular">${slots.length}× · ±${Number(p.jitter_minutes || 0)}m</span>
                  ${
                    slots.length > 0
                      ? slots.map((s) => `<span class="time-token ltr tabular">${esc(formatTime12h(s))}</span>`).join('')
                      : `<span class="muted small-text">${esc(t('noSlotsShort'))}</span>`
                  }
                </div>
              </div>`;
          })
          .join('')}
      </div>
      ${renderPaginationBar(totalFiltered, pageNum, pageSize, 'pages', lang)}
    </section>
  `;
}

function renderScheduleVisualBar(slots, jitterMinutes, lang) {
  const jitter = Math.max(0, Number(jitterMinutes) || 0);
  const pins = (slots || [])
    .map((s) => {
      const m = minutesFromHHMM(s);
      if (m === null) return '';
      const pct = (m / 1440) * 100;
      const jPct = (jitter / 1440) * 100;
      const startPct = Math.max(0, pct - jPct);
      const widthPct = Math.min(100 - startPct, pct + jPct - startPct);
      return `
        ${jitter > 0 ? `<span class="sched-jitter" style="left:${startPct.toFixed(1)}%;width:${widthPct.toFixed(1)}%"></span>` : ''}
        <span class="sched-pin" style="left:${pct.toFixed(1)}%" title="${esc(formatTime12h(s))}"></span>
      `;
    })
    .join('');

  return `
    <div class="sched-visual-box">
      <div class="muted small-text">${esc(translate(lang, 'schedule24hBar'))}</div>
      <div class="sched-track ltr">${pins}</div>
      <div class="sched-hours ltr tabular"><span>12 AM</span><span>6 AM</span><span>12 PM</span><span>6 PM</span><span>12 AM</span></div>
    </div>
  `;
}

function renderStepper(id, label, value, min, max) {
  return `
    <div class="field">
      <label for="${esc(id)}">${esc(label)}</label>
      <div class="stepper ltr">
        <button type="button" class="stepper-btn" data-action="step" data-target="${esc(id)}" data-delta="-1" data-min="${min}" data-max="${max}" aria-label="Decrease ${esc(label)}">${icons.minus()}</button>
        <input id="${esc(id)}" type="number" min="${min}" max="${max}" class="input ltr tabular" value="${value}" />
        <button type="button" class="stepper-btn" data-action="step" data-target="${esc(id)}" data-delta="1" data-min="${min}" data-max="${max}" aria-label="Increase ${esc(label)}">${icons.plus()}</button>
      </div>
    </div>
  `;
}

export function renderPageDrawer(drawer, driveInfo, driveFolders, lang, busyMap) {
  if (!drawer) return '';
  const t = (k, v) => translate(lang, k, v);

  if (drawer.loading) {
    return `
      <div class="drawer-backdrop" data-action="close-drawer-backdrop">
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="Page details">
          <div class="drawer-header">
            <div class="skeleton-line w-40"></div>
            <button class="btn btn-icon" data-action="close-drawer" aria-label="${esc(t('closeBtn'))}">${icons.close()}</button>
          </div>
          <div class="drawer-body stack">
            <div class="skeleton-line w-80"></div>
            <div class="skeleton-line w-100" style="height:120px"></div>
          </div>
        </aside>
      </div>
    `;
  }

  const p = drawer.page;
  const folders = driveFolders || [];
  const capObj = folders.find((f) => f.id === p.captions_folder_id);
  const medObj = folders.find((f) => f.id === p.media_folder_id);
  const hasViewOnly = (capObj && !capObj.canEdit) || (medObj && !medObj.canEdit);
  const isCustomTz = !COMMON_TIMEZONES.includes(p.timezone);
  const saving = busyMap.has(`save:${p.id}`);
  const syncing = busyMap.has(`sync:${p.id}`);

  let tabContent = '';

  if (drawer.tab === 'schedule') {
    const effectiveCap = drawer.customCap ? p.daily_cap : Math.max(1, drawer.slots.length || 1);
    const summaryText = buildScheduleSummary(
      {
        slots: drawer.slots,
        jitter: p.jitter_minutes,
        dailyCap: effectiveCap,
        minGap: p.min_gap_minutes,
        rampEnabled: p.ramp_up_enabled,
        rampStart: p.ramp_start,
      },
      lang
    );

    const period = drawer.newSlotPeriod === 'AM' ? 'AM' : 'PM';
    const selHour = Number(drawer.newSlotHour || 8);
    const selMin = Number(drawer.newSlotMinute ?? 0);

    tabContent = `
      <form id="drawerScheduleForm" class="stack">
        ${drawer.formError ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(drawer.formError)}</span></div>` : ''}

        <div class="summary-pill" id="scheduleLiveSummary">
          ${icons.zap()}
          <span>${esc(summaryText)}</span>
        </div>

        ${renderScheduleVisualBar(drawer.slots, p.jitter_minutes, lang)}

        <div class="form-grid form-grid-2">
          <div class="field">
            <label for="editPageName">${esc(t('pageNameLabel'))}</label>
            <input id="editPageName" class="input" value="${esc(p.name)}" required />
          </div>
          <div class="field">
            <label for="editPageStatus">${esc(t('pageStatusLabel'))}</label>
            <select id="editPageStatus" class="select">
              <option value="active" ${p.status === 'active' ? 'selected' : ''}>${esc(t('status_active'))}</option>
              <option value="paused" ${p.status === 'paused' ? 'selected' : ''}>${esc(t('status_paused'))}</option>
            </select>
          </div>
        </div>

        <div class="form-grid form-grid-2">
          <div class="field">
            <label for="editTzSelect">${esc(t('timezoneLabel'))}</label>
            <select id="editTzSelect" class="select ltr">
              ${COMMON_TIMEZONES.map((tz) => `<option value="${esc(tz)}" ${p.timezone === tz ? 'selected' : ''}>${esc(tz)}</option>`).join('')}
              <option value="__custom__" ${isCustomTz ? 'selected' : ''}>${esc(t('customTzOption'))}</option>
            </select>
          </div>
          <div class="field" id="customTzWrap" style="${isCustomTz ? '' : 'display:none'}">
            <label for="editTzCustom">IANA Timezone</label>
            <input id="editTzCustom" class="input ltr" value="${esc(p.timezone)}" placeholder="Asia/Kabul" />
          </div>
        </div>

        <div class="field">
          <label>${esc(t('slotsLabel'))}</label>
          <div class="slot-chips">
            ${drawer.slots
              .map(
                (s, idx) => `
              <span class="slot-chip">
                <span class="ltr tabular">${esc(formatTime12h(s))}</span>
                <button type="button" data-action="remove-slot" data-idx="${idx}" aria-label="Remove ${esc(formatTime12h(s))}">×</button>
              </span>`
              )
              .join('')}
          </div>

          <div class="time12-builder ltr">
            <select id="newSlotHour" class="select time12-select" aria-label="${esc(t('hourLabel'))}">
              ${[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
                .map((h) => `<option value="${h}" ${selHour === h ? 'selected' : ''}>${h}</option>`)
                .join('')}
            </select>
            <span class="time12-colon">:</span>
            <select id="newSlotMinute" class="select time12-select" aria-label="${esc(t('minuteLabel'))}">
              ${Array.from({ length: 60 }, (_, m) => m)
                .map((m) => `<option value="${m}" ${selMin === m ? 'selected' : ''}>${String(m).padStart(2, '0')}</option>`)
                .join('')}
            </select>
            <div class="seg-group time12-ampm" role="group" aria-label="${esc(t('ampmLabel'))}">
              <button type="button" class="seg-btn ${period === 'AM' ? 'active' : ''}" data-action="set-slot-period" data-val="AM">AM</button>
              <button type="button" class="seg-btn ${period === 'PM' ? 'active' : ''}" data-action="set-slot-period" data-val="PM">PM</button>
            </div>
            <button type="button" id="addSlotBtn" class="btn btn-sm btn-primary">${icons.plus()}<span>${esc(t('addSlotBtn'))}</span></button>
          </div>

          <div class="row-start small-text muted" style="margin-top:4px">
            <span>${esc(t('scheduleQuickAdd'))}:</span>
            ${['07:00', '09:00', '12:00', '17:00', '20:00', '21:00']
              .filter((q) => !drawer.slots.includes(q))
              .map(
                (q) =>
                  `<button type="button" class="filter-chip ltr tabular" data-action="quick-add-slot" data-slot="${q}">+${esc(formatTime12h(q))}</button>`
              )
              .join('')}
          </div>
          ${drawer.slotError ? `<div class="field-error">${esc(drawer.slotError)}</div>` : ''}
        </div>

        <div class="field">
          <div class="row">
            <label for="editJitter">${esc(t('slotWindowLabel'))}</label>
            <div class="chip-row">
              ${[0, 5, 10, 15]
                .map(
                  (m) => `
                <button
                  type="button"
                  class="filter-chip ${Number(p.jitter_minutes) === m ? 'active' : ''}"
                  data-action="set-jitter"
                  data-val="${m}"
                >
                  ${m === 0 ? esc(t('exactTimeZero')) : `<span class="ltr tabular">±${m}m</span>`}
                </button>`
                )
                .join('')}
            </div>
          </div>
          ${renderStepper('editJitter', t('jitterLabel'), p.jitter_minutes, 0, 180)}
        </div>

        <details class="adv-panel" id="advSchedulePanel" ${drawer.advOpen ? 'open' : ''}>
          <summary class="adv-summary">${esc(t('advancedSettings'))}</summary>
          <div class="adv-body stack">
            <div class="muted small-text">${esc(t('unlimitedAutoCapHint'))}</div>
            <div class="form-grid form-grid-2">
              ${renderStepper('editDailyCap', t('dailyCapLabel'), effectiveCap, 1, 50)}
              ${renderStepper('editMinGap', t('minGapLabel'), p.min_gap_minutes, 0, 720)}
            </div>
            <div class="divider"></div>
            <label class="row-start" style="cursor:pointer">
              <input id="editRampEnabled" type="checkbox" ${p.ramp_up_enabled ? 'checked' : ''} />
              <strong>${esc(t('rampUpLabel'))}</strong>
            </label>
            <div class="form-grid form-grid-2">
              ${renderStepper('editRampStart', t('rampStartLabel'), p.ramp_start, 1, 50)}
              ${renderStepper('editRampStep', t('rampStepLabel'), p.ramp_step_days, 1, 30)}
            </div>
          </div>
        </details>

        <div class="row">
          <button type="submit" class="btn btn-primary" ${saving ? 'disabled' : ''}>
            ${saving ? icons.spinner() : icons.check()}
            <span>${esc(t('saveBtn'))}</span>
          </button>
          <button type="button" class="btn btn-danger-outline" data-action="confirm-delete-page" data-id="${p.id}" data-name="${esc(p.name)}">
            ${icons.trash()}
            <span>${esc(t('deleteBtn'))}</span>
          </button>
        </div>
      </form>
    `;
  } else if (drawer.tab === 'drive') {
    const driveMode = driveInfo?.mode || 'none';
    tabContent = `
      <div class="stack">
        ${
          driveMode === 'service_account'
            ? `<div class="stack-sm">
                <strong>${esc(t('driveStep1Title'))}</strong>
                <p class="muted small-text" style="margin:0">${esc(t('driveStep1Hint'))}</p>
                <div class="row-start">
                  <div class="code-box ltr" style="flex:1">${esc(driveInfo.serviceAccountEmail)}</div>
                  <button type="button" class="btn btn-sm" id="copySaEmailBtn">${icons.copy()}<span>${esc(t('copyEmailBtn'))}</span></button>
                </div>
              </div><div class="divider"></div>`
            : driveMode === 'none'
              ? `<div class="inline-alert inline-alert-warn">
                  ${icons.alertTriangle()}
                  <div class="row" style="flex:1">
                    <span>${esc(driveInfo?.error || t('googleNotConnected'))}</span>
                    ${driveInfo?.googleOAuthAvailable ? `<a href="/auth/google/start" class="btn btn-sm btn-primary">${icons.google()}<span>${esc(t('signInGoogleBtn'))}</span></a>` : ''}
                  </div>
                </div>`
              : ''
        }

        <div class="stack">
          <div class="row">
            <strong>${esc(t('driveStep2Title'))}</strong>
            <button type="button" class="btn btn-sm" id="loadFoldersBtn" ${drawer.driveFoldersLoading || !driveInfo?.configured ? 'disabled' : ''}>
              ${drawer.driveFoldersLoading ? icons.spinner() : icons.refresh()}
              <span>${esc(t('loadFoldersBtn'))}</span>
            </button>
          </div>
          ${drawer.driveError ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(drawer.driveError)}</span></div>` : ''}
          ${hasViewOnly ? `<div class="inline-alert inline-alert-warn">${icons.alertTriangle()}<span>${esc(t('viewOnlyWarning'))}</span></div>` : ''}

          <div class="field">
            <label for="editCaptionsFolder">${esc(t('captionsFolderLabel'))}</label>
            <select id="editCaptionsFolder" class="select">
              <option value="">${esc(t('selectFolderOption'))}</option>
              ${p.captions_folder_id && !capObj ? `<option value="${esc(p.captions_folder_id)}" selected>${esc(p.captions_folder_name || p.captions_folder_id)}</option>` : ''}
              ${folders.map((f) => `<option value="${esc(f.id)}" data-name="${esc(f.name)}" ${p.captions_folder_id === f.id ? 'selected' : ''}>${esc(f.name)}${f.canEdit ? '' : ' (View-only)'}</option>`).join('')}
            </select>
          </div>

          <div class="field">
            <label for="editMediaFolder">${esc(t('mediaFolderLabel'))}</label>
            <select id="editMediaFolder" class="select">
              <option value="">${esc(t('selectFolderOption'))}</option>
              ${p.media_folder_id && !medObj ? `<option value="${esc(p.media_folder_id)}" selected>${esc(p.media_folder_name || p.media_folder_id)}</option>` : ''}
              ${folders.map((f) => `<option value="${esc(f.id)}" data-name="${esc(f.name)}" ${p.media_folder_id === f.id ? 'selected' : ''}>${esc(f.name)}${f.canEdit ? '' : ' (View-only)'}</option>`).join('')}
            </select>
          </div>

          <div>
            <button type="button" id="saveDriveFoldersBtn" class="btn btn-primary" ${saving ? 'disabled' : ''}>
              ${saving ? icons.spinner() : icons.check()}
              <span>${esc(t('saveBtn'))}</span>
            </button>
          </div>
        </div>
      </div>
    `;
  } else if (drawer.tab === 'preview') {
    const pv = drawer.preview;
    tabContent = `
      <div class="stack">
        <div class="row">
          <strong>${esc(t('previewTitle'))}</strong>
          <div class="row-start">
            <button type="button" class="btn btn-sm" data-action="sync-page-drive" data-id="${p.id}" ${syncing ? 'disabled' : ''}>
              ${syncing ? icons.spinner() : icons.refresh()}
              <span>${esc(t('syncDriveBtn'))}</span>
            </button>
            <button type="button" class="btn btn-sm" id="refreshPreviewBtn" ${drawer.previewLoading ? 'disabled' : ''}>
              ${drawer.previewLoading ? icons.spinner() : icons.eye()}
              <span>${esc(t('runPreviewBtn'))}</span>
            </button>
          </div>
        </div>

        ${
          drawer.previewLoading
            ? `<div class="skeleton-line w-100" style="height:100px"></div>`
            : drawer.previewError
              ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(drawer.previewError)}</span></div>`
              : pv
                ? `
              <div class="inline-alert ${pv.ready ? 'inline-alert-success' : 'inline-alert-warn'}">
                ${pv.ready ? icons.checkCircle() : icons.alertTriangle()}
                <strong>${esc(pv.ready ? t('previewReady') : t('previewNotReady'))}</strong>
              </div>
              ${pv.warnings?.length ? `<div class="stack-sm"><strong>${esc(t('previewWarnings'))}</strong><ul class="clean-list muted small-text">${pv.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
              ${
                pv.pair
                  ? `<div class="stack-sm list-item-box">
                      <div><strong>${esc(t('previewFile'))}:</strong> <span class="ltr">${esc(pv.pair.fileName)}</span> · <span class="muted">${esc(pv.pair.mediaType)}, ${(pv.pair.sizeBytes / (1024 * 1024)).toFixed(2)} MB</span></div>
                      <div><strong>${esc(t('previewCaptionNum'))}:</strong> <span class="ltr">#${pv.pair.number}</span></div>
                      <div class="code-box" style="white-space:pre-wrap;font-family:inherit">${esc(pv.pair.captionText)}</div>
                    </div>`
                  : ''
              }
              ${pv.orphanFiles?.length ? `<div class="small-text"><strong>${esc(t('previewOrphanFiles'))}:</strong> <span class="ltr muted">${pv.orphanFiles.map((o) => esc(o.name)).join(', ')}</span></div>` : ''}
              ${pv.orphanCaptions?.length ? `<div class="small-text"><strong>${esc(t('previewOrphanCaptions'))}:</strong> <span class="ltr muted">${pv.orphanCaptions.map((c) => `#${c.number}`).join(', ')}</span></div>` : ''}
            `
                : ''
        }

        <div class="divider"></div>
        <div class="row">
          <strong>${esc(t('blockedModalTitle'))} (${drawer.blockedFiles.length})</strong>
          ${drawer.blockedFiles.length > 0 ? `<button type="button" class="btn btn-sm" id="drawerUnblockAllBtn">${esc(t('unblockAllBtn'))}</button>` : ''}
        </div>
        ${
          drawer.blockedFiles.length === 0
            ? `<div class="muted small-text">${esc(t('noBlockedFiles'))}</div>`
            : `<div class="flat-list">${drawer.blockedFiles
                .map(
                  (f) => `
                  <div class="flat-row">
                    <div class="min-w-0">
                      <strong class="ltr">${esc(f.file_name)}</strong>
                      <div class="muted small-text">${esc(f.reason || '')}</div>
                    </div>
                    <button type="button" class="btn btn-sm" data-action="unblock-one" data-file-id="${esc(f.file_id)}">${esc(t('unblockOneBtn'))}</button>
                  </div>`
                )
                .join('')}</div>`
        }
      </div>
    `;
  } else if (drawer.tab === 'history') {
    const plans = drawer.recentPlans || [];
    const evs = drawer.recentEvents || [];
    tabContent = `
      <div class="stack">
        <div class="row">
          <strong>${esc(t('recentPlansTitle'))}</strong>
          <button type="button" class="btn btn-sm" data-action="retry-failed" data-id="${p.id}">
            ${icons.refresh()}<span>${esc(t('retryFailed'))}</span>
          </button>
        </div>
        ${
          plans.length === 0
            ? `<div class="muted small-text">${esc(t('noHistoryYet'))}</div>`
            : `<div class="flat-list">${plans
                .map((r) => {
                  const st = r.status === 'pending' && Number(r.attempts) > 0 ? 'retrying' : r.status;
                  const lbl = st === 'retrying' ? `${t('slot_retrying')} (${r.attempts}/5)` : t(`slot_${r.status}`);
                  return `
                    <div class="flat-row">
                      <div class="min-w-0">
                        <div class="row-start">
                          <span class="ltr tabular"><strong>${esc(r.local_date)} · ${esc(formatTime12h(r.planned_local))}</strong></span>
                          ${renderStatusBadge(st, lbl)}
                        </div>
                        ${r.file_name ? `<div class="muted small-text ltr">${esc(r.file_name)}</div>` : ''}
                        ${r.error ? `<div class="field-error">${esc(r.error)}</div>` : ''}
                      </div>
                      <span class="muted small-text" title="${esc(formatExactUtc(r.finished_at || r.planned_utc))}">
                        ${esc(formatRelativeTime(r.finished_at || r.planned_utc, lang))}
                      </span>
                    </div>`;
                })
                .join('')}</div>`
        }

        <div class="divider"></div>
        <strong>${esc(t('recentEventsTitle'))}</strong>
        ${
          evs.length === 0
            ? `<div class="muted small-text">${esc(t('noHistoryYet'))}</div>`
            : `<div class="flat-list">${evs
                .map(
                  (ev) => `
                  <div class="flat-row-col">
                    <div class="row">
                      ${renderStatusBadge(ev.level, t(`level_${ev.level}`))}
                      <span class="muted small-text" title="${esc(formatExactUtc(ev.created_at))}">${esc(formatRelativeTime(ev.created_at, lang))}</span>
                    </div>
                    <div style="word-break:break-word">${esc(ev.message)}</div>
                  </div>`
                )
                .join('')}</div>`
        }
      </div>
    `;
  }

  return `
    <div class="drawer-backdrop" data-action="close-drawer-backdrop">
      <aside class="drawer" role="dialog" aria-modal="true" aria-label="${esc(p.name)}">
        <div class="drawer-header">
          <div class="row-start">
            ${renderAvatar(p.name, p.picture_url, 40)}
            <div>
              <h2 class="drawer-title">${esc(p.name)}</h2>
              <div class="muted small-text">${esc(p.account_name)} · <span class="ltr">${esc(p.timezone)}</span></div>
            </div>
          </div>
          <button class="btn btn-icon" data-action="close-drawer" aria-label="${esc(t('closeBtn'))}">${icons.close()}</button>
        </div>
        <div class="drawer-tabs" role="tablist">
          ${['schedule', 'drive', 'preview', 'history']
            .map(
              (tabId) => `
              <button
                type="button"
                role="tab"
                aria-selected="${drawer.tab === tabId ? 'true' : 'false'}"
                class="drawer-tab ${drawer.tab === tabId ? 'active' : ''}"
                data-action="switch-drawer-tab"
                data-tab="${tabId}"
              >
                ${esc(t(`drawerTab${tabId.charAt(0).toUpperCase() + tabId.slice(1)}`))}
              </button>`
            )
            .join('')}
        </div>
        <div class="drawer-body">${tabContent}</div>
      </aside>
    </div>
  `;
}

export function renderPostsView(state, lang, busyMap) {
  const t = (k) => translate(lang, k);
  const { pages } = state.dashboard;
  const f = state.postFilters || { status: '', pageId: '' };
  const syncingAll = busyMap.has('sync-all-posts');

  const allPosts = state.posts || [];
  const filtered = allPosts.filter((item) => {
    if (f.pageId && String(item.page_id) !== f.pageId) return false;
    if (f.status === 'pending' && item.status !== 'pending' && item.status !== 'posting') return false;
    if (f.status === 'posted' && item.status !== 'posted') return false;
    if (f.status === 'failed' && item.status !== 'failed' && item.status !== 'skipped' && item.status !== 'missed') {
      return false;
    }
    return true;
  });

  const pageSize = 25;
  const curPage = Math.max(1, Math.min(Number(state.postsPageNum || 1), Math.max(1, Math.ceil(filtered.length / pageSize))));
  const slice = filtered.slice((curPage - 1) * pageSize, curPage * pageSize);

  const pendingCnt = allPosts.filter((i) => i.status === 'pending' || i.status === 'posting').length;
  const postedCnt = allPosts.filter((i) => i.status === 'posted').length;
  const failedCnt = allPosts.filter((i) => i.status === 'failed' || i.status === 'skipped' || i.status === 'missed').length;

  return `
    <div class="stack">
      <div class="card stack-sm">
        <div class="row">
          <div>
            <h2 class="section-title">${esc(t('postsTitle'))}</h2>
            <p class="muted small-text" style="margin:4px 0 0">${esc(t('postsSubtitle'))}</p>
          </div>
          <button type="button" id="syncAllPostsBtn" class="btn btn-primary" ${syncingAll ? 'disabled' : ''}>
            ${syncingAll ? icons.spinner() : icons.refresh()}
            <span>${esc(t('syncAllDriveBtn'))}</span>
          </button>
        </div>

        <div class="row">
          <div class="seg-group" role="tablist" aria-label="${esc(t('postsTitle'))}">
            ${[
              { id: '', label: `${t('postsFilterAll')} (${allPosts.length})` },
              { id: 'pending', label: `${t('postsFilterPending')} (${pendingCnt})` },
              { id: 'posted', label: `${t('postsFilterPosted')} (${postedCnt})` },
              { id: 'failed', label: `${t('postsFilterFailed')} (${failedCnt})` },
            ]
              .map(
                (tab) => `
              <button
                type="button"
                role="tab"
                aria-selected="${f.status === tab.id ? 'true' : 'false'}"
                class="seg-btn ${f.status === tab.id ? 'active' : ''}"
                data-action="set-post-status"
                data-val="${tab.id}"
              >
                <span class="tabular">${esc(tab.label)}</span>
              </button>`
              )
              .join('')}
          </div>

          <select id="postFilterPage" class="select" style="width:auto;min-width:190px" aria-label="${esc(t('filterPage'))}">
            <option value="">${esc(t('allPages'))}</option>
            ${pages.map((p) => `<option value="${p.id}" ${f.pageId === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
          </select>
        </div>
      </div>

      <section class="card table-card">
        ${
          filtered.length === 0
            ? `<div class="empty-state">
                ${illustrations.noPages()}
                <h3>${esc(t('postsEmptyTitle'))}</h3>
                <p class="muted" style="max-width:440px;margin:0">${esc(t('postsEmptyHint'))}</p>
              </div>`
            : `<div class="posts-feed">
                ${slice
                  .map((post) => {
                    const st = post.status === 'pending' && Number(post.attempts) > 0 ? 'retrying' : post.status;
                    const stLbl =
                      st === 'retrying' ? `${t('slot_retrying')} (${post.attempts}/5)` : t(`slot_${post.status}`);
                    const rel = formatRelativeTime(post.finished_at || post.planned_utc, lang);
                    const time12 = formatTime12h(post.planned_local);
                    return `
                      <div class="post-feed-row">
                        <div class="post-feed-page">
                          ${renderAvatar(post.page_name, post.page_picture_url, 36)}
                          <div class="min-w-0">
                            <div class="post-feed-page-name">${esc(post.page_name)}</div>
                            <div class="muted small-text ltr tabular">
                              ${esc(post.local_date)} · ${esc(time12)}${rel ? ` · ${esc(rel)}` : ''}
                            </div>
                          </div>
                        </div>

                        <div class="post-feed-media">
                          ${
                            post.file_name
                              ? `<div class="post-feed-filename ltr">${esc(post.file_name)}${post.caption_number != null ? ` · #${post.caption_number}` : ''}</div>`
                              : `<div class="muted small-text">${esc(t('slotNoFileYet'))}</div>`
                          }
                          ${
                            post.caption_preview
                              ? `<div class="muted small-text post-feed-caption">${esc(post.caption_preview)}${post.caption_preview.length >= 200 ? '…' : ''}</div>`
                              : ''
                          }
                          ${post.error ? `<div class="field-error">${esc(post.error)}</div>` : ''}
                        </div>

                        <div class="post-feed-actions">
                          ${renderStatusBadge(st, stLbl)}
                        </div>
                      </div>`;
                  })
                  .join('')}
              </div>
              ${renderPaginationBar(filtered.length, curPage, pageSize, 'posts', lang)}`
        }
      </section>
    </div>
  `;
}

function renderGoogleDriveCard(driveInfo, busyMap, lang) {
  const t = (k) => translate(lang, k);
  const mode = driveInfo?.mode || 'none';
  const disconnecting = busyMap.has('disconnect-google');

  return `
    <section class="card connection-card">
      <div class="stack-sm">
        <div class="row">
          <div class="row-start">
            <span class="conn-icon-inline">${icons.google()}</span>
            <h2 class="section-title">${esc(t('googleDriveTitle'))}</h2>
          </div>
          ${
            mode === 'oauth'
              ? renderStatusBadge('active', driveInfo.googleEmail || 'Connected')
              : mode === 'service_account'
                ? renderStatusBadge('info', 'Service Account')
                : renderStatusBadge('warn', t('googleNotConnected'))
          }
        </div>
        <p class="muted small-text" style="margin:0">${esc(t('googleDriveDesc'))}</p>
      </div>

      ${
        mode === 'oauth'
          ? `<div class="conn-card-foot row-start">
               ${
                 driveInfo.googleOAuthAvailable
                   ? `<a href="/auth/google/start" class="btn btn-sm">${icons.google()}<span>${esc(t('switchGoogleBtn'))}</span></a>`
                   : ''
               }
               <button type="button" class="btn btn-sm btn-danger-outline" data-action="confirm-disconnect-google" ${disconnecting ? 'disabled' : ''}>
                 ${disconnecting ? icons.spinner() : icons.trash()}
                 <span>${esc(t('disconnectGoogleBtn'))}</span>
               </button>
             </div>`
          : mode === 'service_account'
            ? `<div class="conn-card-foot stack-sm">
                 <div class="code-box ltr">${esc(driveInfo.serviceAccountEmail)}</div>
                 ${
                   driveInfo.googleOAuthAvailable
                     ? `<div><a href="/auth/google/start" class="btn btn-sm btn-primary">${icons.google()}<span>${esc(t('signInGoogleBtn'))}</span></a></div>`
                     : ''
                 }
               </div>`
            : `<div class="conn-card-foot">
                 ${
                   driveInfo?.googleOAuthAvailable
                     ? `<a href="/auth/google/start" class="btn btn-sm btn-primary">${icons.google()}<span>${esc(t('signInGoogleBtn'))}</span></a>`
                     : `<span class="muted small-text">${esc(t('googleNotConfiguredMsg'))}</span>`
                 }
               </div>`
      }
    </section>
  `;
}

export function renderAccountsView(state, lang, busyMap) {
  const t = (k) => translate(lang, k);
  const addingManual = busyMap.has('manual-account');
  const tokenMode = state.tokenMode === 'page' ? 'page' : 'user';

  return `
    <div class="stack">
      ${state.googleBanner ? `<div class="inline-alert inline-alert-success">${icons.checkCircle()}<span>${esc(state.googleBanner)}</span></div>` : ''}
      ${state.googleError ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(state.googleError)}</span></div>` : ''}
      ${state.fbOAuthBanner ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(state.fbOAuthBanner)}</span></div>` : ''}

      <div class="connections-grid">
        ${renderGoogleDriveCard(state.driveInfo, busyMap, lang)}

        <section class="card connection-card">
          <div class="stack-sm">
            <h2 class="section-title">${esc(t('fbConnectTitle'))}</h2>

            <div class="seg-group seg-group-2col" role="tablist" aria-label="${esc(t('fbConnectTitle'))}">
              <button
                type="button"
                role="tab"
                aria-selected="${tokenMode === 'user' ? 'true' : 'false'}"
                class="seg-btn ${tokenMode === 'user' ? 'active' : ''}"
                data-action="set-token-mode"
                data-val="user"
              >
                ${icons.accounts()}<span>${esc(t('fbModeUser'))}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected="${tokenMode === 'page' ? 'true' : 'false'}"
                class="seg-btn ${tokenMode === 'page' ? 'active' : ''}"
                data-action="set-token-mode"
                data-val="page"
              >
                ${icons.pages()}<span>${esc(t('fbModePage'))}</span>
              </button>
            </div>

            <div class="muted small-text">
              ${esc(tokenMode === 'page' ? t('fbModePageHint') : t('fbModeUserHint'))}
            </div>
          </div>

          <form id="manualTokenForm" class="conn-card-foot stack-sm">
            <div class="row-start">
              <input
                id="manualTokenInput"
                type="password"
                class="input ltr"
                style="flex:1;min-width:180px"
                placeholder="${esc(tokenMode === 'page' ? t('fbPageTokenPlaceholder') : t('fbUserTokenPlaceholder'))}"
              />
              <button type="submit" class="btn btn-primary" ${addingManual ? 'disabled' : ''}>
                ${addingManual ? icons.spinner() : icons.plus()}
                <span>${esc(tokenMode === 'page' ? t('connectPageDirectBtn') : t('addManualTokenBtn'))}</span>
              </button>
            </div>
            ${state.manualTokenError ? `<div class="field-error">${esc(state.manualTokenError)}</div>` : ''}
          </form>
        </section>
      </div>

      <section class="card table-card">
        <div class="table-head-bar">
          <h3 class="section-title" style="font-size:var(--text-base)">${esc(t('connectedAccountsTitle'))} <span class="muted tabular">(${state.accounts.length})</span></h3>
        </div>
        ${
          state.accounts.length === 0
            ? `<div class="empty-state">
                ${illustrations.noPages()}
                <h3>${esc(t('noAccountsYet'))}</h3>
                <p class="muted">${esc(t('noAccountsHint'))}</p>
              </div>`
            : `<div class="flat-list" style="border:none;border-radius:0">
                ${state.accounts
                  .map((a) => {
                    const isPageDirect = a.token_kind === 'page_direct';
                    return `
                  <div class="flat-row">
                    <div class="row-start min-w-0">
                      ${renderAvatar(a.name, '', 36)}
                      <div class="min-w-0">
                        <strong style="font-size:14px">${esc(a.name)}</strong>
                        <div class="muted small-text ltr tabular">
                          ${esc(t(isPageDirect ? 'pageDirectBadge' : 'userTokenBadge'))} · ${esc(t('connectedPagesCount'))}: ${a.page_count}${a.token_expires_at ? ` · ${esc(t('tokenExpires'))}: ${esc(formatRelativeTime(a.token_expires_at, lang))}` : ''}
                        </div>
                        ${a.last_error ? `<div class="field-error small-text">${esc(a.last_error)}</div>` : ''}
                      </div>
                    </div>
                    <div class="row-start">
                      ${renderStatusBadge(a.status, t(`status_${a.status}`))}
                      ${
                        isPageDirect
                          ? `<button class="btn btn-sm btn-primary" data-action="prepare-update-token" data-mode="page">${icons.key()}<span>${esc(t('updateTokenBtn'))}</span></button>`
                          : `<button class="btn btn-sm btn-primary" data-action="select-pages" data-id="${a.id}">${icons.pages()}<span>${esc(t('selectPagesBtn'))}</span></button>`
                      }
                      <button class="btn btn-sm" data-action="check-account" data-id="${a.id}">${icons.shield()}<span>${esc(t('checkTokenBtn'))}</span></button>
                      <button class="btn btn-sm btn-icon btn-danger-outline" data-action="confirm-delete-account" data-id="${a.id}" data-name="${esc(a.name)}" aria-label="${esc(t('deleteBtn'))}">${icons.trash()}</button>
                    </div>
                  </div>`;
                  })
                  .join('')}
              </div>`
        }
      </section>
    </div>
  `;
}

export function renderLicensesView(state, lang, busyMap) {
  const t = (k) => translate(lang, k);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const creating = busyMap.has('create-license');

  return `
    <div class="stack">
      <section class="card stack">
        <div>
          <h2 class="section-title">${esc(t('licensesTitle'))}</h2>
          <p class="muted small-text" style="margin:4px 0 0">${esc(t('licensesDesc'))}</p>
        </div>

        <form id="createLicenseForm" class="form-grid form-grid-3" style="align-items:end">
          <div class="field">
            <label for="licLabelInput">${esc(t('licLabelInput'))}</label>
            <input id="licLabelInput" class="input" maxlength="120" placeholder="${esc(t('licLabelPlaceholder'))}" />
          </div>
          <div class="field">
            <label for="licMaxPagesInput">${esc(t('licMaxPagesLabel'))}</label>
            <input id="licMaxPagesInput" type="number" min="1" max="500" class="input ltr tabular" value="20" />
          </div>
          <div class="field">
            <label for="licExpirySelect">${esc(t('licExpiryLabel'))}</label>
            <select id="licExpirySelect" class="select">
              <option value="0" selected>${esc(t('licNeverExpires'))}</option>
              <option value="30">${esc(t('licDays30'))}</option>
              <option value="90">${esc(t('licDays90'))}</option>
              <option value="365">${esc(t('licDays365'))}</option>
            </select>
          </div>
          <div>
            <button type="submit" class="btn btn-primary" ${creating ? 'disabled' : ''}>
              ${creating ? icons.spinner() : icons.key()}
              <span>${esc(t('createLicenseBtn'))}</span>
            </button>
          </div>
        </form>

        ${
          state.createdLicenseKey
            ? `<div class="stack-sm list-item-box" style="border-color:var(--accent-1)">
                <div class="row">
                  <strong>${esc(t('licCreatedTitle'))}</strong>
                  <button type="button" class="btn btn-sm btn-ghost" id="dismissCreatedKeyBtn" aria-label="${esc(t('closeBtn'))}">${icons.close()}</button>
                </div>
                <div class="code-box ltr" style="font-size:15px;font-weight:700">${esc(state.createdLicenseKey)}</div>
                <div class="row-start">
                  <button type="button" class="btn btn-sm btn-primary ${state.licenseKeyCopied ? 'is-copied' : ''}" id="copyCreatedKeyBtn">
                    ${state.licenseKeyCopied ? icons.check() : icons.copy()}
                    <span>${esc(state.licenseKeyCopied ? t('copiedMsg') : t('copyKeyBtn'))}</span>
                  </button>
                  ${canShare ? `<button type="button" class="btn btn-sm" id="shareCreatedKeyBtn">${icons.share()}<span>${esc(t('shareKeyBtn'))}</span></button>` : ''}
                </div>
              </div>`
            : ''
        }
      </section>

      <section class="card table-card">
        ${
          state.licenses.length === 0
            ? `<div class="empty-state">${illustrations.noPages()}<p class="muted">${esc(t('licensesEmpty'))}</p></div>`
            : `<div class="sticky-table-wrap">
                <table class="responsive-table">
                  <thead>
                    <tr>
                      <th>${esc(t('licColCustomer'))}</th>
                      <th>${esc(t('licColStatus'))}</th>
                      <th>${esc(t('licColUsage'))}</th>
                      <th>${esc(t('licColDrive'))}</th>
                      <th>${esc(t('licColExpires'))}</th>
                      <th>${esc(t('licColActions'))}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${state.licenses
                      .map((lic) => {
                        const isActive = lic.status === 'active';
                        return `
                        <tr>
                          <td data-label="${esc(t('licColCustomer'))}">
                            <div><strong>${esc(lic.label || `#${lic.id}`)}</strong></div>
                            <div class="muted small-text ltr">${esc(lic.key_prefix)}</div>
                          </td>
                          <td data-label="${esc(t('licColStatus'))}">${renderStatusBadge(lic.status, t(`status_${lic.status}`))}</td>
                          <td data-label="${esc(t('licColUsage'))}" class="ltr tabular"><strong>${Number(lic.page_count || 0)}</strong> / ${Number(lic.max_pages || 20)}</td>
                          <td data-label="${esc(t('licColDrive'))}">${lic.google_email ? `<span class="ltr small-text">${esc(lic.google_email)}</span>` : '<span class="muted">-</span>'}</td>
                          <td data-label="${esc(t('licColExpires'))}" title="${esc(lic.expires_at ? formatExactUtc(lic.expires_at) : '')}">
                            ${lic.expires_at ? esc(formatRelativeTime(lic.expires_at, lang)) : `<span class="muted">${esc(t('licNeverExpires'))}</span>`}
                          </td>
                          <td data-label="${esc(t('licColActions'))}">
                            <div class="row-start">
                              <button class="btn btn-sm" data-action="toggle-license" data-id="${lic.id}" data-status="${esc(lic.status)}">
                                ${esc(t(isActive ? 'disableBtn' : 'enableBtn'))}
                              </button>
                              <button class="btn btn-sm" data-action="extend-license" data-id="${lic.id}">
                                ${esc(t('extend30Btn'))}
                              </button>
                              <button class="btn btn-sm btn-danger-outline" data-action="confirm-delete-license" data-id="${lic.id}" data-name="${esc(lic.label || lic.key_prefix)}">
                                ${icons.trash()}
                              </button>
                            </div>
                          </td>
                        </tr>`;
                      })
                      .join('')}
                  </tbody>
                </table>
              </div>`
        }
      </section>
    </div>
  `;
}

export function renderLogsView(state, lang) {
  const t = (k) => translate(lang, k);
  const { pages } = state.dashboard;
  const f = state.eventFilters;

  return `
    <div class="stack">
      <div class="card stack-sm" style="position:sticky;top:64px;z-index:10">
        <div class="form-grid form-grid-3">
          <div class="field">
            <label for="logFilterPage">${esc(t('filterPage'))}</label>
            <select id="logFilterPage" class="select">
              <option value="">${esc(t('allPages'))}</option>
              ${pages.map((p) => `<option value="${p.id}" ${f.pageId === String(p.id) ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label for="logFilterLevel">${esc(t('filterLevel'))}</label>
            <select id="logFilterLevel" class="select">
              <option value="">${esc(t('allLevels'))}</option>
              <option value="info" ${f.level === 'info' ? 'selected' : ''}>${esc(t('level_info'))}</option>
              <option value="warn" ${f.level === 'warn' ? 'selected' : ''}>${esc(t('level_warn'))}</option>
              <option value="error" ${f.level === 'error' ? 'selected' : ''}>${esc(t('level_error'))}</option>
            </select>
          </div>
          <div class="field">
            <label for="logFilterDate">${esc(t('filterDate'))}</label>
            <input id="logFilterDate" type="date" class="input ltr" value="${esc(f.date)}" />
          </div>
        </div>
        <div class="muted small-text">${esc(t('retentionNote7d'))}</div>
      </div>

      <div class="card table-card">
        ${
          state.events.length === 0
            ? `<div class="empty-state">${illustrations.noLogs()}<p class="muted">${esc(t('noLogsFound'))}</p></div>`
            : `<div class="sticky-table-wrap">
                <table class="responsive-table">
                  <thead>
                    <tr>
                      <th>${esc(t('logColTime'))}</th>
                      <th>${esc(t('filterPage'))}</th>
                      <th>${esc(t('filterLevel'))}</th>
                      <th>${esc(t('logColEvent'))}</th>
                      <th>${esc(t('logColMessage'))}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${state.events
                      .map(
                        (ev) => `
                        <tr>
                          <td data-label="${esc(t('logColTime'))}" title="${esc(formatExactUtc(ev.created_at))}">${esc(formatRelativeTime(ev.created_at, lang))}</td>
                          <td data-label="${esc(t('filterPage'))}">${esc(ev.page_name || '-')}</td>
                          <td data-label="${esc(t('filterLevel'))}">${renderStatusBadge(ev.level, t(`level_${ev.level}`))}</td>
                          <td data-label="${esc(t('logColEvent'))}" class="ltr small-text">${esc(ev.event_type)}</td>
                          <td data-label="${esc(t('logColMessage'))}" style="word-break:break-word">${esc(ev.message)}</td>
                        </tr>`
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>`
        }
      </div>
    </div>
  `;
}

export function renderSettingsView(state, lang) {
  const t = (k) => translate(lang, k);
  return `
    <div class="stack">
      <section class="card stack">
        <div>
          <h2 class="section-title">${esc(t('settingsAppearanceTitle'))}</h2>
          <p class="muted small-text" style="margin:4px 0 0">${esc(t('settingsAppearanceDesc'))}</p>
        </div>

        <div class="field">
          <label>${esc(t('settingsThemeLabel'))}</label>
          <div class="seg-group" role="group" aria-label="${esc(t('settingsThemeLabel'))}">
            <button type="button" class="seg-btn ${state.theme === 'system' ? 'active' : ''}" data-action="set-theme" data-val="system">${icons.monitor()}<span>${esc(t('themeSystem'))}</span></button>
            <button type="button" class="seg-btn ${state.theme === 'dark' ? 'active' : ''}" data-action="set-theme" data-val="dark">${icons.moon()}<span>${esc(t('themeDark'))}</span></button>
            <button type="button" class="seg-btn ${state.theme === 'light' ? 'active' : ''}" data-action="set-theme" data-val="light">${icons.sun()}<span>${esc(t('themeLight'))}</span></button>
          </div>
        </div>

        <div class="field">
          <label>${esc(t('settingsDensityLabel'))}</label>
          <div class="seg-group" role="group" aria-label="${esc(t('settingsDensityLabel'))}">
            <button type="button" class="seg-btn ${state.density === 'comfortable' ? 'active' : ''}" data-action="set-density" data-val="comfortable">${esc(t('densityComfortable'))}</button>
            <button type="button" class="seg-btn ${state.density === 'compact' ? 'active' : ''}" data-action="set-density" data-val="compact">${esc(t('densityCompact'))}</button>
          </div>
        </div>

        <div class="field">
          <label>${esc(t('settingsAccentLabel'))}</label>
          <div class="accent-grid">
            ${ACCENT_PRESETS.map(
              (a) => `
              <button type="button" class="accent-card ${state.accent === a.id ? 'active' : ''}" data-action="set-accent" data-val="${a.id}">
                <span class="accent-swatch" style="background:linear-gradient(135deg,${a.c1},${a.c2})"></span>
                <span>${esc(t(`accent_${a.id}`))}</span>
              </button>`
            ).join('')}
          </div>
        </div>
      </section>

      <section class="card row">
        <div>
          <h2 class="section-title">${esc(t('settingsLangTitle'))}</h2>
          <p class="muted small-text" style="margin:4px 0 0">${esc(t('settingsLangDesc'))}</p>
        </div>
        <button type="button" class="btn btn-primary" id="settingsLangBtn">${icons.globe()}<span>${esc(t('langToggle'))}</span></button>
      </section>
    </div>
  `;
}

export function renderCommandPalette(palette, pages, globalPause, lang, isAdmin = false) {
  if (!palette?.open) return '';
  const t = (k) => translate(lang, k);
  const q = (palette.query || '').trim().toLowerCase();

  const actions = [
    { id: 'cmd-posts', label: t('goToPostsAction'), icon: icons.posts() },
    { id: 'cmd-pause', label: globalPause ? t('resumeAllBtn') : t('pauseAllBtn'), icon: globalPause ? icons.play() : icons.pause() },
    ...(isAdmin ? [{ id: 'cmd-licenses', label: t('createLicenseAction'), icon: icons.key() }] : []),
    { id: 'cmd-add-page', label: t('addPageAction'), icon: icons.pages() },
    { id: 'cmd-logs', label: t('goToLogsAction'), icon: icons.logs() },
    { id: 'cmd-settings', label: t('navSettings'), icon: icons.settings() },
  ].filter((a) => !q || a.label.toLowerCase().includes(q));

  const matchedPages = pages
    .filter((p) => !q || p.name.toLowerCase().includes(q) || String(p.fb_page_id).includes(q))
    .slice(0, 8);

  return `
    <div class="palette-backdrop" data-action="close-palette-backdrop">
      <div class="palette-box" role="dialog" aria-modal="true" aria-label="${esc(t('cmdButtonLabel'))}">
        <div class="palette-head">
          ${icons.search()}
          <input id="paletteInput" class="palette-input" type="search" placeholder="${esc(t('cmdPlaceholder'))}" value="${esc(palette.query)}" autofocus />
          <span class="kbd ltr">Esc</span>
        </div>
        <div class="palette-list">
          ${
            actions.length === 0 && matchedPages.length === 0
              ? `<div class="muted small-text" style="padding:16px;text-align:center">${esc(t('cmdNoResults'))}</div>`
              : ''
          }
          ${
            actions.length > 0
              ? `<div class="palette-group">${esc(t('cmdSectionActions'))}</div>
                 ${actions
                   .map(
                     (a) => `
                   <button type="button" class="palette-item" data-action="run-palette-action" data-cmd="${a.id}">
                     <span class="row-start">${a.icon}<span>${esc(a.label)}</span></span>
                     ${icons.chevronEnd()}
                   </button>`
                   )
                   .join('')}`
              : ''
          }
          ${
            matchedPages.length > 0
              ? `<div class="palette-group">${esc(t('cmdSectionPages'))}</div>
                 ${matchedPages
                   .map(
                     (p) => `
                   <button type="button" class="palette-item" data-action="open-drawer" data-id="${p.id}" data-drawer-tab="schedule">
                     <span class="row-start">
                       ${renderAvatar(p.name, p.picture_url, 26)}
                       <span>${esc(p.name)}</span>
                     </span>
                     ${renderStatusBadge(p.status, t(`status_${p.status}`))}
                   </button>`
                   )
                   .join('')}`
              : ''
          }
        </div>
      </div>
    </div>
  `;
}

export function renderQuickActionsSheet(open, globalPause, lang, isAdmin = false) {
  if (!open) return '';
  const t = (k) => translate(lang, k);
  return `
    <div class="modal-backdrop" data-action="close-quick-backdrop">
      <div class="modal-card stack" role="dialog" aria-modal="true" aria-label="${esc(t('quickActionsLabel'))}">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="row">
          <h3 style="margin:0">${esc(t('quickActionsLabel'))}</h3>
          <button class="btn btn-icon" data-action="close-quick" aria-label="${esc(t('closeBtn'))}">${icons.close()}</button>
        </div>
        <button type="button" class="btn btn-primary" data-action="run-palette-action" data-cmd="cmd-posts">
          ${icons.posts()}<span>${esc(t('goToPostsAction'))}</span>
        </button>
        <button type="button" class="btn ${globalPause ? 'btn-primary' : 'btn-danger-outline'}" data-action="run-palette-action" data-cmd="cmd-pause">
          ${globalPause ? icons.play() : icons.pause()}
          <span>${esc(globalPause ? t('resumeAllBtn') : t('pauseAllBtn'))}</span>
        </button>
        ${
          isAdmin
            ? `<button type="button" class="btn" data-action="run-palette-action" data-cmd="cmd-licenses">
                ${icons.key()}<span>${esc(t('navLicenses'))}</span>
              </button>`
            : ''
        }
        <button type="button" class="btn" data-action="run-palette-action" data-cmd="cmd-logs">
          ${icons.logs()}<span>${esc(t('goToLogsAction'))}</span>
        </button>
        <button type="button" class="btn" data-action="run-palette-action" data-cmd="cmd-settings">
          ${icons.settings()}<span>${esc(t('navSettings'))}</span>
        </button>
      </div>
    </div>
  `;
}

export function renderConfirmModal(confirmState, lang) {
  if (!confirmState) return '';
  const t = (k) => translate(lang, k);
  return `
    <div class="modal-backdrop">
      <div class="modal-card stack" role="dialog" aria-modal="true" aria-labelledby="confirmTitle">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="row">
          <h3 id="confirmTitle" style="margin:0">${esc(confirmState.title)}</h3>
          <button class="btn btn-icon" data-action="close-confirm" aria-label="${esc(t('closeBtn'))}">${icons.close()}</button>
        </div>
        <p class="muted" style="margin:0">${esc(confirmState.message)}</p>
        <div class="row-start">
          <button id="confirmOkBtn" class="btn ${confirmState.danger ? 'btn-danger' : 'btn-primary'}">${esc(t('confirmBtn'))}</button>
          <button class="btn" data-action="close-confirm">${esc(t('cancelBtn'))}</button>
        </div>
      </div>
    </div>
  `;
}

export function renderPickPagesModal(modal, lang) {
  if (!modal || modal.type !== 'pickPages') return '';
  const t = (k) => translate(lang, k);
  return `
    <div class="modal-backdrop">
      <div class="modal-card stack" role="dialog" aria-modal="true" aria-labelledby="pickPagesTitle">
        <div class="sheet-handle" aria-hidden="true"></div>
        <div class="row">
          <h3 id="pickPagesTitle" style="margin:0">${esc(t('pickPagesTitle'))}</h3>
          <button class="btn btn-icon" data-action="close-modal" aria-label="${esc(t('closeBtn'))}">${icons.close()}</button>
        </div>
        ${
          modal.loading
            ? `<div class="skeleton-line w-100" style="height:80px"></div>`
            : modal.error
              ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(modal.error)}</span></div>`
              : `
            <p class="muted small-text" style="margin:0">${esc(t('pickPagesHint'))}</p>
            <div class="stack-sm">
              ${modal.pages
                .map(
                  (p) => `
                  <label class="checkbox-row">
                    <input type="checkbox" class="pick-page-cb" value="${esc(p.fb_page_id)}" ${modal.selected.has(p.fb_page_id) ? 'checked' : ''} />
                    ${renderAvatar(p.name, p.picture_url, 30)}
                    <span style="flex:1;min-width:0"><strong>${esc(p.name)}</strong> <span class="muted ltr small-text">· ${esc(p.fb_page_id)}</span></span>
                    ${p.alreadyAdded ? `<span class="muted small-text">${esc(t('alreadyAdded'))}</span>` : ''}
                  </label>`
                )
                .join('')}
            </div>
            <div class="row-start">
              <button id="savePickedPagesBtn" class="btn btn-primary">${esc(t('addSelectedPagesBtn'))}</button>
              <button class="btn" data-action="close-modal">${esc(t('cancelBtn'))}</button>
            </div>`
        }
      </div>
    </div>
  `;
}
