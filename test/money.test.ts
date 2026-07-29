import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatCents,
  parseAmountToCents,
  splitEvenly,
  MoneyError,
} from '../src/money.js';

test('parses common amount formats', () => {
  assert.equal(parseAmountToCents('12'), 1200);
  assert.equal(parseAmountToCents('12.5'), 1250);
  assert.equal(parseAmountToCents('12.50'), 1250);
  assert.equal(parseAmountToCents('$12.50'), 1250);
  assert.equal(parseAmountToCents('1,234.56'), 123456);
  assert.equal(parseAmountToCents('  8.09  '), 809);
  assert.equal(parseAmountToCents('0.01'), 1);
  // Stray grouping commas are stripped rather than rejected; people paste totals.
  assert.equal(parseAmountToCents('12,'), 1200);
});

test('rejects amounts that are not usable money', () => {
  for (const bad of ['', 'abc', '-5', '0', '0.00', '12.345', '1.2.3', '$', 'NaN', '1e3', '1 2']) {
    assert.throws(() => parseAmountToCents(bad), MoneyError, `expected ${bad} to be rejected`);
  }
});

test('rejects absurdly large amounts', () => {
  assert.throws(() => parseAmountToCents('99999999'), MoneyError);
});

test('parsing avoids float error on values that break naive multiplication', () => {
  // 0.29 * 100 is 28.999999999999996 in IEEE-754; string parsing must not care.
  assert.equal(parseAmountToCents('0.29'), 29);
  assert.equal(parseAmountToCents('1.15'), 115);
  assert.equal(parseAmountToCents('4.35'), 435);
});

test('formats cents for display', () => {
  assert.equal(formatCents(0), '$0.00');
  assert.equal(formatCents(5), '$0.05');
  assert.equal(formatCents(1250), '$12.50');
  assert.equal(formatCents(123456), '$1,234.56');
  assert.equal(formatCents(-1250), '-$12.50');
  assert.equal(formatCents(100000000), '$1,000,000.00');
});

test('even splits divide exactly, with no randomness involved', () => {
  // Nothing is left over, so the rng must never be consulted and every share is
  // identical regardless of it.
  const explode = () => {
    throw new Error('rng must not be called when the total divides evenly');
  };
  assert.deepEqual(splitEvenly(1000, 4, explode), [250, 250, 250, 250]);
  assert.deepEqual(splitEvenly(900, 3, explode), [300, 300, 300]);
});

test('leftover pennies go to randomly chosen participants', () => {
  // A stubbed rng picks a known winner: returning 0 always takes the first
  // remaining candidate, so the extra penny lands on index 0.
  assert.deepEqual(splitEvenly(1000, 3, () => 0), [334, 333, 333]);

  // Returning just under 1 always takes the last remaining candidate.
  assert.deepEqual(splitEvenly(1000, 3, () => 0.999999), [333, 333, 334]);
});

test('each spare penny goes to a different person', () => {
  // Two pennies over three people must land on two distinct participants, never
  // both on one. A fixed 0 would pick index 0 twice if the draw were naive.
  const shares = splitEvenly(1001, 3, () => 0);
  assert.equal(
    shares.reduce((a, b) => a + b, 0),
    1001,
  );
  assert.equal(shares.filter((s) => s === 334).length, 2, 'two distinct people got a penny');
  assert.equal(shares.filter((s) => s === 333).length, 1);
});

