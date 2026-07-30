import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseDateToIso,
  DateError,
  dayKey,
  dayHeading,
  displayTimeZone,
} from '../src/dates.js';

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

test('a month can be named in full or abbreviated, in any case', () => {
  assert.equal(day('July 24'), '2026-07-24');
  assert.equal(day('july 24'), '2026-07-24');
  assert.equal(day('JULY 24'), '2026-07-24');
  assert.equal(day('Jul 24'), '2026-07-24', 'three letters is the usual abbreviation');
  assert.equal(day('JUL 24'), '2026-07-24');
  assert.equal(day('jUl 24'), '2026-07-24');
});

test('every month is recognised by name and by its first three letters', () => {
  const names = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  names.forEach((name, i) => {
    const month = String(i + 1).padStart(2, '0');
    // The 1st of each month is in the past this year for January to July and last
    // year beyond that, which is the most-recent-occurrence rule, not a bug.
    const year = i + 1 <= 7 ? '2026' : '2025';
    assert.equal(day(`${name} 1`), `${year}-${month}-01`, name);
    assert.equal(day(`${name.slice(0, 3)} 1`), `${year}-${month}-01`, name.slice(0, 3));
  });
  // `May` is its own abbreviation, and `Sept` is common enough to be worth taking.
  assert.equal(day('Sept 1'), '2025-09-01');
});

test('a named month with no year means the most recent time it happened', () => {
  assert.equal(day('Dec 28'), '2025-12-28', 'five months ahead cannot have happened');
  assert.equal(day('July 28'), '2026-07-28', 'today itself stays in this year');
  assert.equal(day('July 29'), '2025-07-29', 'tomorrow-ish rolls back a year');
  assert.equal(day('Jan 1'), '2026-01-01');
});

test('a named month takes an explicit year, with or without the comma', () => {
  assert.equal(day('July 20, 2026'), '2026-07-20');
  assert.equal(day('July 20 2026'), '2026-07-20');
  assert.equal(day('Dec 25, 2025'), '2025-12-25');
  assert.equal(day('  jul   20 ,  2026  '), '2026-07-20', 'spacing is not load-bearing');
  assert.equal(day('Jul. 20'), '2026-07-20', 'an abbreviating period carries no meaning');
});

test('a named month is validated like a numeric one, not trusted', () => {
  assert.throws(() => parseDateToIso('Feb 30', NOW), /does not have a day 30/);
  assert.throws(
    () => parseDateToIso('Feb 30, 2024', NOW),
    /does not have a day 30/,
    'a leap year has no 30th either',
  );
  // A day no month has cannot name a year either, so it is refused without one
  // rather than reported against a year the user never wrote.
  assert.throws(() => parseDateToIso('Jul 0', NOW), /no day 0 in any month/);
  assert.throws(() => parseDateToIso('Jul 32', NOW), /no day 32 in any month/);
  assert.throws(() => parseDateToIso('7/32', NOW), /no day 32 in any month/);
  assert.throws(() => parseDateToIso('Jul 20, 26', NOW), /year in full/);
  assert.throws(() => parseDateToIso('Aug 1, 2027', NOW), /future/);
  assert.throws(() => parseDateToIso('Jul 20, 2019', NOW), /years ago/);
  // Feb 29 exists in 2024 and not in 2026, and the year-less form has to pick a
  // real one rather than land on the 29th of a non-leap February.
  assert.equal(day('Feb 29, 2024'), '2024-02-29');
  assert.throws(() => parseDateToIso('Feb 29', NOW), /does not have a day 29/);
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
    '20 July 2026',
    'julyish 20',
    'jul',
    'july 20 2026 extra',
    'janu 4',
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
  for (const raw of [
    'today',
    'yesterday',
    '2026-07-20',
    '7/20',
    '12/25/2025',
    '2024-02-29',
    'July 20',
    'JUL 20',
    'July 20, 2026',
  ]) {
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

test('a day key is the calendar day in the given zone, not in UTC', () => {
  // 6pm in Los Angeles on the 27th is already the 28th in UTC. Grouping has to
  // follow the configured zone or an evening bill lands under tomorrow.
  const evening = '2026-07-28T01:00:00.000Z';
  assert.equal(dayKey(evening, 'UTC'), '2026-07-28');
  assert.equal(dayKey(evening, 'America/Los_Angeles'), '2026-07-27');
});

test('two entries hours apart on the same local day share a key', () => {
  const morning = dayKey('2026-07-27T15:00:00.000Z', 'America/Los_Angeles');
  const evening = dayKey('2026-07-28T02:00:00.000Z', 'America/Los_Angeles');
  assert.equal(morning, '2026-07-27');
  assert.equal(evening, morning, 'same local day means one heading, not two');
});

test('a day key is null for a timestamp that cannot be parsed', () => {
  // A corrupt row must not invent a heading of its own.
  assert.equal(dayKey('not a date', 'UTC'), null);
  assert.equal(dayHeading('not a date', 'UTC'), null);
});

test('a heading is MM/DD, zero-padded, with no year in the current year', () => {
  const now = new Date('2026-07-28T00:00:00.000Z');
  assert.equal(dayHeading('2026-07-27T12:00:00.000Z', 'UTC', now), '07/27');
  // Zero-padded on both halves, so headings line up down the listing.
  assert.equal(dayHeading('2026-01-05T12:00:00.000Z', 'UTC', now), '01/05');
});

test('a heading from another year carries the year, since MM/DD alone would lie', () => {
  const now = new Date('2026-07-28T00:00:00.000Z');
  assert.equal(dayHeading('2025-12-25T12:00:00.000Z', 'UTC', now), '12/25/2025');
});

test('a heading follows the display zone, matching the key it groups under', () => {
  const now = new Date('2026-07-28T00:00:00.000Z');
  const evening = '2026-07-28T01:00:00.000Z';
  assert.equal(dayHeading(evening, 'America/Los_Angeles', now), '07/27');
  // The heading and the key must agree, or entries would group under a heading
  // naming a different day than they belong to.
  assert.equal(dayKey(evening, 'America/Los_Angeles'), '2026-07-27');
});

test('a noon-UTC stored date keeps its day in the zones the parser claims', () => {
  // The backdating parser stores noon UTC precisely so the day survives display.
  const iso = parseDateToIso('2026-07-20', NOW);
  for (const zone of ['UTC', 'America/Los_Angeles', 'Europe/Berlin', 'Asia/Tokyo']) {
    assert.equal(dayKey(iso, zone), '2026-07-20', `slipped in ${zone}`);
  }
});

test('the display zone defaults to UTC and rejects a name it does not know', () => {
  const original = process.env['DISPLAY_TIMEZONE'];
  try {
    delete process.env['DISPLAY_TIMEZONE'];
    assert.equal(displayTimeZone(), 'UTC', 'no configuration means UTC');

    process.env['DISPLAY_TIMEZONE'] = 'America/Los_Angeles';
    assert.equal(displayTimeZone(), 'America/Los_Angeles');

    process.env['DISPLAY_TIMEZONE'] = '   ';
    assert.equal(displayTimeZone(), 'UTC', 'blank is not a zone');

    // A typo must not take the listing down; grouping by UTC is the safe fallback.
    process.env['DISPLAY_TIMEZONE'] = 'Mars/Olympus_Mons';
    assert.equal(displayTimeZone(), 'UTC');
  } finally {
    if (original === undefined) delete process.env['DISPLAY_TIMEZONE'];
    else process.env['DISPLAY_TIMEZONE'] = original;
  }
});
