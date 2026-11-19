import {
  buildScheduleSummary,
  esc,
  formatExactUtc,
  formatRelativeTime,
  minutesFromHHMM,
} from './api.js';
import { translate } from './i18n.js';
import { getAvatarGradient, getInitials, icons, illustrations } from './icons.js';

export const COMMON_TIMEZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Berlin',
  'Asia/Kabul',
  'Asia/Dubai',
  'Asia/Karachi',
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

export function renderStatusBadge(status, label) {
  let iconHtml = icons.info();
  if (status === 'active' || status === 'posted' || status === 'used') {
    iconHtml = icons.checkCircle();
  } else if (status === 'posting') {
    iconHtml = icons.spinner();
  } else if (status === 'paused' || status === 'retrying' || status === 'warn') {
    iconHtml = status === 'warn' ? icons.alertTriangle() : icons.pause();
  } else if (status === 'needs_attention' || status === 'failed' || status === 'revoked' || status === 'error') {
    iconHtml = status === 'failed' || status === 'error' ? icons.xCircle() : icons.alertTriangle();
  } else if (status === 'pending' || status === 'missed' || status === 'skipped' || status === 'expired') {
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

export function renderHeroToday(pages, globalPause, lang) {
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
  const r = 32;
  const circ = 2 * Math.PI * r;
  const offset = circ - (pct / 100) * circ;

  const healthBadge = globalPause
    ? renderStatusBadge('failed', t('heroSystemPaused'))
    : attention > 0
      ? renderStatusBadge('warn', t('heroSystemAttention', { n: attention }))
      : renderStatusBadge('active', t('heroSystemHealthy'));

  return `
    <section class="hero-today" aria-label="${esc(t('heroTodayTitle'))}">
      <div class="hero-ring-wrap">
        <div class="ring-center">
          <svg class="progress-ring-svg" viewBox="0 0 78 78" aria-hidden="true">
            <defs>
              <linearGradient id="auroraRingGrad" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stop-color="var(--accent-1)"/>
                <stop offset="100%" stop-color="var(--accent-2)"/>
              </linearGradient>
            </defs>
            <circle class="ring-track" cx="39" cy="39" r="${r}"/>
            <circle class="ring-fill" cx="39" cy="39" r="${r}" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${offset.toFixed(1)}"/>
          </svg>
          <span class="ring-center-label ltr">${pct}%</span>
        </div>
        <div class="stack-sm">
          <h2 class="section-title">${esc(t('heroTodayTitle'))}</h2>
          <div class="muted small-text">${esc(t('heroPostedOfPlanned', { posted, total: planned }))}</div>
          <div class="muted" style="font-size:12px">${esc(t('heroTodaySubtitle'))}</div>
        </div>
      </div>
      <div class="row-start">
        ${healthBadge}
        <span class="badge badge-neutral ltr">${pages.length} ${esc(t('statTotalPages'))}</span>
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
      icon: icons.checkCircle(),
      series: sp.posted,
      stroke: 'var(--emerald)',
    },
    {
      label: t('statPending'),
      value: pendingToday,
      tone: 'primary',
      icon: icons.clock(),
      series: sp.planned,
      stroke: 'var(--accent-2)',
    },
    {
      label: t('statFailed'),
      value: failedToday,
      tone: failedToday > 0 ? 'danger' : 'neutral',
      icon: icons.xCircle(),
      series: sp.failed,
      stroke: failedToday > 0 ? 'var(--rose)' : 'var(--text-dim)',
    },
    {
      label: t('statAttention'),
      value: attentionCount,
      tone: attentionCount > 0 ? 'danger' : 'neutral',
      icon: icons.alertTriangle(),
      series: null,
      stroke: 'var(--rose)',
    },
  ];

  return `
    <section class="stats-grid" aria-label="KPI Summary">
      ${tiles
        .map(
          (tile) => `
        <div class="stat-tile stat-${tile.tone}">
          <div class="stat-head">
            <span class="stat-label">${esc(tile.label)}</span>
            <span class="stat-icon">${tile.icon}</span>
          </div>
          <div class="stat-bottom">
            <div class="stat-value ltr" data-countup="${tile.value}">${tile.value}</div>
            ${tile.series ? renderSparklineSvg(tile.series, tile.stroke) : ''}
          </div>
        </div>`
        )
        .join('')}
    </section>
  `;
}

export function renderPageCard(p, lang, busyMap, activePopover, idx = 0) {
  const t = (k, v) => translate(lang, k, v);
  const isPaused = p.status === 'paused';
  const hasFolders = Boolean(p.captions_folder_id && p.media_folder_id);
  const nextUtc = p.next_planned?.planned_utc;
  const nextRel = nextUtc ? formatRelativeTime(nextUtc, lang) : '';
  const postBusy = busyMap.has(`post:${p.id}`);
  const pauseBusy = busyMap.has(`pause:${p.id}`);

  const todaySlots = p.today_slots || [];
  const postedCnt = todaySlots.filter((s) => s.status === 'posted').length;
  const healthPct = todaySlots.length > 0 ? postedCnt / todaySlots.length : p.status === 'active' ? 1 : 0;
  const avR = 20;
  const avCirc = 2 * Math.PI * avR;
  const avOffset = avCirc * (1 - healthPct);
  const ringStroke = p.status === 'needs_attention' ? 'var(--rose)' : p.status === 'paused' ? 'var(--amber)' : 'var(--emerald)';

  const nowMinutes = minutesFromHHMM(p.local_time);
  const nowPct = nowMinutes !== null ? Math.min(99, Math.max(1, (nowMinutes / 1440) * 100)) : null;

  const selectedSlot =
    activePopover && activePopover.pageId === p.id
      ? todaySlots.find((s) => String(s.id) === String(activePopover.slotId))
      : null;

  return `
    <article class="card page-card" data-page-id="${p.id}" style="--stagger:${Math.min(idx, 10)}">
      <div class="card-header">
        <div class="avatar-wrap" aria-hidden="true">
          <svg class="avatar-ring" viewBox="0 0 44 44">
            <circle class="avatar-ring-track" cx="22" cy="22" r="${avR}"/>
            <circle class="avatar-ring-fill" cx="22" cy="22" r="${avR}" style="stroke:${ringStroke}" stroke-dasharray="${avCirc.toFixed(1)}" stroke-dashoffset="${avOffset.toFixed(1)}"/>
          </svg>
          <div class="avatar-circle" style="background:${getAvatarGradient(p.name)}">${esc(getInitials(p.name))}</div>
        </div>
        <div class="card-title-wrap">
          <h3 class="card-title">${esc(p.name)}</h3>
          <div class="card-meta">
            <span>${esc(p.account_name)}</span>
            <span aria-hidden="true">·</span>
            <span class="ltr">${esc(p.timezone)}</span>
          </div>
        </div>
        ${renderStatusBadge(p.status, t(`status_${p.status}`))}
      </div>

      <div class="page-time-row">
        <div class="meta-pair">
          <span class="muted">${esc(t('localTimeNow'))}</span>
          <strong class="ltr">${esc(p.local_time)}</strong>
        </div>
        <div class="meta-pair">
          <span class="muted">${esc(t('nextPlanned'))}</span>
          ${
            p.next_planned
              ? `<strong class="rel-time ltr" title="${esc(formatExactUtc(nextUtc))}">${esc(p.next_planned.planned_local)} · ${esc(nextRel)}</strong>`
              : `<span class="muted">${esc(t('noNextPlanned'))}</span>`
          }
        </div>
      </div>

      ${!hasFolders ? `<div class="inline-alert inline-alert-warn">${icons.alertTriangle()}<span>${esc(t('folderNotSet'))}</span></div>` : ''}
      ${p.last_error ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span><strong>${esc(t('lastError'))}:</strong> ${esc(p.last_error)}</span></div>` : ''}

      <div class="timeline-24-wrap">
        <div class="timeline-24-head">
          <span>${esc(t('todaySlots'))}</span>
          <span class="ltr">00:00 — 24:00</span>
        </div>
        ${
          todaySlots.length === 0
            ? `<div class="muted small-text">${esc(t('noSlotsToday'))}</div>`
            : `<div class="timeline-24-bar">
                <div class="timeline-24-axis">
                  ${
                    nowPct !== null
                      ? `<span class="timeline-now-line" style="inset-inline-start:${nowPct.toFixed(1)}%" title="${esc(t('nowMarker'))}: ${esc(p.local_time)}"></span>`
                      : ''
                  }
                  ${todaySlots
                    .map((s) => {
                      const mins = minutesFromHHMM(s.planned_local) ?? 0;
                      const pct = Math.min(98, Math.max(2, (mins / 1440) * 100));
                      const stCls = s.status === 'pending' && Number(s.attempts) > 0 ? 'retrying' : s.status;
                      const stLabel =
                        stCls === 'retrying' ? `${t('slot_retrying')} (${s.attempts}/5)` : t(`slot_${s.status}`);
                      return `
                        <button
                          type="button"
                          class="timeline-dot-btn dot-${esc(stCls)}"
                          style="inset-inline-start:${pct.toFixed(1)}%"
                          data-action="inspect-slot"
                          data-page-id="${p.id}"
                          data-slot-id="${s.id}"
                          aria-label="${esc(s.planned_local)} · ${esc(stLabel)}"
                          title="${esc(s.planned_local)} · ${esc(stLabel)}${s.file_name ? ` · ${s.file_name}` : ''}"
                        ></button>`;
                    })
                    .join('')}
                </div>
              </div>`
        }
        ${
          selectedSlot
            ? `<div class="slot-popover" role="region" aria-label="Slot details">
                <div class="row">
                  <strong class="ltr">${esc(selectedSlot.planned_local)}</strong>
                  ${renderStatusBadge(
                    selectedSlot.status === 'pending' && Number(selectedSlot.attempts) > 0 ? 'retrying' : selectedSlot.status,
                    t(`slot_${selectedSlot.status}`)
                  )}
                </div>
                <div class="ltr">${esc(selectedSlot.file_name || t('slotNoFileYet'))}</div>
                ${
                  selectedSlot.caption_preview
                    ? `<div class="muted">${esc(selectedSlot.caption_preview)}${selectedSlot.caption_preview.length >= 140 ? '…' : ''}</div>`
                    : ''
                }
                ${selectedSlot.error ? `<div class="field-error">${esc(selectedSlot.error)}</div>` : ''}
              </div>`
            : ''
        }
      </div>

      <div class="card-actions">
        <button class="btn btn-sm" data-action="toggle-pause" data-id="${p.id}" data-paused="${isPaused ? '1' : '0'}" ${pauseBusy ? 'disabled' : ''}>
          ${pauseBusy ? icons.spinner() : isPaused ? icons.play() : icons.pause()}
          <span>${esc(isPaused ? t('resumePage') : t('pausePage'))}</span>
        </button>
        <button class="btn btn-sm" data-action="open-drawer" data-id="${p.id}" data-drawer-tab="preview">
          ${icons.eye()}
          <span>${esc(t('previewNext'))}</span>
        </button>
        <button class="btn btn-sm btn-primary" data-action="confirm-post-now" data-id="${p.id}" data-name="${esc(p.name)}" ${postBusy ? 'disabled' : ''}>
          ${postBusy ? icons.spinner() : icons.send()}
          <span>${esc(t('postNow'))}</span>
        </button>
        <button class="btn btn-sm btn-ghost" data-action="open-drawer" data-id="${p.id}" data-drawer-tab="schedule">
          ${icons.sliders()}
          <span>${esc(t('detailsBtn'))}</span>
          ${icons.chevronEnd()}
        </button>
      </div>
    </article>
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
        <span class="sched-pin" style="left:${pct.toFixed(1)}%" title="${esc(s)}"></span>
      `;
    })
    .join('');

  return `
    <div class="sched-visual-box">
      <div class="muted small-text">${esc(translate(lang, 'schedule24hBar'))}</div>
      <div class="sched-track ltr">${pins}</div>
      <div class="sched-hours ltr"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>24:00</span></div>
    </div>
  `;
}

function renderStepper(id, label, value, min, max) {
  return `
    <div class="field">
      <label for="${esc(id)}">${esc(label)}</label>
      <div class="stepper ltr">
        <button type="button" class="stepper-btn" data-action="step" data-target="${esc(id)}" data-delta="-1" data-min="${min}" data-max="${max}" aria-label="Decrease ${esc(label)}">${icons.minus()}</button>
        <input id="${esc(id)}" type="number" min="${min}" max="${max}" class="input ltr" value="${value}" />
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

  let tabContent = '';

  if (drawer.tab === 'schedule') {
    const summaryText = buildScheduleSummary(
      {
        slots: drawer.slots,
        jitter: p.jitter_minutes,
        dailyCap: p.daily_cap,
        minGap: p.min_gap_minutes,
        rampEnabled: p.ramp_up_enabled,
        rampStart: p.ramp_start,
      },
      lang
    );

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
            <input id="editTzCustom" class="input ltr" value="${esc(p.timezone)}" placeholder="America/New_York" />
          </div>
        </div>

        <div class="field">
          <label>${esc(t('slotsLabel'))}</label>
          <div class="slot-chips">
            ${drawer.slots
              .map(
                (s, idx) => `
              <span class="slot-chip">
                <span class="ltr">${esc(s)}</span>
                <button type="button" data-action="remove-slot" data-idx="${idx}" aria-label="Remove ${esc(s)}">×</button>
              </span>`
              )
              .join('')}
          </div>
          <div class="row-start">
            <input id="newSlotInput" type="time" class="input ltr" style="width:auto" value="16:00" />
            <button type="button" id="addSlotBtn" class="btn btn-sm">${icons.plus()}<span>${esc(t('addSlotBtn'))}</span></button>
          </div>
          <div class="row-start small-text muted">
            <span>${esc(t('scheduleQuickAdd'))}:</span>
            ${['08:00', '12:00', '16:00', '20:00']
              .filter((q) => !drawer.slots.includes(q))
              .map((q) => `<button type="button" class="filter-chip ltr" data-action="quick-add-slot" data-slot="${q}">+${q}</button>`)
              .join('')}
          </div>
          ${drawer.slotError ? `<div class="field-error">${esc(drawer.slotError)}</div>` : ''}
        </div>

        <div class="form-grid form-grid-3">
          ${renderStepper('editDailyCap', t('dailyCapLabel'), p.daily_cap, 1, 24)}
          ${renderStepper('editMinGap', t('minGapLabel'), p.min_gap_minutes, 0, 720)}
          ${renderStepper('editJitter', t('jitterLabel'), p.jitter_minutes, 0, 180)}
        </div>

        <div class="subcard stack">
          <label class="row-start" style="cursor:pointer">
            <input id="editRampEnabled" type="checkbox" ${p.ramp_up_enabled ? 'checked' : ''} />
            <strong>${esc(t('rampUpLabel'))}</strong>
          </label>
          <div class="form-grid form-grid-2">
            ${renderStepper('editRampStart', t('rampStartLabel'), p.ramp_start, 1, 24)}
            ${renderStepper('editRampStep', t('rampStepLabel'), p.ramp_step_days, 1, 30)}
          </div>
        </div>

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
    tabContent = `
      <div class="stack">
        <div class="subcard stack">
          <strong>${esc(t('driveStep1Title'))}</strong>
          <p class="muted small-text" style="margin:0">${esc(t('driveStep1Hint'))}</p>
          ${
            driveInfo?.configured
              ? `<div class="row-start">
                  <div class="code-box ltr" style="flex:1">${esc(driveInfo.serviceAccountEmail)}</div>
                  <button type="button" class="btn btn-sm" id="copySaEmailBtn">${icons.copy()}<span>${esc(t('copyEmailBtn'))}</span></button>
                </div>`
              : `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(driveInfo?.error || t('noDriveConfigured'))}</span></div>`
          }
        </div>

        <div class="subcard stack">
          <div class="row">
            <strong>${esc(t('driveStep2Title'))}</strong>
            <button type="button" class="btn btn-sm" id="loadFoldersBtn" ${drawer.driveFoldersLoading ? 'disabled' : ''}>
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
          <button type="button" class="btn btn-sm" id="refreshPreviewBtn" ${drawer.previewLoading ? 'disabled' : ''}>
            ${drawer.previewLoading ? icons.spinner() : icons.refresh()}
            <span>${esc(t('runPreviewBtn'))}</span>
          </button>
        </div>

        ${
          drawer.previewLoading
            ? `<div class="skeleton-line w-100" style="height:100px"></div>`
            : drawer.previewError
              ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(drawer.previewError)}</span></div>`
              : pv
                ? `
              <div class="inline-alert ${pv.ready ? 'inline-alert-info' : 'inline-alert-warn'}">
                ${pv.ready ? icons.checkCircle() : icons.alertTriangle()}
                <strong>${esc(pv.ready ? t('previewReady') : t('previewNotReady'))}</strong>
              </div>
              ${pv.warnings?.length ? `<div class="subcard stack-sm"><strong>${esc(t('previewWarnings'))}</strong><ul class="clean-list">${pv.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : ''}
              ${
                pv.pair
                  ? `<div class="subcard stack-sm">
                      <div><strong>${esc(t('previewFile'))}:</strong> <span class="ltr">${esc(pv.pair.fileName)}</span> (${esc(pv.pair.mediaType)}, ${(pv.pair.sizeBytes / (1024 * 1024)).toFixed(2)} MB)</div>
                      <div><strong>${esc(t('previewCaptionNum'))}:</strong> <span class="ltr">#${pv.pair.number}</span></div>
                      <div><strong>${esc(t('previewCaptionText'))}:</strong></div>
                      <div class="code-box" style="white-space:pre-wrap;font-family:inherit">${esc(pv.pair.captionText)}</div>
                    </div>`
                  : ''
              }
              ${pv.orphanFiles?.length ? `<div class="subcard"><strong>${esc(t('previewOrphanFiles'))}:</strong> <span class="ltr">${pv.orphanFiles.map((o) => esc(o.name)).join(', ')}</span></div>` : ''}
              ${pv.orphanCaptions?.length ? `<div class="subcard"><strong>${esc(t('previewOrphanCaptions'))}:</strong> <span class="ltr">${pv.orphanCaptions.map((c) => `#${c.number}`).join(', ')}</span></div>` : ''}
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
            : `<div class="stack-sm">${drawer.blockedFiles
                .map(
                  (f) => `
                  <div class="subcard row">
                    <div>
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
            : `<div class="stack-sm">${plans
                .map((r) => {
                  const st = r.status === 'pending' && Number(r.attempts) > 0 ? 'retrying' : r.status;
                  const lbl = st === 'retrying' ? `${t('slot_retrying')} (${r.attempts}/5)` : t(`slot_${r.status}`);
                  return `
                    <div class="subcard row">
                      <div>
                        <div class="row-start">
                          <span class="ltr"><strong>${esc(r.local_date)} ${esc(r.planned_local)}</strong></span>
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
            : `<div class="stack-sm">${evs
                .map(
                  (ev) => `
                  <div class="subcard">
                    <div class="row">
                      ${renderStatusBadge(ev.level, t(`level_${ev.level}`))}
                      <span class="muted small-text" title="${esc(formatExactUtc(ev.created_at))}">${esc(formatRelativeTime(ev.created_at, lang))}</span>
                    </div>
                    <div style="margin-top:6px;word-break:break-word">${esc(ev.message)}</div>
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
            <div class="avatar-circle" style="background:${getAvatarGradient(p.name)}">${esc(getInitials(p.name))}</div>
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

function renderInviteLifecycle(inv, lang) {
  const t = (k) => translate(lang, k);
  const createdDone = true;
  const openedDone = Boolean(inv.opened) || inv.status === 'used';
  const connectedDone = inv.status === 'used';

  return `
    <div class="lifecycle">
      <span class="life-step ${createdDone ? 'done' : ''}"><span class="life-dot"></span><span>${esc(t('inviteStepCreated'))}</span></span>
      <span class="life-line ${openedDone ? 'done' : ''}"></span>
      <span class="life-step ${openedDone ? 'done' : ''}"><span class="life-dot"></span><span>${esc(t('inviteStepOpened'))}</span></span>
      <span class="life-line ${connectedDone ? 'done' : ''}"></span>
      <span class="life-step ${connectedDone ? 'done' : ''}"><span class="life-dot"></span><span>${esc(t('inviteStepConnected'))}</span></span>
    </div>
  `;
}

export function renderAccountsView(state, lang, busyMap) {
  const t = (k, v) => translate(lang, k, v);
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';
  const creatingInvite = busyMap.has('create-invite');
  const addingManual = busyMap.has('manual-account');

  return `
    <div class="stack">
      ${state.fbOAuthBanner ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(state.fbOAuthBanner)}</span></div>` : ''}

      <section class="card stack">
        <div class="row">
          <h2 class="section-title">${esc(t('navAccounts'))}</h2>
          <a href="/auth/facebook/start" class="btn btn-primary">${icons.link()}<span>${esc(t('connectFbBtn'))}</span></a>
        </div>
        <div class="divider"></div>
        <form id="manualTokenForm" class="stack-sm">
          <label for="manualTokenInput" class="field-label">${esc(t('manualTokenTitle'))}</label>
          <div class="row-start">
            <input id="manualTokenInput" type="password" class="input ltr" style="flex:1;min-width:210px" placeholder="${esc(t('manualTokenPlaceholder'))}" />
            <button type="submit" class="btn" ${addingManual ? 'disabled' : ''}>
              ${addingManual ? icons.spinner() : icons.plus()}
              <span>${esc(t('addManualTokenBtn'))}</span>
            </button>
          </div>
          ${state.manualTokenError ? `<div class="field-error">${esc(state.manualTokenError)}</div>` : ''}
        </form>
      </section>

      <section class="card stack">
        <div>
          <h2 class="section-title">${esc(t('invitesTitle'))}</h2>
          <p class="muted small-text" style="margin:4px 0 0">${esc(t('invitesDesc'))}</p>
        </div>

        <form id="createInviteForm" class="form-grid form-grid-3" style="align-items:end">
          <div class="field">
            <label for="inviteLabelInput">${esc(t('inviteLabelInput'))}</label>
            <input id="inviteLabelInput" class="input" maxlength="120" placeholder="Maria - PH ID" />
          </div>
          <div class="field">
            <label for="inviteExpirySelect">${esc(t('inviteExpiryLabel'))}</label>
            <select id="inviteExpirySelect" class="select">
              <option value="12">${esc(t('exp12h'))}</option>
              <option value="24">${esc(t('exp24h'))}</option>
              <option value="48" selected>${esc(t('exp48h'))}</option>
              <option value="72">${esc(t('exp72h'))}</option>
              <option value="168">${esc(t('exp7d'))}</option>
            </select>
          </div>
          <div>
            <button type="submit" class="btn btn-primary" style="width:100%" ${creatingInvite ? 'disabled' : ''}>
              ${creatingInvite ? icons.spinner() : icons.link()}
              <span>${esc(t('createInviteBtn'))}</span>
            </button>
          </div>
        </form>

        ${
          state.createdInviteUrl
            ? `<div class="subcard stack-sm" style="border-color:var(--accent-1)">
                <div class="row">
                  <strong>${esc(t('inviteCreatedTitle'))}</strong>
                  <button type="button" class="btn btn-sm btn-ghost" id="dismissCreatedInviteBtn" aria-label="${esc(t('closeBtn'))}">${icons.close()}</button>
                </div>
                <div class="code-box ltr">${esc(state.createdInviteUrl)}</div>
                <div class="row-start">
                  <button type="button" class="btn btn-sm btn-primary ${state.inviteCopied ? 'is-copied' : ''}" id="copyCreatedInviteBtn">
                    ${state.inviteCopied ? icons.check() : icons.copy()}
                    <span>${esc(state.inviteCopied ? t('copiedMsg') : t('copyLinkBtn'))}</span>
                  </button>
                  ${canShare ? `<button type="button" class="btn btn-sm" id="shareCreatedInviteBtn">${icons.share()}<span>${esc(t('shareLinkBtn'))}</span></button>` : ''}
                </div>
              </div>`
            : ''
        }

        ${
          state.invites.length === 0
            ? `<div class="muted small-text">${esc(t('invitesListEmpty'))}</div>`
            : `<div class="table-card" style="border:1px solid var(--border);border-radius:var(--r-sm)">
                <table class="responsive-table">
                  <thead>
                    <tr>
                      <th>${esc(t('inviteColLabel'))}</th>
                      <th>${esc(t('inviteColStatus'))}</th>
                      <th>${esc(t('inviteColLifecycle'))}</th>
                      <th>${esc(t('inviteColExpires'))}</th>
                      <th>${esc(t('inviteColAccount'))}</th>
                      <th>${esc(t('inviteColActions'))}</th>
                    </tr>
                  </thead>
                  <tbody>
                    ${state.invites
                      .map(
                        (inv) => `
                        <tr>
                          <td data-label="${esc(t('inviteColLabel'))}"><strong>${esc(inv.label || `#${inv.id}`)}</strong></td>
                          <td data-label="${esc(t('inviteColStatus'))}">${renderStatusBadge(inv.status, t(`invite_${inv.status}`))}</td>
                          <td data-label="${esc(t('inviteColLifecycle'))}">${renderInviteLifecycle(inv, lang)}</td>
                          <td data-label="${esc(t('inviteColExpires'))}" title="${esc(formatExactUtc(inv.expires_at))}">${esc(formatRelativeTime(inv.expires_at, lang))}</td>
                          <td data-label="${esc(t('inviteColAccount'))}">${esc(inv.account_name || '-')}</td>
                          <td data-label="${esc(t('inviteColActions'))}">
                            ${
                              inv.status === 'pending'
                                ? `<button class="btn btn-sm btn-danger-outline" data-action="confirm-revoke-invite" data-id="${inv.id}">${esc(t('revokeBtn'))}</button>`
                                : '<span class="muted">-</span>'
                            }
                          </td>
                        </tr>`
                      )
                      .join('')}
                  </tbody>
                </table>
              </div>`
        }
      </section>

      <section class="stack">
        ${
          state.accounts.length === 0
            ? `<div class="card empty-state">
                ${illustrations.noPages()}
                <h3>${esc(t('noAccountsYet'))}</h3>
                <p class="muted">${esc(t('noAccountsHint'))}</p>
              </div>`
            : state.accounts
                .map(
                  (a) => `
                <div class="card stack-sm">
                  <div class="row">
                    <div class="row-start">
                      <div class="avatar-circle" style="background:${getAvatarGradient(a.name)}">${esc(getInitials(a.name))}</div>
                      <div>
                        <strong style="font-size:16px">${esc(a.name)}</strong>
                        <div class="muted small-text ltr">ID: ${esc(a.fb_user_id)} · ${esc(t('connectedPagesCount'))}: ${a.page_count}</div>
                        ${
                          a.token_expires_at
                            ? `<div class="muted small-text">${esc(t('tokenExpires'))}: <span title="${esc(formatExactUtc(a.token_expires_at))}">${esc(formatRelativeTime(a.token_expires_at, lang))}</span></div>`
                            : ''
                        }
                      </div>
                    </div>
                    ${renderStatusBadge(a.status, t(`status_${a.status}`))}
                  </div>
                  ${a.last_error ? `<div class="inline-alert inline-alert-danger">${icons.xCircle()}<span>${esc(a.last_error)}</span></div>` : ''}
                  <div class="row-start">
                    <button class="btn btn-sm btn-primary" data-action="select-pages" data-id="${a.id}">${icons.pages()}<span>${esc(t('selectPagesBtn'))}</span></button>
                    <button class="btn btn-sm" data-action="check-account" data-id="${a.id}">${icons.shield()}<span>${esc(t('checkTokenBtn'))}</span></button>
                    <a href="/auth/facebook/start" class="btn btn-sm">${icons.refresh()}<span>${esc(t('reconnectBtn'))}</span></a>
                    <button class="btn btn-sm btn-danger-outline" data-action="confirm-delete-account" data-id="${a.id}" data-name="${esc(a.name)}">${icons.trash()}<span>${esc(t('deleteBtn'))}</span></button>
                  </div>
                </div>`
                )
                .join('')
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
      <div class="card form-grid form-grid-3" style="position:sticky;top:68px;z-index:10">
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

export function renderCommandPalette(palette, pages, globalPause, lang) {
  if (!palette?.open) return '';
  const t = (k) => translate(lang, k);
  const q = (palette.query || '').trim().toLowerCase();

  const actions = [
    { id: 'cmd-pause', label: globalPause ? t('resumeAllBtn') : t('pauseAllBtn'), icon: globalPause ? icons.play() : icons.pause() },
    { id: 'cmd-invite', label: t('createInviteAction'), icon: icons.link() },
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
                       <span class="avatar-circle" style="width:26px;height:26px;font-size:11px;background:${getAvatarGradient(p.name)}">${esc(getInitials(p.name))}</span>
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

export function renderQuickActionsSheet(open, globalPause, lang) {
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
        <button type="button" class="btn ${globalPause ? 'btn-primary' : 'btn-danger-outline'}" data-action="run-palette-action" data-cmd="cmd-pause">
          ${globalPause ? icons.play() : icons.pause()}
          <span>${esc(globalPause ? t('resumeAllBtn') : t('pauseAllBtn'))}</span>
        </button>
        <button type="button" class="btn btn-primary" data-action="run-palette-action" data-cmd="cmd-invite">
          ${icons.link()}<span>${esc(t('createInviteAction'))}</span>
        </button>
        <button type="button" class="btn" data-action="run-palette-action" data-cmd="cmd-add-page">
          ${icons.pages()}<span>${esc(t('addPageAction'))}</span>
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
                    <span style="flex:1"><strong>${esc(p.name)}</strong> <span class="muted ltr">(${esc(p.fb_page_id)})</span></span>
                    ${p.alreadyAdded ? `<span class="badge badge-neutral">${esc(t('alreadyAdded'))}</span>` : ''}
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
