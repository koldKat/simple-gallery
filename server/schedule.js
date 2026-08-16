'use strict';

const ALL_WEEKDAYS = Object.freeze([0, 1, 2, 3, 4, 5, 6]);

function normalizeTime(value, fallback = '01:45') {
  const raw = String(value || '').trim();
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Math.max(0, Math.min(23, Number(match[1] || 0)));
  const minute = Math.max(0, Math.min(59, Number(match[2] || 0)));
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function parseWeekdays(value) {
  const values = Array.isArray(value) ? value : String(value ?? '').split(',');
  return Array.from(new Set(values
    .map(day => String(day).trim())
    .filter(Boolean)
    .map(day => Number(day))
    .filter(day => Number.isInteger(day) && day >= 0 && day <= 6)))
    .sort((a, b) => a - b);
}

function nextWeeklyDate(timeValue, dayValues, from = new Date(), fallback = '01:45') {
  const normalized = normalizeTime(timeValue, fallback);
  const allowedDays = new Set(parseWeekdays(dayValues));
  const [hourRaw, minuteRaw] = normalized.split(':');
  const hour = Number(hourRaw || 0);
  const minute = Number(minuteRaw || 0);
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(hour, minute, 0, 0);

  for (let offset = 0; offset <= 7; offset += 1) {
    if (offset > 0) {
      next.setDate(next.getDate() + 1);
      next.setHours(hour, minute, 0, 0);
    }
    if (allowedDays.has(next.getDay()) && next.getTime() > from.getTime()) return next;
  }

  do {
    next.setDate(next.getDate() + 1);
    next.setHours(hour, minute, 0, 0);
  } while (next.getTime() <= from.getTime());
  return next;
}

function nextDailyDate(timeValue, from = new Date(), fallback = '01:45') {
  const normalized = normalizeTime(timeValue, fallback);
  const [hourRaw, minuteRaw] = normalized.split(':');
  const next = new Date(from);
  next.setSeconds(0, 0);
  next.setHours(Number(hourRaw || 0), Number(minuteRaw || 0), 0, 0);
  if (next.getTime() <= from.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

module.exports = { ALL_WEEKDAYS, normalizeTime, parseWeekdays, nextWeeklyDate, nextDailyDate };
