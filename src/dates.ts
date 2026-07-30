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

/**
 * Timezone the `/history` date headings are computed in.
 *
 * Grouping entries under a calendar day forces a choice of timezone: an entry
 * logged at 6pm in California is already the next day in UTC. A Discord
 * timestamp cannot help here, because the grouping has to be decided once,
 * server-side, for everyone reading the message - unlike the relative times in
 * the listing, which each reader's client localises.
 *
 * Defaults to UTC, which is the only defensible guess for a server whose members
 * could be anywhere. Set `DISPLAY_TIMEZONE` to an IANA name (`America/Los_Angeles`)
 * to group by the day your group actually lives in.
 */
export function displayTimeZone(): string {
  const raw = process.env['DISPLAY_TIMEZONE']?.trim();
  if (!raw) return 'UTC';
  try {
    // Constructing the formatter is the only way to ask whether the runtime
    // knows the zone; an unknown name throws RangeError.
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    console.warn(`DISPLAY_TIMEZONE "${raw}" is not a timezone I recognise; grouping by UTC.`);
    return 'UTC';
  }
}

/** The year, month and day `iso` falls on in `timeZone`, or null if unparseable. */
function partsIn(
  iso: string,
  timeZone: string,
): { year: string; month: string; day: string } | null {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));

  const find = (type: string): string | undefined => parts.find((p) => p.type === type)?.value;
  const [year, month, day] = [find('year'), find('month'), find('day')];
  if (!year || !month || !day) return null;
  return { year, month, day };
}

/**
 * Which calendar day `iso` belongs to, as a sortable `YYYY-MM-DD` string. Used
 * only to decide where one date group ends and the next begins, never displayed.
 */
export function dayKey(iso: string, timeZone: string): string | null {
  const p = partsIn(iso, timeZone);
  return p ? `${p.year}-${p.month}-${p.day}` : null;
}

/**
 * The `MM/DD` heading for a date group. The year is appended only when it is not
 * the current one, since `07/27` alone is genuinely ambiguous on an old entry and
 * redundant on a recent one.
 */
export function dayHeading(iso: string, timeZone: string, now: Date = new Date()): string | null {
  const p = partsIn(iso, timeZone);
  if (!p) return null;
  const thisYear = partsIn(now.toISOString(), timeZone)?.year;
  return p.year === thisYear ? `${p.month}/${p.day}` : `${p.month}/${p.day}/${p.year}`;
}

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

/** Month names in order, so a name's position is its number. */
const MONTH_NAMES = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
] as const;

/**
 * The month a word names (1-12), or null if it names none.
 *
 * Accepts the full name and the three-letter abbreviation, which is what people
 * actually type. The input is already lowercased by the time this sees it, so
 * `July`, `JUL` and `jul` all arrive as the same word.
 *
 * Deliberately narrow: `janu` and `sep2` are refused rather than matched on a
 * prefix, since a word that is nearly a month name is more likely a typo worth
 * pointing out than an abbreviation worth guessing at.
 */
function monthNumber(word: string): number | null {
  // `Jul. 24` is a normal way to write an abbreviation, and the period carries no
  // meaning of its own.
  const name = word.endsWith('.') ? word.slice(0, -1) : word;
  // `sept` is common enough to accept alongside `sep`, and ambiguous with nothing.
  if (name === 'sept') return 9;
  const index = MONTH_NAMES.findIndex(
    (m) => m === name || (name.length === 3 && m.startsWith(name)),
  );
  return index === -1 ? null : index + 1;
}

/** The calendar date `now` falls on in UTC, as [year, month, day]. */
function todayUtc(now: Date): [number, number, number] {
  return [now.getUTCFullYear(), now.getUTCMonth() + 1, now.getUTCDate()];
}

