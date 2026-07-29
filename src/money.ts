/**
 * All money in this bot is handled as integer cents. Floating point dollars are
 * never used for arithmetic or storage, because repeated float rounding silently
 * loses pennies and a ledger that does not sum to zero is worthless.
 */

import { UserError } from './errors.js';

export const MAX_AMOUNT_CENTS = 100_000_000; // $1,000,000 sanity ceiling per entry

export class MoneyError extends UserError {}

/**
 * Parse a user-supplied dollar amount into integer cents.
 * Accepts forms like "12", "12.5", "12.50", "$12.50", "1,234.56".
 * Rejects negatives, zero, >2 decimal places, and anything non-numeric.
 */
export function parseAmountToCents(raw: string): number {
  const cleaned = raw.trim().replace(/^\$/, '').replace(/,/g, '');
  if (cleaned === '') {
    throw new MoneyError('Enter an amount, for example `12.50`.');
  }
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    if (/^-/.test(cleaned)) {
      throw new MoneyError('Amount must be positive.');
    }
    if (/^\d+\.\d{3,}$/.test(cleaned)) {
      throw new MoneyError('Amount cannot have more than 2 decimal places.');
    }
    throw new MoneyError(`\`${raw}\` is not a valid amount. Try something like \`12.50\`.`);
  }

  const [dollarPart, centPart = ''] = cleaned.split('.');
  const cents = Number(dollarPart) * 100 + Number(centPart.padEnd(2, '0'));

  if (cents === 0) {
    throw new MoneyError('Amount must be greater than zero.');
  }
  if (cents > MAX_AMOUNT_CENTS) {
    throw new MoneyError(`Amount is too large (max ${formatCents(MAX_AMOUNT_CENTS)}).`);
  }
  return cents;
}

/** Render integer cents as a display string, e.g. 123456 -> "$1,234.56". */
export function formatCents(cents: number): string {
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  const withCommas = dollars.toLocaleString('en-US');
  return `${negative ? '-' : ''}$${withCommas}.${String(remainder).padStart(2, '0')}`;
}

/** Returns a float in [0, 1). Injectable so tests can pin a random split. */
export type Rng = () => number;

/**
 * Split `totalCents` across `count` participants, giving each leftover penny to a
 * different randomly drawn participant - nobody is drawn twice.
 *
 * $10 three ways is always one share of $3.34 and two of $3.33; who gets the
 * extra cent is chance. Shares always sum to the total, and array positions match
 * the caller's ordering.
 */
export function splitEvenly(totalCents: number, count: number, rng: Rng = Math.random): number[] {
  if (!Number.isInteger(totalCents) || totalCents <= 0) {
    throw new MoneyError('Split total must be a positive whole number of cents.');
  }
  if (!Number.isInteger(count) || count <= 0) {
    throw new MoneyError('Need at least one participant to split between.');
  }

  const base = Math.floor(totalCents / count);
  const remainder = totalCents - base * count;
  const shares = Array.from({ length: count }, () => base);

  // Partial Fisher-Yates: each winner is swapped to the front and later draws
  // only see the tail, so nobody can be drawn twice.
  const indices = Array.from({ length: count }, (_, i) => i);
  for (let i = 0; i < remainder; i++) {
    // Clamped so a bad rng can skew who pays, never how much.
    const draw = rng();
    const offset = Number.isFinite(draw) ? Math.floor(draw * (count - i)) : 0;
    const pick = Math.min(Math.max(i + offset, i), count - 1);
    [indices[i], indices[pick]] = [indices[pick]!, indices[i]!];
    shares[indices[i]!]! += 1;
  }

  return shares;
}
