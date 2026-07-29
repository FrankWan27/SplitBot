/**
 * Parsing for the optional `date` on a bill.
 *
 * Discord has no date option type, so this arrives as free text. Like the money
 * parser, it reads the digits itself rather than handing the string to
 * `new Date()`: that constructor accepts almost anything, guesses at the parts it
 * does not understand, and treats a bare `2026-07-20` as UTC midnight, which
 * lands on the previous day for anyone west of Greenwich.
 */

import { UserError } from './errors.js';

export class DateError extends UserError {}

/**
 * A calendar date is stored as noon UTC. It has no real time of day, and noon is
 * the point furthest from a date boundary, so the day survives being rendered in
 * a reader's own timezone.
 *
 * Real offsets span UTC-12 to UTC+14, a 26-hour range, so no single hour holds
 * the day everywhere. Noon holds from UTC-12 to UTC+11 and slips one day forward
 * past that. `/history` shows relative times ("6 days ago"), which hides the
 * slip; printing an absolute date would expose it.
 */
const STORED_HOUR_UTC = 12;

/** A bill older than this is almost certainly a typo in the year. */
const MAX_AGE_DAYS = 5 * 365;

/**
 * Tomorrow is allowed because a date is a calendar day, not an instant: someone
 * far enough east can write today's local date and have it land slightly ahead of
 * noon UTC. Anything beyond that is a future bill, which cannot have happened.
 */
const MAX_FUTURE_DAYS = 1;

const MS_PER_DAY = 86_400_000;

/** Days in `month` (1-12) of `year`, Gregorian leap rules included. */
function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Parses a run of digits, rejecting anything else. Empty is not a number. */
function digits(part: string): number | null {
  return /^\d{1,4}$/.test(part) ? Number(part) : null;
}

/** The calendar date `now` falls on in UTC, as [year, month, day]. */
function todayUtc(now: Date): [number, number, number] {
  return [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
}

function toStoredIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, STORED_HOUR_UTC)).toISOString();
}

/**
 * Turn a user-supplied date into the ISO timestamp stored in `occurred_at`.
 *
 * Accepts `today`, `yesterday`, `YYYY-MM-DD`, and `M/D` or `M/D/YYYY`. The
 * slashed forms are read month-first, matching the `en-US` convention the rest of
 * the bot formats in; `YYYY-MM-DD` is there for anyone who wants to be explicit.
 *
 * `now` is injectable so tests are not tied to the day they run on.
 */
export function parseDateToIso(raw: string, now: Date = new Date()): string {
  const cleaned = raw.trim().toLowerCase();
  if (cleaned === '') {
    throw new DateError('Enter a date, for example `yesterday` or `2026-07-20`.');
  }

  const [nowYear, nowMonth, nowDay] = todayUtc(now);

  if (cleaned === 'today') return toStoredIso(nowYear, nowMonth, nowDay);
  if (cleaned === 'yesterday') {
    const d = new Date(Date.UTC(nowYear, nowMonth - 1, nowDay - 1, STORED_HOUR_UTC));
    return d.toISOString();
  }

  const parts = cleaned.split(/[-/]/);
  let year: number | null;
  let month: number | null;
  let day: number | null;

  if (cleaned.includes('-')) {
    if (parts.length !== 3) {
      throw new DateError(
        `\`${raw.trim()}\` is not a date I understand. Try \`yesterday\`, \`2026-07-20\`, or \`7/20\`.`,
      );
    }
    [year, month, day] = [digits(parts[0]!), digits(parts[1]!), digits(parts[2]!)];
  } else if (parts.length === 2 || parts.length === 3) {
    [month, day] = [digits(parts[0]!), digits(parts[1]!)];
    // A bare `M/D` means the most recent time that date happened, so `12/28`
    // typed in early January is last December rather than eleven months ahead.
    if (parts.length === 3) {
      year = digits(parts[2]!);
    } else if (month !== null && day !== null) {
      year = month > nowMonth || (month === nowMonth && day > nowDay) ? nowYear - 1 : nowYear;
    } else {
      year = null;
    }
  } else {
    throw new DateError(
      `\`${raw.trim()}\` is not a date I understand. Try \`yesterday\`, \`2026-07-20\`, or \`7/20\`.`,
    );
  }

  if (year === null || month === null || day === null) {
    throw new DateError(
      `\`${raw.trim()}\` is not a date I understand. Try \`yesterday\`, \`2026-07-20\`, or \`7/20\`.`,
    );
  }
  // A two-digit year is ambiguous rather than wrong, so it is refused outright
  // instead of being guessed at.
  if (year < 100) {
    throw new DateError('Write the year in full, for example `2026-07-20`.');
  }
  if (month < 1 || month > 12) {
    throw new DateError(`There is no month ${month}.`);
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    throw new DateError(
      `${year}-${String(month).padStart(2, '0')} does not have a day ${day}.`,
    );
  }

  const iso = toStoredIso(year, month, day);
  const ageDays = (now.getTime() - Date.parse(iso)) / MS_PER_DAY;

  if (ageDays < -MAX_FUTURE_DAYS) {
    throw new DateError('That date is in the future, so the bill cannot have happened yet.');
  }
  if (ageDays > MAX_AGE_DAYS) {
    throw new DateError(`That date is over ${Math.floor(MAX_AGE_DAYS / 365)} years ago.`);
  }

  return iso;
}