/**
 * The most recent year in which `month`/`day` has already come round.
 *
 * A date given without a year means the last time it happened, so `12/28` or
 * `Dec 28` typed in July is last December rather than five months in the future -
 * a bill can only be logged after the fact.
 *
 * Called only once the month and day are known to be in range, since a year
 * inferred from a day like `32` would appear in the error message that follows and
 * name a year the user never wrote.
 */
function mostRecentYear(month: number, day: number, now: Date): number {
  const [nowYear, nowMonth, nowDay] = todayUtc(now);
  return month > nowMonth || (month === nowMonth && day > nowDay) ? nowYear - 1 : nowYear;
}

/** The longest any month ever is, for range-checking a day before a year is known. */
const MAX_DAYS_IN_ANY_MONTH = 31;

function toStoredIso(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day, STORED_HOUR_UTC)).toISOString();
}

/** The catch-all refusal, listing one example of every accepted form. */
function notADate(raw: string): DateError {
  return new DateError(
    `\`${raw.trim()}\` is not a date I understand. ` +
      'Try `yesterday`, `July 20`, `2026-07-20`, or `7/20`.',
  );
}

/**
 * Turn a user-supplied date into the ISO timestamp stored in `occurred_at`.
 *
 * Accepts `today`, `yesterday`, `YYYY-MM-DD`, `M/D` or `M/D/YYYY`, and a month by
 * name: `July 20`, `Jul 20`, or `July 20, 2026`, in any case. Every form is read
 * month-first, matching the `en-US` convention the rest of the bot formats in;
 * `YYYY-MM-DD` is there for anyone who wants to be explicit. A form with no year
 * means the most recent time that date happened.
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

  // A comma is a separator rather than a part, so `July 20, 2026` reads the same
  // as `July 20 2026`.
  const words = cleaned.split(/[\s,]+/).filter((w) => w !== '');
  const named = words.length > 1 ? monthNumber(words[0]!) : null;

  // A year of `null` means "not written down", which is resolved to the most
  // recent occurrence once the month and day are known to be real.
  let year: number | null;
  let month: number | null;
  let day: number | null;
  let yearGiven: boolean;

  if (named !== null) {
    // `Month Day` or `Month Day Year`. Only month-first is accepted, so `20 July`
    // is refused rather than read the other way round: mixing the two conventions
    // is what makes `03/04` unreadable, and the same trap applies to names.
    if (words.length > 3) throw notADate(raw);
    month = named;
    day = digits(words[1]!);
    yearGiven = words.length === 3;
    year = yearGiven ? digits(words[2]!) : null;
  } else if (words.length > 1) {
    // Several words, and the first is not a month name. Nothing else here is
    // spelt with spaces.
    throw notADate(raw);
  } else if (cleaned.includes('-')) {
    const parts = cleaned.split('-');
    if (parts.length !== 3) throw notADate(raw);
    [year, month, day] = [digits(parts[0]!), digits(parts[1]!), digits(parts[2]!)];
    yearGiven = true;
  } else {
    const parts = cleaned.split('/');
    if (parts.length !== 2 && parts.length !== 3) throw notADate(raw);
    [month, day] = [digits(parts[0]!), digits(parts[1]!)];
    yearGiven = parts.length === 3;
    year = yearGiven ? digits(parts[2]!) : null;
  }

  if (month === null || day === null || (yearGiven && year === null)) throw notADate(raw);
  // A two-digit year is ambiguous rather than wrong, so it is refused outright
  // instead of being guessed at.
  if (year !== null && year < 100) {
    throw new DateError('Write the year in full, for example `2026-07-20`.');
  }
  if (month < 1 || month > 12) {
    throw new DateError(`There is no month ${month}.`);
  }
  // Checked against the longest any month can be before the year is inferred,
  // because inferring a year from an impossible day would put a year the user
  // never wrote into the message explaining what was wrong.
  if (day < 1 || day > MAX_DAYS_IN_ANY_MONTH) {
    throw new DateError(`There is no day ${day} in any month.`);
  }
  if (year === null) year = mostRecentYear(month, day, now);
  if (day > daysInMonth(year, month)) {
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
