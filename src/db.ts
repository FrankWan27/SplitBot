import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Storage model
 * -------------
 * Balances are kept as one row per *pair* of users per guild, not as a running
 * total per user. A pair is stored with its two user ids sorted lexicographically
 * into (user_lo, user_hi) so that the pair (A,B) and the pair (B,A) can never
 * both exist and drift apart.
 *
 * `balance_cents` is signed and always read in the same direction:
 *
 *     balance_cents > 0  =>  user_hi owes user_lo that many cents
 *     balance_cents < 0  =>  user_lo owes user_hi that many cents
 *     balance_cents = 0  =>  settled
 *
 * `entries` is an append-only audit log of every bill and payment. Nothing reads
 * it to compute balances - it exists so a disputed balance can be reconstructed.
 */

export interface PairBalance {
  /** The user who is owed money. */
  creditor: string;
  /** The user who owes money. */
  debtor: string;
  /** Always positive. */
  cents: number;
}

export interface BillSplit {
  userId: string;
  shareCents: number;
}

/** A logged bill, with the shares it was split into. */
export interface BillEntry {
  kind: 'bill';
  id: number;
  description: string | null;
  payerId: string;
  totalCents: number;
  splits: BillSplit[];
  createdBy: string;
  createdAt: string;
  /** When it happened, if it was backdated. Null means "same as createdAt". */
  occurredAt: string | null;
}

/** A logged payment from one person to another. */
export interface PaymentEntry {
  kind: 'payment';
  id: number;
  fromId: string;
  toId: string;
  cents: number;
  createdBy: string;
  createdAt: string;
}

export type LedgerEntry = BillEntry | PaymentEntry;

/**
 * When an entry happened, for display and ordering. A backdated bill reports the
 * date it was given; everything else reports when it was logged.
 */
export function entryWhen(entry: LedgerEntry): string {
  return (entry.kind === 'bill' ? entry.occurredAt : null) ?? entry.createdAt;
}

/**
 * Rebuild a typed entry from its stored row.
 *
 * `detail_json` holds a different shape per kind, and it is data we wrote
 * ourselves, so a parse failure means the row is corrupt rather than untrusted.
 * Rather than throw and take out the whole history listing, a bad payload
 * degrades to empty splits - the amount and payer, which live in real columns,
 * are still correct and still displayable.
 */
function toLedgerEntry(row: {
  id: number;
  kind: string;
  description: string | null;
  payer_id: string;
  total_cents: number;
  created_by: string;
  created_at: string;
  occurred_at: string | null;
  detail_json: string;
}): LedgerEntry {
  let detail: unknown;
  try {
    detail = JSON.parse(row.detail_json);
  } catch {
    detail = null;
  }

  if (row.kind === 'payment') {
    const d = (detail ?? {}) as { from?: unknown; to?: unknown };
    return {
      kind: 'payment',
      id: row.id,
      // payer_id is the payer for both kinds, so it is the reliable fallback.
      fromId: typeof d.from === 'string' ? d.from : row.payer_id,
      toId: typeof d.to === 'string' ? d.to : '',
      cents: row.total_cents,
      createdBy: row.created_by,
      createdAt: row.created_at,
    };
  }

  const splits = Array.isArray(detail)
    ? (detail as unknown[]).filter(
        (s): s is BillSplit =>
          typeof s === 'object' &&
          s !== null &&
          typeof (s as BillSplit).userId === 'string' &&
          typeof (s as BillSplit).shareCents === 'number',
      )
    : [];

  return {
    kind: 'bill',
    id: row.id,
    description: row.description,
    payerId: row.payer_id,
    totalCents: row.total_cents,
    splits,
    createdBy: row.created_by,
    createdAt: row.created_at,
    // A database written before this column existed reports it as undefined.
    occurredAt: row.occurred_at ?? null,
  };
}

/** Whether `userId` appears in an entry in any role. */
function entryInvolves(entry: LedgerEntry, userId: string): boolean {
  if (entry.kind === 'payment') {
    return entry.fromId === userId || entry.toId === userId;
  }
  return entry.payerId === userId || entry.splits.some((s) => s.userId === userId);
}

/**
 * Tables only. Indexes live separately in `INDEXES` because an index can name a
 * column that `ADDED_COLUMNS` has yet to add, and creating it first fails.
 */
const TABLES = `
CREATE TABLE IF NOT EXISTS balances (
  guild_id      TEXT    NOT NULL,
  user_lo       TEXT    NOT NULL,
  user_hi       TEXT    NOT NULL,
  balance_cents INTEGER NOT NULL,
  PRIMARY KEY (guild_id, user_lo, user_hi),
  CHECK (user_lo < user_hi)
) STRICT;

CREATE TABLE IF NOT EXISTS entries (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id      TEXT    NOT NULL,
  kind          TEXT    NOT NULL CHECK (kind IN ('bill', 'payment')),
  description   TEXT,
  payer_id      TEXT    NOT NULL,
  total_cents   INTEGER NOT NULL,
  created_by    TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  -- When the bill actually happened, when that differs from when it was logged.
  -- Null on a normal entry, so created_at remains the record of what was entered
  -- when and a backdated entry stays identifiable.
  occurred_at   TEXT,
  detail_json   TEXT    NOT NULL
) STRICT;
`;

