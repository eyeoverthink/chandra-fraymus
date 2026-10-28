import { Temporal } from '@js-temporal/polyfill';

export const TIME_POLICY = Object.freeze({ disambiguation: 'compatible', overlap: 'first occurrence only',
  gap: 'move forward by the gap', calendar: 'iso8601', interval: 'elapsed UTC minutes' });
const error = message => { throw Object.assign(new Error(message), { code: 'invalid_schedule', status: 400 }); };
const own = (value, key) => Object.hasOwn(value, key);
function shape(value, keys, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
    || required.some(key => !own(value, key))) error('Schedule has missing or unsupported fields');
}
function time(value) {
  if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) error('time must be HH:mm in the selected time zone');
  return value;
}
function zone(value) {
  if (typeof value !== 'string' || value.length > 100 || !(value === 'UTC' || /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+){1,3}$/.test(value))) error('timeZone must be an IANA zone, such as America/Los_Angeles');
  try { return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return error('timeZone is unavailable in this runtime'); }
}
function instant(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) error('An exact ISO instant with Z or a numeric offset is required');
  try { return Temporal.Instant.from(value); }
  catch { return error('The supplied date or time is invalid'); }
}
function clock(value) {
  if (!Number.isSafeInteger(value)) error('The scheduling clock must be an integer epoch millisecond');
  try { return Temporal.Instant.fromEpochMilliseconds(value); }
  catch { return error('The scheduling clock is out of range'); }
}
function frozen(value) { if (value.weekdays) Object.freeze(value.weekdays);return Object.freeze(value); }

export function normalizeSchedule(value, { now = Date.now(), requireFuture = true } = {}) {
  const current = clock(now);
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.kind !== 'string') error('A structured schedule is required');
  let result, first;
  if (value.kind === 'once') {
    shape(value, ['kind','at'], ['kind','at']);first = instant(value.at);
    result = { kind: 'once', at: first.toString() };
  } else if (value.kind === 'interval') {
    shape(value, ['kind','everyMinutes','firstAt'], ['kind','everyMinutes','firstAt']);
    if (!Number.isInteger(value.everyMinutes) || value.everyMinutes < 1 || value.everyMinutes > 10080) error('everyMinutes must be an integer from 1 through 10080');
    first = instant(value.firstAt);result = { kind: 'interval', everyMinutes: value.everyMinutes, firstAt: first.toString() };
  } else if (value.kind === 'daily' || value.kind === 'weekly') {
    const weekly = value.kind === 'weekly';
    shape(value, weekly ? ['kind','time','timeZone','weekdays'] : ['kind','time','timeZone'], weekly ? ['kind','time','timeZone','weekdays'] : ['kind','time','timeZone']);
    result = { kind: value.kind, time: time(value.time), timeZone: zone(value.timeZone) };
    if (weekly) {
      if (!Array.isArray(value.weekdays) || !value.weekdays.length || value.weekdays.length > 7
        || value.weekdays.some(day => !Number.isInteger(day) || day < 1 || day > 7)) error('weekdays must contain ISO weekdays 1 (Monday) through 7 (Sunday)');
      result.weekdays = [...new Set(value.weekdays)].sort((a,b) => a-b);
    }
  } else error('Schedule kind must be once, interval, daily or weekly');
  if (first && requireFuture) {
    if (first.epochMilliseconds < now + 1000) error('The first run must be at least one second in the future');
    const horizon = current.toZonedDateTimeISO('UTC').add({ years: 5 }).epochMilliseconds;
    if (first.epochMilliseconds > horizon) error('The first run cannot be more than five years ahead');
  }
  return frozen(result);
}

// Wall-clock candidates are reconstructed from a calendar date each time. Adding
// 24 elapsed hours would drift at DST; adding another overlap offset would repeat
// a daily task. Compatible chooses the earlier overlap and shifts gaps forward.
export function nextOccurrence(input, afterMs) {
  const after = clock(afterMs);
  const spec = normalizeSchedule(input, { now: afterMs, requireFuture: false });
  if (spec.kind === 'once') { const at = instant(spec.at).epochMilliseconds;return at > afterMs ? at : null; }
  if (spec.kind === 'interval') {
    const start = instant(spec.firstAt).epochMilliseconds, step = spec.everyMinutes * 60000;
    if (start > afterMs) return start;
    const result = start + (Math.floor((afterMs - start) / step) + 1) * step;
    return clock(result).epochMilliseconds;
  }
  const local = after.toZonedDateTimeISO(spec.timeZone).toPlainDate();
  const [hour, minute] = spec.time.split(':').map(Number);
  for (let offset = 0; offset <= 8; offset++) {
    const date = local.add({ days: offset });
    if (spec.kind === 'weekly' && !spec.weekdays.includes(date.dayOfWeek)) continue;
    const candidate = Temporal.ZonedDateTime.from({ timeZone: spec.timeZone, year: date.year, month: date.month,
      day: date.day, hour, minute }, { disambiguation: 'compatible', overflow: 'reject' }).epochMilliseconds;
    if (candidate > afterMs) return candidate;
  }
  error('No bounded calendar occurrence could be computed');
}

export function previewSchedule(input, afterMs, count = 3) {
  if (!Number.isInteger(count) || count < 1 || count > 10) error('Preview count must be from one through ten');
  const spec = normalizeSchedule(input, { now: afterMs, requireFuture: false }), result = [];
  let cursor = afterMs;
  for (let index = 0; index < count; index++) {
    const next = nextOccurrence(spec, cursor);
    if (next === null) break;
    result.push(next);cursor = next;
  }
  return result;
}
