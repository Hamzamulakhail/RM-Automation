import { translate } from './i18n.js';

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function safeStorageGet(key, fallback = null) {
  try {
    const val = window.localStorage.getItem(key);
    return val === null ? fallback : val;
  } catch {
    return fallback;
  }
}

export function safeStorageSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Ignore storage quota / privacy mode errors
  }
}

export async function apiFetch(path, options = {}, onUnauthorized = null) {
  const opts = {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  };
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    if (onUnauthorized) onUnauthorized();
    throw new Error(data.error || 'Session expired');
  }
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export function formatRelativeTime(isoOrMs, lang) {
  const ms = typeof isoOrMs === 'number' ? isoOrMs : Date.parse(isoOrMs);
  if (Number.isNaN(ms)) return '';
  const diffSec = Math.round((ms - Date.now()) / 1000);
  const absMin = Math.round(Math.abs(diffSec) / 60);

  if (absMin < 1) return translate(lang, 'relNow');
  if (absMin < 60) {
    return translate(lang, diffSec >= 0 ? 'relInMin' : 'relMinAgo', { n: absMin });
  }
  const absHours = Math.round(absMin / 60);
  if (absHours < 48) {
    return translate(lang, diffSec >= 0 ? 'relInHours' : 'relHoursAgo', { n: absHours });
  }
  const absDays = Math.round(absHours / 24);
  return translate(lang, diffSec >= 0 ? 'relInDays' : 'relDaysAgo', { n: absDays });
}

export function formatExactUtc(isoStr) {
  if (!isoStr) return '';
  return String(isoStr).replace('T', ' ').slice(0, 16) + ' UTC';
}

export function minutesFromHHMM(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm || '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function buildScheduleSummary({ slots, jitter, dailyCap, minGap, rampEnabled, rampStart }, lang) {
  const effectiveCap = Math.min(Number(dailyCap) || 1, Math.max(1, (slots || []).length || 1));
  const sorted = [...(slots || [])].map(minutesFromHHMM).filter((v) => v !== null).sort((a, b) => a - b);
  let avgGapMin = Number(minGap) || 0;
  if (sorted.length >= 2) {
    let totalGap = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalGap += sorted[i] - sorted[i - 1];
    }
    avgGapMin = Math.max(avgGapMin, Math.round(totalGap / (sorted.length - 1)));
  }

  let gapLabel = translate(lang, 'onDemandLabel');
  if (avgGapMin >= 60) {
    const hrs = Math.round((avgGapMin / 60) * 10) / 10;
    gapLabel = translate(lang, 'everyTwoHoursShort', { h: hrs });
  } else if (avgGapMin > 0) {
    gapLabel = translate(lang, 'everyMinutesShort', { m: avgGapMin });
  }

  return translate(lang, rampEnabled ? 'scheduleSummaryRamp' : 'scheduleSummary', {
    cap: effectiveCap,
    gap: gapLabel,
    jitter: Number(jitter) || 0,
    start: Number(rampStart) || 1,
  });
}

export function runCountUps() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  document.querySelectorAll('[data-countup]').forEach((el) => {
    const target = Number(el.dataset.countup);
    if (!Number.isFinite(target) || target <= 0 || el.dataset.counted === '1') return;
    el.dataset.counted = '1';
    const start = performance.now();
    const duration = 360;
    const step = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = String(Math.round(target * eased));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}