test('nobody is drawn twice, at any remainder or under any generator', () => {
  // A repeat draw shows up as a share of base + 2, and starves someone who
  // should have won. Fixed generators are the cases a naive draw collides on.
  const BASE = 7;
  const generators: [string, (() => number) | undefined][] = [
    ['real randomness', undefined],
    ['always lowest', () => 0],
    ['always highest', () => 0.999999],
    ['always middle', () => 0.5],
    ['out of range', () => 1.5],
    ['negative', () => -0.5],
    ['not a number', () => Number.NaN],
  ];

  for (const [label, rng] of generators) {
    for (let count = 1; count <= 12; count++) {
      for (let remainder = 0; remainder < count; remainder++) {
        const total = BASE * count + remainder;
        const shares = rng ? splitEvenly(total, count, rng) : splitEvenly(total, count);

        assert.ok(
          shares.every((s) => s === BASE || s === BASE + 1),
          `${label}: a share was drawn more than once (${shares.join(',')})`,
        );
        assert.equal(
          shares.filter((s) => s === BASE + 1).length,
          remainder,
          `${label}: ${remainder} distinct people should each have one extra penny`,
        );
        assert.equal(
          shares.reduce((a, b) => a + b, 0),
          total,
          `${label}: total must stay intact`,
        );
      }
    }
  }
});

test('when every participant is drawn, each gets exactly one penny', () => {
  // The largest possible remainder: all but one person wins, leaving a repeat
  // draw nowhere to hide.
  const shares = splitEvenly(7 * 10 + 9, 10);
  assert.equal(shares.filter((s) => s === 8).length, 9);
  assert.equal(shares.filter((s) => s === 7).length, 1);
  assert.equal(
    shares.reduce((a, b) => a + b, 0),
    79,
  );
});

test('the extra penny does not always land on the same person', () => {
  // The whole point of the change: over many splits every position should win at
  // least once. Uses real randomness, so it is a genuine check of the shipped
  // behaviour rather than of a stub.
  const winners = new Set<number>();
  for (let i = 0; i < 400; i++) {
    winners.add(splitEvenly(1000, 3).indexOf(334));
  }
  assert.deepEqual(
    [...winners].sort(),
    [0, 1, 2],
    'every participant should receive the odd penny sometimes',
  );
});

test('the odd penny is distributed roughly uniformly', () => {
  // Guards against a subtly biased draw, e.g. an off-by-one that makes the last
  // position unreachable or twice as likely. 6000 trials over 3 positions gives
  // an expected 2000 each; a fair draw stays inside 15% with overwhelming
  // probability, while any real bias blows well past it.
  const counts = [0, 0, 0];
  const trials = 6000;
  for (let i = 0; i < trials; i++) {
    counts[splitEvenly(1000, 3).indexOf(334)]! += 1;
  }
  const expected = trials / 3;
  for (const [i, c] of counts.entries()) {
    assert.ok(
      Math.abs(c - expected) < expected * 0.15,
      `position ${i} won ${c} of ${trials} times, expected about ${expected}`,
    );
  }
});

test('splits always sum to the total across many shapes', () => {
  for (let total = 1; total <= 400; total++) {
    for (let count = 1; count <= 12; count++) {
      const shares = splitEvenly(total, count);
      assert.equal(shares.length, count);
      assert.equal(
        shares.reduce((a, b) => a + b, 0),
        total,
        `${total} split ${count} ways did not sum back`,
      );
      assert.ok(shares.every((s) => s >= 0));
      // Randomising *who* gets a penny must not change that no two shares differ
      // by more than one cent.
      assert.ok(Math.max(...shares) - Math.min(...shares) <= 1);
    }
  }
});

test('a malformed rng cannot break the total', () => {
  // An rng returning out-of-range values must not index past the end and lose a
  // penny; the ledger has to balance even if the generator misbehaves.
  for (const bad of [() => 1, () => 1.5, () => -0.5, () => Number.NaN]) {
    const shares = splitEvenly(1000, 3, bad);
    assert.equal(
      shares.reduce((a, b) => a + b, 0),
      1000,
      'total must survive a broken rng',
    );
    assert.ok(shares.every((s) => Number.isInteger(s) && s >= 0));
  }
});

test('rejects nonsensical split requests', () => {
  assert.throws(() => splitEvenly(0, 3), MoneyError);
  assert.throws(() => splitEvenly(-100, 3), MoneyError);
  assert.throws(() => splitEvenly(100, 0), MoneyError);
  assert.throws(() => splitEvenly(100.5, 3), MoneyError);
});
