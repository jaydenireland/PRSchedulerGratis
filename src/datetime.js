/**
 * Date/time parsing for scheduling commands.
 *
 * The headline format is the one the original PR Scheduler app used —
 * `DD/MM/YYYYTHH:MM` — with an optional trailing timezone. ISO-8601 and
 * relative offsets ("in 2 hours") are accepted as conveniences.
 */

export const DEFAULT_TIMEZONE = 'UTC';

/**
 * Timezone abbreviations mapped to a fixed UTC offset in minutes.
 *
 * Abbreviations are inherently ambiguous (CST is both US Central and China
 * Standard Time). Each entry below documents the reading we picked; anyone who
 * needs the other one can pass an IANA name such as `Asia/Shanghai`.
 */
const ABBREVIATIONS = new Map(Object.entries({
  UT: 0, UTC: 0, Z: 0, GMT: 0, WET: 0, // Western European / Universal
  BST: 60, IST: 330, WEST: 60, CET: 60, CEST: 120, EET: 120, EEST: 180, // IST = India, not Ireland/Israel
  MSK: 180, GST: 240, PKT: 300, BDT: 360, ICT: 420, WIB: 420,
  CST: -360, CDT: -300, EST: -300, EDT: -240, // North American readings
  MST: -420, MDT: -360, PST: -480, PDT: -420,
  AKST: -540, AKDT: -480, HST: -600, NST: -210, NDT: -150,
  AST: -240, ADT: -180, BRT: -180, ART: -180, CLT: -240,
  HKT: 480, SGT: 480, AWST: 480, JST: 540, KST: 540,
  ACST: 570, ACDT: 630, AEST: 600, AEDT: 660, NZST: 720, NZDT: 780,
}));

const RELATIVE_UNITS = new Map(Object.entries({
  minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000, m: 60_000,
  hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000, h: 3_600_000,
  day: 86_400_000, days: 86_400_000, d: 86_400_000,
  week: 604_800_000, weeks: 604_800_000, w: 604_800_000,
}));

/** `26/08/2019T11:05`, `26-08-2019 11:05`, seconds optional. */
const DAY_FIRST = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})(?:[T\s]+)(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** `2019-08-26T11:05`, seconds optional. */
const ISO_LIKE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+)(\d{1,2}):(\d{2})(?::(\d{2}))?$/;
/** `in 2 hours`, `in 30m`, `+45 minutes`. */
const RELATIVE = /^(?:in\s+|\+)(\d+(?:\.\d+)?)\s*([a-z]+)$/i;
/** A trailing offset glued to the timestamp: `...T11:05Z`, `...T11:05+05:30`. */
const TRAILING_OFFSET = /(Z|[+-]\d{1,2}(?::?\d{2})?)$/i;

export class ParseError extends Error {}

const isLeapYear = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const daysInMonth = (y, m) => [31, isLeapYear(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/**
 * The UTC offset (in ms) that `timeZone` was observing at instant `ts`.
 * Formatting the instant into the zone and reading the wall clock back is the
 * only way to get this without shipping a timezone database.
 */
function zoneOffsetMs(ts, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ts));

  const field = {};
  for (const { type, value } of parts) field[type] = value;
  // Some ICU builds render midnight as hour 24.
  const hour = Number(field.hour) % 24;
  const wallClock = Date.UTC(
    Number(field.year), Number(field.month) - 1, Number(field.day),
    hour, Number(field.minute), Number(field.second),
  );
  return wallClock - ts;
}

export function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a wall-clock reading in `timeZone` to the UTC instant it names.
 *
 * The offset depends on the instant and the instant depends on the offset, so
 * we start from the naive UTC reading and re-apply the offset until it settles.
 * Two passes is enough for every real zone; the third is belt and braces for
 * times that land inside a DST transition.
 */
export function zonedTimeToUtc({ year, month, day, hour, minute, second = 0 }, timeZone) {
  const naive = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = naive;
  for (let i = 0; i < 3; i += 1) {
    const next = naive - zoneOffsetMs(ts, timeZone);
    if (next === ts) break;
    ts = next;
  }
  return new Date(ts);
}

