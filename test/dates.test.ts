import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDateToIso, DateError } from '../src/dates.js';

/**
 * A fixed "now" so these tests do not change meaning with the calendar.
 * 2026-07-28 is a Tuesday, mid-year, in a non-leap year.
 */
const NOW = new Date('2026-07-28T15:30:00.000Z');

/** The stored date, without the time-of-day noise. */
function day(raw: string, now = NOW): string {
  return parseDateToIso(raw, now).slice(0, 10);
}

test('explicit ISO dates are taken literally', () => {
  assert.equal(day('2026-07-20'), '2026-07-20');
  assert.equal(day('2026-01-01'), '2026-01-01');
  assert.equal(day('2025-12-31'), '2025-12-31');
});

test('today and yesterday resolve against the supplied clock', () => {
  assert.equal(day('today'), '2026-07-28');
  assert.equal(day('yesterday'), '2026-07-27');
  assert.equal(day('Yesterday'), '2026-07-27', 'case does not matter');
  assert.equal(day('  today  '), '2026-07-28', 'surrounding space is trimmed');
});

test('yesterday crosses a month and a year boundary correctly', () => {
  assert.equal(day('yesterday', new Date('2026-08-01T09:00:00.000Z')), '2026-07-31');
  assert.equal(day('yesterday', new Date('2026-01-01T09:00:00.000Z')), '2025-12-31');
  assert.equal(day('yesterday', new Date('2024-03-01T09:00:00.000Z')), '2024-02-29', 'leap day');
});

test('slashed dates are read month-first, matching how amounts are formatted', () => {
  assert.equal(day('7/20'), '2026-07-20');
  assert.equal(day('7/20/2026'), '2026-07-20');
  assert.equal(day('12/25/2025'), '2025-12-25');
});

test('a bare M/D means the most recent time that date happened', () => {
  // Typed in July, a December date has to be last December: the alternative is
  // five months in the future, which cannot have happened yet.
  assert.equal(day('12/28'), '2025-12-28');
  assert.equal(day('7/28'), '2026-07-28', 'today itself stays in this year');
  assert.equal(day('7/29'), '2025-07-29', 'tomorrow-ish rolls back a year');
  assert.equal(day('1/1'), '2026-01-01');
});

test('the stored time is noon UTC, so the day holds across UTC-12 to UTC+11', () => {
  const iso = parseDateToIso('2026-07-20', NOW);
  assert.equal(iso, '2026-07-20T12:00:00.000Z');

  // The failure this prevents: UTC midnight renders as the previous day for
  // every reader west of Greenwich, which is most of them.
  const stored = new Date(iso);
  for (const offsetHours of [-12, -11, -8, -5, -3.5, 0, 1, 5.5, 9, 11]) {
    const local = new Date(stored.getTime() + offsetHours * 3_600_000);
    assert.equal(
      local.toISOString().slice(0, 10),
      '2026-07-20',
      `date shifted at UTC${offsetHours >= 0 ? '+' : ''}${offsetHours}`,
    );
  }
});

test('the far side of the date line is a known, bounded limitation', () => {
  // Real offsets span UTC-12 to UTC+14 - 26 hours - so no single stored hour can
  // keep the calendar day intact everywhere. Noon covers UTC-12 to UTC+11, and
  // slips one day forward beyond that. Asserted rather than left to be
  // discovered: /history renders these as relative times ("6 days ago"), so the
  // shift is invisible today, but printing an absolute date would expose it.
  const stored = new Date(parseDateToIso('2026-07-20', NOW));
  for (const offsetHours of [12, 13, 14]) {
    const local = new Date(stored.getTime() + offsetHours * 3_600_000);
    assert.equal(local.toISOString().slice(0, 10), '2026-07-21');
  }
});

test('leap years are handled by the real Gregorian rule', () => {
  assert.equal(day('2024-02-29', new Date('2026-07-28T00:00:00.000Z')), '2024-02-29');
  // 2100 is not a leap year, but it is also in the future - so check the rule
  // through a past century year instead. 2000 was a leap year; 1900 was not.
  assert.throws(() => parseDateToIso('2023-02-29', NOW), DateError, 'no Feb 29 in 2023');
  assert.throws(() => parseDateToIso('2022-02-30', NOW), DateError);
});

test('impossible calendar dates are refused, not silently rolled forward', () => {
  // new Date('2026-06-31') would give July 1. Rolling a typo into a real date
  // is worse than refusing it, since the user never sees the correction.
  for (const bad of ['2026-06-31', '2026-04-31', '2026-02-30', '2026-13-01', '2026-00-10']) {
    assert.throws(() => parseDateToIso(bad, NOW), DateError, `${bad} should be refused`);
  }
  assert.throws(() => parseDateToIso('2026-01-32', NOW), DateError);
  assert.throws(() => parseDateToIso('2026-01-00', NOW), DateError);
});

test('future dates are refused, since the bill cannot have happened', () => {
  assert.throws(
    () => parseDateToIso('2026-08-05', NOW),
    /future/,
    'a week ahead is a future bill',
  );
  assert.throws(() => parseDateToIso('2027-01-01', NOW), /future/);

  // Tomorrow is allowed: a date is a calendar day, and someone far enough east
  // can write their own local date and land ahead of noon UTC.
  assert.equal(day('2026-07-29'), '2026-07-29');
});

test('a date too far in the past is treated as a mistyped year', () => {
  assert.throws(() => parseDateToIso('1999-07-20', NOW), /years ago/);
  assert.throws(() => parseDateToIso('2019-07-20', NOW), /years ago/);
  assert.equal(day('2023-07-20'), '2023-07-20', 'a few years back is fine');
});

test('a two-digit year is refused rather than guessed at', () => {
  // "26" could be 2026 or 1926. Guessing would be wrong sooner or later.
  assert.throws(() => parseDateToIso('26-07-20', NOW), /year in full/);
  assert.throws(() => parseDateToIso('7/20/26', NOW), /year in full/);
});

test('unparseable input is rejected with an example, not accepted loosely', () => {
  // Every one of these is something new Date() would accept or mangle.
  for (const bad of [
    '',
    '   ',
    'sometime last week',
    'tomorrow',
    'July 20',
    '20 July 2026',
    '2026',
    '2026-07',
    '7',
    '2026-07-20-01',
    'not-a-date',
    '--',
    '//',
    '2026/07/20/1',
    'NaN',
    '2026-ab-cd',
  ]) {
    assert.throws(
      () => parseDateToIso(bad, NOW),
      DateError,
      `"${bad}" should be refused, not interpreted`,
    );
  }
});

test('the error message shows what could not be understood', () => {
  assert.throws(() => parseDateToIso('last tuesday', NOW), /last tuesday/);
});

test('every accepted date lands on noon UTC exactly', () => {
  for (const raw of ['today', 'yesterday', '2026-07-20', '7/20', '12/25/2025', '2024-02-29']) {
    const iso = parseDateToIso(raw, NOW);
    assert.match(iso, /T12:00:00\.000Z$/, `${raw} should store as noon UTC`);
  }
});

test('a real clock works, not just the injected one', () => {
  // The default parameter is the path production takes, so it gets exercised.
  const today = parseDateToIso('today');
  assert.equal(today.slice(0, 10), new Date().toISOString().slice(0, 10));
  assert.doesNotThrow(() => parseDateToIso('yesterday'));
});