/** Applied after the migration below, so every column they name exists. */
const INDEXES = `
CREATE INDEX IF NOT EXISTS idx_entries_guild ON entries (guild_id, id DESC);

-- /history orders by when things happened, falling back to insertion order for
-- entries that were never backdated.
CREATE INDEX IF NOT EXISTS idx_entries_guild_when
  ON entries (guild_id, COALESCE(occurred_at, created_at) DESC, id DESC);
`;

/**
 * Columns added after the first release. `CREATE TABLE IF NOT EXISTS` leaves an
 * existing table alone, so a database created before a column existed needs it
 * added explicitly. Each is nullable with no default, which is what makes this
 * safe to apply to rows already written.
 */
const ADDED_COLUMNS: Array<{ table: string; column: string; type: string }> = [
  { table: 'entries', column: 'occurred_at', type: 'TEXT' },
];

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true });
    }
    this.db = new DatabaseSync(path);
    // WAL keeps readers from blocking the single writer; NORMAL is durable enough
    // for a friend-group ledger and avoids an fsync on every command.
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec(TABLES);
    this.addMissingColumns();
    this.db.exec(INDEXES);
  }

  /**
   * Bring an older database up to the current schema. Runs on every open, which
   * is cheap: it reads the table definition and does nothing when the column is
   * already there.
   */
  private addMissingColumns(): void {
    for (const { table, column, type } of ADDED_COLUMNS) {
      const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name: string;
      }>;
      if (existing.some((c) => c.name === column)) continue;
      // Not parameterisable - identifiers cannot be bound - but these values are
      // the hardcoded constants above, never user input.
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }

  close(): void {
    this.db.close();
  }

  /**
   * Run `fn` inside a single write transaction. Discord hands us commands
   * concurrently, so a bill that touches five pairs must apply all five updates
   * or none - otherwise a crash mid-bill leaves the ledger unbalanced.
   */
  private transact<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A rollback failure would mask the original error; the original is
        // the useful one, so it is rethrown below regardless.
      }
      throw err;
    }
  }

  /**
   * Move `cents` of debt so that `debtor` owes `creditor` more by that amount.
   * Passing a negative `cents` moves debt the other way, which is how payments
   * are recorded. Must be called inside a transaction.
   */
  private applyDebt(guildId: string, creditor: string, debtor: string, cents: number): void {
    if (creditor === debtor) {
      throw new Error('applyDebt called with the same user on both sides');
    }
    // Normalise to the canonical pair ordering, flipping the sign if the
    // creditor happens to sort second.
    const [lo, hi] = creditor < debtor ? [creditor, debtor] : [debtor, creditor];
    const delta = creditor === lo ? cents : -cents;

    this.db
      .prepare(
        `INSERT INTO balances (guild_id, user_lo, user_hi, balance_cents)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (guild_id, user_lo, user_hi)
         DO UPDATE SET balance_cents = balance_cents + excluded.balance_cents`,
      )
      .run(guildId, lo, hi, delta);

    // Keep the table free of settled pairs so listings stay clean.
    this.db
      .prepare(
        'DELETE FROM balances WHERE guild_id = ? AND user_lo = ? AND user_hi = ? AND balance_cents = 0',
      )
      .run(guildId, lo, hi);
  }

  /**
   * Record a bill: `payerId` fronted `totalCents`, and each entry in `splits`
   * owes their share back. The payer's own share, if any, is skipped rather than
   * booked as a debt to themselves.
   */
  recordBill(args: {
    guildId: string;
    payerId: string;
    totalCents: number;
    splits: BillSplit[];
    description: string | null;
    createdBy: string;
    createdAt: string;
    /** When it happened, if backdated. Null means it happened when it was logged. */
    occurredAt?: string | null;
  }): void {
    this.transact(() => {
      for (const { userId, shareCents } of args.splits) {
        if (userId === args.payerId || shareCents === 0) continue;
        this.applyDebt(args.guildId, args.payerId, userId, shareCents);
      }
      this.db
        .prepare(
          `INSERT INTO entries
             (guild_id, kind, description, payer_id, total_cents, created_by, created_at,
              occurred_at, detail_json)
           VALUES (?, 'bill', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.guildId,
          args.description,
          args.payerId,
          args.totalCents,
          args.createdBy,
          args.createdAt,
          args.occurredAt ?? null,
          JSON.stringify(args.splits),
        );
    });
  }

  /**
   * Record that `fromId` paid `toId` `cents`, reducing what `fromId` owes.
   * Returns the pair balance as it stood before and after the payment so the
   * caller can report overpayment or a flipped direction honestly.
   */
  recordPayment(args: {
    guildId: string;
    fromId: string;
    toId: string;
    cents: number;
    createdBy: string;
    createdAt: string;
  }): { beforeCents: number; afterCents: number } {
    return this.transact(() => {
      // Signed in the direction "fromId owes toId", so a positive number is debt
      // being paid down and a negative number means they were already square.
      const before = this.owedBetween(args.guildId, args.fromId, args.toId);
      this.applyDebt(args.guildId, args.toId, args.fromId, -args.cents);
      const after = this.owedBetween(args.guildId, args.fromId, args.toId);

      this.db
        .prepare(
          `INSERT INTO entries
             (guild_id, kind, description, payer_id, total_cents, created_by, created_at, detail_json)
           VALUES (?, 'payment', NULL, ?, ?, ?, ?, ?)`,
        )
        .run(
          args.guildId,
          args.fromId,
          args.cents,
          args.createdBy,
          args.createdAt,
          JSON.stringify({ from: args.fromId, to: args.toId }),
        );

      return { beforeCents: before, afterCents: after };
    });
  }

  /** How much `debtor` currently owes `creditor`; negative means the reverse. */
  owedBetween(guildId: string, debtor: string, creditor: string): number {
    const [lo, hi] = debtor < creditor ? [debtor, creditor] : [creditor, debtor];
    const row = this.db
      .prepare(
        'SELECT balance_cents FROM balances WHERE guild_id = ? AND user_lo = ? AND user_hi = ?',
      )
      .get(guildId, lo, hi) as { balance_cents: number } | undefined;
    if (!row) return 0;
    // Stored as "hi owes lo". Flip when the debtor we were asked about is `lo`.
    return debtor === hi ? row.balance_cents : -row.balance_cents;
  }

  /**
   * Most recent entries first, optionally only those involving `userId`.
   *
   * "Involving" deliberately covers every role a person can play: the payer of a
   * bill, one of its split participants, or either side of a payment. Filtering
   * on `payer_id` alone would hide the bills you were charged for, which is the
   * most likely reason to look at your own history.
   *
   * Fetches one extra row beyond `limit` so the caller can tell "exactly this
   * many" from "there are older ones" without a second COUNT query.
   *
   * `offset` skips that many matching entries, which is what the paging buttons
   * on `/history` walk through.
   *
   * Ordered by when entries *happened*, so a backdated bill sits in its true
   * chronological place rather than jumping to the top because it was typed last.
   * Insertion order breaks ties, which keeps two bills on the same date stable.
   */
  recentEntries(args: {
    guildId: string;
    userId?: string;
    limit: number;
    offset?: number;
  }): { entries: LedgerEntry[]; hasMore: boolean } {
    const offset = args.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`recentEntries offset must be a non-negative integer, got ${offset}`);
    }

    const rows = this.db
      .prepare(
        `SELECT id, kind, description, payer_id, total_cents, created_by, created_at,
                occurred_at, detail_json
           FROM entries WHERE guild_id = ?
          ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC`,
      )
      .all(args.guildId) as Array<{
      id: number;
      kind: string;
      description: string | null;
      payer_id: string;
      total_cents: number;
      created_by: string;
      created_at: string;
      occurred_at: string | null;
      detail_json: string;
    }>;

    // The user filter cannot be expressed in SQL - it depends on the parsed JSON
    // splits - so matches are skipped here rather than with SQL OFFSET.
    const parsed: LedgerEntry[] = [];
    let skipped = 0;
    for (const r of rows) {
      const entry = toLedgerEntry(r);
      if (args.userId !== undefined && !entryInvolves(entry, args.userId)) continue;
      if (skipped < offset) {
        skipped++;
        continue;
      }
      parsed.push(entry);
      // One past the limit is enough to know more exist; stop scanning there so
      // a long-lived guild does not parse its entire history on every call.
      if (parsed.length > args.limit) break;
    }

    const hasMore = parsed.length > args.limit;
    return { entries: hasMore ? parsed.slice(0, args.limit) : parsed, hasMore };
  }

  /** Every outstanding debt in the guild, largest first. */
  allBalances(guildId: string): PairBalance[] {
    const rows = this.db
      .prepare(
        `SELECT user_lo, user_hi, balance_cents FROM balances
         WHERE guild_id = ? AND balance_cents != 0`,
      )
      .all(guildId) as Array<{ user_lo: string; user_hi: string; balance_cents: number }>;

    return rows
      .map(({ user_lo, user_hi, balance_cents }) =>
        balance_cents > 0
          ? { creditor: user_lo, debtor: user_hi, cents: balance_cents }
          : { creditor: user_hi, debtor: user_lo, cents: -balance_cents },
      )
      .sort((x, y) => y.cents - x.cents);
  }

  /** Every outstanding debt involving `userId`, largest first. */
  balancesFor(guildId: string, userId: string): PairBalance[] {
    return this.allBalances(guildId).filter(
      (b) => b.creditor === userId || b.debtor === userId,
    );
  }
}