/**
 * Resolve a timezone token to something `zonedTimeToUtc` understands.
 * Returns either an IANA name or a fixed-offset `Etc/GMT` equivalent.
 */
export function resolveTimeZone(token) {
  const raw = String(token ?? '').trim();
  if (!raw) return { timeZone: DEFAULT_TIMEZONE, label: 'UTC' };

  // `GMT+5`, `UTC-03:30`, `+0530`, `-08`
  const offsetMatch = /^(?:UTC|GMT|UT)?([+-])(\d{1,2})(?::?(\d{2}))?$/i.exec(raw);
  if (offsetMatch) {
    const [, sign, hours, minutes = '0'] = offsetMatch;
    const totalMinutes = (Number(hours) * 60 + Number(minutes)) * (sign === '-' ? -1 : 1);
    if (Math.abs(totalMinutes) > 18 * 60) {
      throw new ParseError(`Timezone offset \`${raw}\` is outside the valid range of UTC-18:00 to UTC+18:00.`);
    }
    return { timeZone: fixedOffsetZone(totalMinutes), label: formatOffsetLabel(totalMinutes) };
  }

  const upper = raw.toUpperCase();
  if (ABBREVIATIONS.has(upper)) {
    const minutes = ABBREVIATIONS.get(upper);
    return { timeZone: fixedOffsetZone(minutes), label: upper };
  }

  if (isValidTimeZone(raw)) return { timeZone: raw, label: raw };

  throw new ParseError(
    `I don't recognise the timezone \`${raw}\`. Use UTC, an offset like \`GMT+5\`, ` +
    'a common abbreviation like `BST`, or an IANA name like `Europe/London`.',
  );
}

/**
 * A fixed-offset zone for an offset in minutes. `Etc/GMT±N` covers whole hours
 * (with POSIX's inverted sign); anything else is carried as a plain number and
 * applied directly, since no IANA name exists for e.g. UTC+5:30 as an offset.
 */
function fixedOffsetZone(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    if (hours === 0) return 'UTC';
    if (Math.abs(hours) <= 14) return `Etc/GMT${hours > 0 ? '-' : '+'}${Math.abs(hours)}`;
  }
  return { fixedOffsetMinutes: minutes };
}

export function formatOffsetLabel(minutes) {
  if (minutes === 0) return 'UTC';
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Wrapper so fixed numeric offsets and IANA names share one call site. */
function toUtc(fields, timeZone) {
  if (typeof timeZone === 'object' && timeZone !== null) {
    const naive = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second ?? 0);
    return new Date(naive - timeZone.fixedOffsetMinutes * 60_000);
  }
  return zonedTimeToUtc(fields, timeZone);
}

function assertRealDate({ year, month, day, hour, minute, second }) {
  if (month < 1 || month > 12) throw new ParseError(`\`${month}\` is not a valid month.`);
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new ParseError(`\`${day}\` is not a valid day for month ${month} of ${year}.`);
  }
  if (hour > 23) throw new ParseError(`\`${hour}\` is not a valid hour — use a 24-hour clock (00–23).`);
  if (minute > 59) throw new ParseError(`\`${minute}\` is not a valid minute.`);
  if (second > 59) throw new ParseError(`\`${second}\` is not a valid second.`);
}

/**
 * Parse the time argument of a schedule command.
 *
 * @param {string} input       e.g. `26/08/2019T11:05 BST`
 * @param {object} [options]
 * @param {string} [options.defaultTimeZone] used when the input names no zone
 * @param {Date}   [options.now]             reference point for relative times
 * @returns {{ date: Date, timeZoneLabel: string, input: string }}
 */
