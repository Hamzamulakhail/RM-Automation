const svg = (paths, cls = '') =>
  `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const icons = {
  dashboard: () => svg('<rect x="3" y="3" width="7" height="9" rx="2"/><rect x="14" y="3" width="7" height="5" rx="2"/><rect x="14" y="12" width="7" height="9" rx="2"/><rect x="3" y="16" width="7" height="5" rx="2"/>'),
  accounts: () => svg('<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>'),
  pages: () => svg('<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 10h18"/><path d="M8 15h8"/>'),
  logs: () => svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>'),
  settings: () => svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.604.852.997 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
  sun: () => svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41m11.32-11.32 1.41-1.41"/>'),
  moon: () => svg('<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>'),
  monitor: () => svg('<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>'),
  globe: () => svg('<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>'),
  pause: () => svg('<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'),
  play: () => svg('<polygon points="6 3 20 12 6 21 6 3"/>', 'icon-mirror'),
  refresh: () => svg('<polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>'),
  logout: () => svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>', 'icon-mirror'),
  checkCircle: () => svg('<circle cx="12" cy="12" r="10"/><polyline points="9 12 11.5 14.5 16 9.5"/>'),
  check: () => svg('<polyline points="20 6 9 17 4 12"/>'),
  alertTriangle: () => svg('<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'),
  xCircle: () => svg('<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>'),
  clock: () => svg('<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>'),
  info: () => svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>'),
  send: () => svg('<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>', 'icon-mirror'),
  eye: () => svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>'),
  sliders: () => svg('<line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/>'),
  link: () => svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>'),
  copy: () => svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'),
  share: () => svg('<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>'),
  trash: () => svg('<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'),
  search: () => svg('<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>'),
  command: () => svg('<path d="M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z"/>'),
  plus: () => svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>'),
  minus: () => svg('<line x1="5" y1="12" x2="19" y2="12"/>'),
  zap: () => svg('<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>'),
  panelToggle: () => svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>', 'icon-mirror'),
  chevronEnd: () => svg('<polyline points="9 18 15 12 9 6"/>', 'icon-mirror'),
  close: () => svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>'),
  shield: () => svg('<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>'),
  folder: () => svg('<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>'),
  spinner: () => svg('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>', 'icon-spin'),
};

export const illustrations = {
  noPages: () => `
    <svg class="empty-svg" viewBox="0 0 160 110" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id="illuG1" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="var(--accent-1)" stop-opacity="0.35"/>
          <stop offset="100%" stop-color="var(--accent-2)" stop-opacity="0.1"/>
        </linearGradient>
      </defs>
      <circle cx="80" cy="55" r="46" fill="url(#illuG1)"/>
      <rect x="36" y="26" width="88" height="58" rx="12" fill="var(--surface-2)" stroke="var(--border-strong)" stroke-width="1.5"/>
      <rect x="46" y="38" width="28" height="28" rx="8" fill="var(--accent-soft)" stroke="var(--accent-1)" stroke-opacity="0.5"/>
      <line x1="84" y1="44" x2="114" y2="44" stroke="var(--text-muted)" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="84" y1="54" x2="106" y2="54" stroke="var(--border-strong)" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="60" cy="52" r="5" fill="var(--accent-1)"/>
      <circle cx="118" cy="78" r="13" fill="var(--surface-1)" stroke="var(--accent-2)" stroke-width="1.8"/>
      <path d="M118 73v10m-5-5h10" stroke="var(--accent-2)" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `,
  noSearch: () => `
    <svg class="empty-svg" viewBox="0 0 160 110" fill="none" aria-hidden="true">
      <circle cx="78" cy="54" r="40" fill="var(--surface-3)" opacity="0.65"/>
      <circle cx="72" cy="50" r="22" fill="var(--surface-2)" stroke="var(--accent-1)" stroke-width="2"/>
      <line x1="88" y1="66" x2="108" y2="86" stroke="var(--accent-2)" stroke-width="3.5" stroke-linecap="round"/>
      <path d="M65 50h14" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round"/>
    </svg>
  `,
  noLogs: () => `
    <svg class="empty-svg" viewBox="0 0 160 110" fill="none" aria-hidden="true">
      <rect x="42" y="20" width="76" height="72" rx="12" fill="var(--surface-2)" stroke="var(--border-strong)" stroke-width="1.5"/>
      <line x1="56" y1="40" x2="104" y2="40" stroke="var(--border-strong)" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="56" y1="54" x2="96" y2="54" stroke="var(--border-strong)" stroke-width="2.5" stroke-linecap="round"/>
      <line x1="56" y1="68" x2="84" y2="68" stroke="var(--border-strong)" stroke-width="2.5" stroke-linecap="round"/>
      <circle cx="112" cy="78" r="13" fill="var(--surface-1)" stroke="var(--success)" stroke-width="1.8"/>
      <polyline points="107 78 110.5 81.5 117 74.5" stroke="var(--success)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>
  `,
};

const AVATAR_PAIRS = [
  ['#6366f1', '#06b6d4'],
  ['#8b5cf6', '#ec4899'],
  ['#10b981', '#06b6d4'],
  ['#3b82f6', '#8b5cf6'],
  ['#f59e0b', '#ef4444'],
  ['#ec4899', '#6366f1'],
  ['#14b8a6', '#3b82f6'],
];

export function getAvatarGradient(name) {
  let hash = 0;
  const s = String(name || 'RM');
  for (let i = 0; i < s.length; i++) {
    hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  }
  const [c1, c2] = AVATAR_PAIRS[hash % AVATAR_PAIRS.length];
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}

export function getInitials(name) {
  const clean = String(name || '').trim();
  if (!clean) return 'RM';
  const words = clean.split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0][0]}${words[1][0]}`.toUpperCase();
  }
  return clean.slice(0, 2).toUpperCase();
}
