const formatterCache = new Map();

function getFormatter(timeZone) {
  let fmt = formatterCache.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatterCache.set(timeZone, fmt);
  }
  return fmt;
}

export function isValidTimeZone(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function getLocalParts(dateOrMs, timeZone = 'America/New_York') {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'America/New_York';
  const d = dateOrMs instanceof Date ? dateOrMs : new Date(dateOrMs);
  const parts = getFormatter(tz).formatToParts(d);
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const year = Number(map.year);
  const month = Number(map.month);
  const day = Number(map.day);
  const hour = Number(map.hour === '24' ? '0' : map.hour);
  const minute = Number(map.minute);
  const second = Number(map.second);
  const pad = (n) => String(n).padStart(2, '0');
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    localDate: `${year}-${pad(month)}-${pad(day)}`,
    localTime: `${pad(hour)}:${pad(minute)}`,
  };
}

export function parseSlotMinutes(hhmm) {
  if (typeof hhmm !== 'string') return null;
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

export function minutesToHHMM(totalMinutes) {
  const clamped = Math.max(0, Math.min(1439, Math.round(totalMinutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

export function localDateTimeToUtcMs(localDateStr, minutesSinceMidnight, timeZone = 'America/New_York') {
  const tz = isValidTimeZone(timeZone) ? timeZone : 'America/New_York';
  const [year, month, day] = localDateStr.split('-').map(Number);
  const clamped = Math.max(0, Math.min(1439, Math.round(minutesSinceMidnight)));
  const hour = Math.floor(clamped / 60);
  const minute = clamped % 60;

  const targetAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0, 0);

  // Two-pass iterative offset adjustment for DST accuracy
  let guess = targetAsUtc;
  for (let i = 0; i < 2; i++) {
    const p = getLocalParts(guess, tz);
    const localAtGuessAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const offset = localAtGuessAsUtc - guess;
    guess = targetAsUtc - offset;
  }
  return guess;
}

export function dateDiffDays(fromLocalDate, toLocalDate) {
  const [y1, m1, d1] = fromLocalDate.split('-').map(Number);
  const [y2, m2, d2] = toLocalDate.split('-').map(Number);
  const ms1 = Date.UTC(y1, m1 - 1, d1);
  const ms2 = Date.UTC(y2, m2 - 1, d2);
  return Math.floor((ms2 - ms1) / 86400000);
}