export function parseWhen(input, { defaultTimeZone = DEFAULT_TIMEZONE, now = new Date() } = {}) {
  const text = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!text) throw new ParseError('No date or time given.');

  const relative = RELATIVE.exec(text);
  if (relative) {
    const [, amount, unit] = relative;
    const unitMs = RELATIVE_UNITS.get(unit.toLowerCase());
    if (!unitMs) {
      throw new ParseError(`I don't recognise the unit \`${unit}\`. Try minutes, hours, days or weeks.`);
    }
    const ms = Number(amount) * unitMs;
    if (ms <= 0) throw new ParseError('A relative delay has to be greater than zero.');
    // Snap to whole minutes: the sweep runs on a cron, so sub-minute precision is noise.
    const date = new Date(Math.round((now.getTime() + ms) / 60_000) * 60_000);
    return { date, timeZoneLabel: 'UTC', input: text };
  }

  // Split a trailing timezone word off the timestamp, if there is one.
  let stamp = text;
  let zoneToken = '';
  const spaceIndex = text.lastIndexOf(' ');
  if (spaceIndex !== -1) {
    const tail = text.slice(spaceIndex + 1);
    // A bare `DD/MM/YYYY HH:MM` puts the time after the space, not a zone.
    if (!/^\d{1,2}:\d{2}(?::\d{2})?$/.test(tail)) {
      stamp = text.slice(0, spaceIndex).trim();
      zoneToken = tail;
    }
  }

  // An offset glued to the end of the timestamp wins over a separate word.
  const glued = TRAILING_OFFSET.exec(stamp);
  if (glued && !zoneToken && /[T\s]\d{1,2}:\d{2}/.test(stamp)) {
    zoneToken = glued[1];
    stamp = stamp.slice(0, glued.index).trim();
  }

  const dayFirst = DAY_FIRST.exec(stamp);
  const isoLike = ISO_LIKE.exec(stamp);
  if (!dayFirst && !isoLike) {
    throw new ParseError(
      `I couldn't read \`${text}\` as a date and time. Use \`DD/MM/YYYYTHH:MM\` ` +
      '(for example `26/08/2026T11:05`), an ISO timestamp, or a relative delay like `in 2 hours`.',
    );
  }

  const fields = dayFirst
    ? {
      year: Number(dayFirst[3]), month: Number(dayFirst[2]), day: Number(dayFirst[1]),
      hour: Number(dayFirst[4]), minute: Number(dayFirst[5]), second: Number(dayFirst[6] ?? 0),
    }
    : {
      year: Number(isoLike[1]), month: Number(isoLike[2]), day: Number(isoLike[3]),
      hour: Number(isoLike[4]), minute: Number(isoLike[5]), second: Number(isoLike[6] ?? 0),
    };

  assertRealDate(fields);

  const { timeZone, label } = resolveTimeZone(zoneToken || defaultTimeZone);
  const date = toUtc(fields, timeZone);
  if (Number.isNaN(date.getTime())) throw new ParseError(`\`${text}\` doesn't resolve to a real point in time.`);

  return { date, timeZoneLabel: label, input: text };
}

/** Render an instant in a zone, for confirmation comments. */
export function formatInZone(date, timeZone = DEFAULT_TIMEZONE) {
  // Fixed numeric offsets have no IANA name, so shift the instant and render as UTC.
  if (typeof timeZone === 'object' && timeZone !== null) {
    const shifted = new Date(date.getTime() + timeZone.fixedOffsetMinutes * 60_000);
    return formatInZone(shifted, 'UTC');
  }
  const zone = typeof timeZone === 'string' && isValidTimeZone(timeZone) ? timeZone : DEFAULT_TIMEZONE;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: zone,
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

/** "in 3 hours", "2 minutes ago" — used in status and confirmation comments. */
export function humanizeDelta(fromDate, toDate) {
  const deltaMs = toDate.getTime() - fromDate.getTime();
  const past = deltaMs < 0;
  let remaining = Math.abs(deltaMs);

  const units = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const parts = [];
  for (const [name, size] of units) {
    const count = Math.floor(remaining / size);
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? '' : 's'}`);
      remaining -= count * size;
    }
    if (parts.length === 2) break;
  }
  if (parts.length === 0) return past ? 'just now' : 'in under a minute';
  const phrase = parts.join(' and ');
  return past ? `${phrase} ago` : `in ${phrase}`;
}
