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
 *
 * Editing and deleting keep that append-only property. A delete marks the row
 * voided rather than removing it, and an edit stamps the row as edited, so the
 * log never loses the fact that something was changed. Both reverse the entry's
 * effect on balances explicitly, since balances are maintained rather than
 * derived: there is no recomputation to fall back on.
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

/** One entry's contribution to the debt between a particular pair of people. */
export interface PairContribution {
  entry: LedgerEntry;
  /** Signed as "debtor owes creditor", so a pair's contributions sum to its balance. */
  cents: number;
}

/**
 * Bookkeeping every entry carries, whatever its kind: who logged it, and whether
 * it has since been changed or deleted.
 */
interface EntryMeta {
  id: number;
  createdBy: string;
  createdAt: string;
  /** Set once the entry has been deleted; the row itself is kept. */
  voidedAt: string | null;
  voidedBy: string | null;
  /** Set once the entry has been changed, so a listing can say so. */
  editedAt: string | null;
  editedBy: string | null;
}

/** A logged bill, with the shares it was split into. */
export interface BillEntry extends EntryMeta {
  kind: 'bill';
  description: string | null;
  payerId: string;
  totalCents: number;
  splits: BillSplit[];
  /** When it happened, if it was backdated. Null means "same as createdAt". */
  occurredAt: string | null;
}

/** A logged payment from one person to another. */
export interface PaymentEntry extends EntryMeta {
  kind: 'payment';
  fromId: string;
  toId: string;
  cents: number;
}

export type LedgerEntry = BillEntry | PaymentEntry;

/** Which kinds of entry a listing covers. Empty would list nothing, so it is not allowed. */
export type EntryKind = LedgerEntry['kind'];

/**
 * The outcome of a batch delete or restore.
 *
 * A failure names the one id that stopped it rather than returning per-id results,
 * because the batch is all or nothing: on failure nothing was written, so there is
 * no partial outcome to report.
 */
export type BatchResult =
  | { ok: true; entries: LedgerEntry[] }
  | { ok: false; failedId: number };

/**
 * Thrown inside a batch to roll it back. Internal to `Store` - it never escapes,
 * because `transactBatch` converts it into a `BatchResult`.
 */
class BatchAbort extends Error {
  constructor(readonly failedId: number) {
    super(`entry ${failedId} cannot be processed`);
  }
}

/**
 * When an entry happened, for display and ordering. A backdated bill reports the
 * date it was given; everything else reports when it was logged.
 */
export function entryWhen(entry: LedgerEntry): string {
  return (entry.kind === 'bill' ? entry.occurredAt : null) ?? entry.createdAt;
}

/**
 * One row of `entries` as SQLite hands it back. The nullable-and-optional
 * columns are the ones added by migration: an older database returns them as
 * undefined rather than null.
 */
interface EntryRow {
  id: number;
  kind: string;
  description: string | null;
  payer_id: string;
  total_cents: number;
  created_by: string;
  created_at: string;
  occurred_at?: string | null;
  voided_at?: string | null;
  voided_by?: string | null;
  edited_at?: string | null;
  edited_by?: string | null;
  detail_json: string;
}

/** Every column of `entries` that `toLedgerEntry` reads. */
const ENTRY_COLUMNS = `id, kind, description, payer_id, total_cents, created_by, created_at,
                       occurred_at, voided_at, voided_by, edited_at, edited_by, detail_json`;

/**
 * Rebuild a typed entry from its stored row.
 *
 * `detail_json` holds a different shape per kind, and it is data we wrote
 * ourselves, so a parse failure means the row is corrupt rather than untrusted.
 * Rather than throw and take out the whole history listing, a bad payload
 * degrades to empty splits - the amount and payer, which live in real columns,
 * are still correct and still displayable.
 */
function toLedgerEntry(row: EntryRow): LedgerEntry {
  let detail: unknown;
  try {
    detail = JSON.parse(row.detail_json);
  } catch {
    detail = null;
  }

  // A database written before these columns existed reports them as undefined.
  const meta = {
    id: row.id,
    createdBy: row.created_by,
    createdAt: row.created_at,
    voidedAt: row.voided_at ?? null,
    voidedBy: row.voided_by ?? null,
    editedAt: row.edited_at ?? null,
    editedBy: row.edited_by ?? null,
  };

  if (row.kind === 'payment') {
    const d = (detail ?? {}) as { from?: unknown; to?: unknown };
    return {
      ...meta,
      kind: 'payment',
      // payer_id is the payer for both kinds, so it is the reliable fallback.
      fromId: typeof d.from === 'string' ? d.from : row.payer_id,
      toId: typeof d.to === 'string' ? d.to : '',
      cents: row.total_cents,
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
    ...meta,
    kind: 'bill',
    description: row.description,
    payerId: row.payer_id,
    totalCents: row.total_cents,
    splits,
    occurredAt: row.occurred_at ?? null,
  };
}

/**
 * How much `entry` moved the debt between one pair, signed so that a positive
 * number increased what `debtor` owes `creditor`. Zero when the entry does not
 * touch the pair at all.
 *
 * This is the same arithmetic `applyDebt` performed when the entry was recorded,
 * read back out per pair. It has to stay in step with `recordBill` and
 * `recordPayment` - including their skips, since a payer's own share and a zero
 * share were never booked and must not be reported as though they were.
 */
function pairEffect(entry: LedgerEntry, creditor: string, debtor: string): number {
  if (entry.kind === 'payment') {
    // recordPayment reduced what `from` owes `to`.
    if (entry.fromId === debtor && entry.toId === creditor) return -entry.cents;
    if (entry.fromId === creditor && entry.toId === debtor) return entry.cents;
    return 0;
  }

  const shareOf = (userId: string): number =>
    entry.splits.find((s) => s.userId === userId)?.shareCents ?? 0;

  // The payer fronted the money, so every other participant's share is debt owed
  // to them. A participant's own share against themselves was never booked.
  if (entry.payerId === creditor && debtor !== creditor) return shareOf(debtor);
  if (entry.payerId === debtor && creditor !== debtor) return -shareOf(creditor);
  return 0;
}

/**
 * The same entry with every amount negated, so that reversing it applies it.
 *
 * Lets one `reverseEffect` serve both directions rather than having an apply and
 * an undo that could drift apart.
 */
function negated(entry: LedgerEntry): LedgerEntry {
  if (entry.kind === 'payment') return { ...entry, cents: -entry.cents };
  return {
    ...entry,
    totalCents: -entry.totalCents,
    splits: entry.splits.map((s) => ({ ...s, shareCents: -s.shareCents })),
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
  -- Deleting marks the row instead of removing it, so the log stays append-only
  -- and an accidental delete is recoverable. Null means the entry is live.
  voided_at     TEXT,
  voided_by     TEXT,
  -- Set when an entry has been changed, so a listing can say it was edited
  -- without having to store the superseded values.
  edited_at     TEXT,
  edited_by     TEXT,
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
  { table: 'entries', column: 'voided_at', type: 'TEXT' },
  { table: 'entries', column: 'voided_by', type: 'TEXT' },
  { table: 'entries', column: 'edited_at', type: 'TEXT' },
  { table: 'entries', column: 'edited_by', type: 'TEXT' },
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

  /** One entry by id, or null if no such entry exists in this guild. */
  entryById(guildId: string, id: number): LedgerEntry | null {
    const row = this.db
      .prepare(`SELECT ${ENTRY_COLUMNS} FROM entries WHERE guild_id = ? AND id = ?`)
      .get(guildId, id) as EntryRow | undefined;
    return row ? toLedgerEntry(row) : null;
  }

  /**
   * Undo an entry's effect on balances. Must be called inside a transaction.
   *
   * Balances are maintained rather than derived, so there is no recomputation to
   * fall back on - the effect has to be reversed by applying it backwards. This is
   * the same arithmetic that recorded it, with the sign flipped, which is what
   * keeps the two from drifting apart.
   */
  private reverseEffect(guildId: string, entry: LedgerEntry): void {
    if (entry.kind === 'payment') {
      // recordPayment applied -cents in the (to, from) direction; undo it.
      this.applyDebt(guildId, entry.toId, entry.fromId, entry.cents);
      return;
    }
    for (const { userId, shareCents } of entry.splits) {
      if (userId === entry.payerId || shareCents === 0) continue;
      this.applyDebt(guildId, entry.payerId, userId, -shareCents);
    }
  }

  /**
   * Delete an entry: reverse its effect on balances and mark the row voided.
   * Must be called inside a transaction.
   *
   * The row is kept rather than removed, so the audit log still records that the
   * entry existed and that somebody deleted it. Returns the entry as it stood, or
   * null if it does not exist or was already deleted - both of which the caller
   * has to report differently, so they are distinguished by `entryById`.
   */
  private voidOne(args: {
    guildId: string;
    id: number;
    voidedBy: string;
    voidedAt: string;
  }): LedgerEntry | null {
    const entry = this.entryById(args.guildId, args.id);
    if (!entry || entry.voidedAt !== null) return null;

    this.reverseEffect(args.guildId, entry);
    this.db
      .prepare('UPDATE entries SET voided_at = ?, voided_by = ? WHERE guild_id = ? AND id = ?')
      .run(args.voidedAt, args.voidedBy, args.guildId, args.id);
    return entry;
  }

  /**
   * Restore a deleted entry, re-applying the balances it had accounted for.
   * Must be called inside a transaction.
   *
   * The counterpart to `voidOne`, which is what makes an accidental delete
   * recoverable rather than something to be corrected with an offsetting bill.
   */
  private restoreOne(args: { guildId: string; id: number }): LedgerEntry | null {
    const entry = this.entryById(args.guildId, args.id);
    if (!entry || entry.voidedAt === null) return null;

    // Re-applying is reversing the reversal, so the same helper serves both
    // directions and cannot disagree with itself.
    this.reverseEffect(args.guildId, negated(entry));
    this.db
      .prepare(
        'UPDATE entries SET voided_at = NULL, voided_by = NULL WHERE guild_id = ? AND id = ?',
      )
      .run(args.guildId, args.id);
    return entry;
  }

  /**
   * Delete several entries, applying the single-entry delete to each in turn.
   *
   * All or nothing. One unusable id abandons the whole batch and reports which id
   * it was, rather than voiding the ids either side of it: a partly-applied delete
   * would leave the caller working out which half of what they typed took effect,
   * and the ids they would need to finish the job are the ones already gone from
   * `/history`. One transaction around the whole loop is what delivers that, and
   * it is also why the per-entry work is factored out un-transacted - SQLite has
   * no nested `BEGIN`.
   */
  voidEntries(args: {
    guildId: string;
    ids: number[];
    voidedBy: string;
    voidedAt: string;
  }): BatchResult {
    return this.transactBatch(args.ids, (id) =>
      this.voidOne({ guildId: args.guildId, id, voidedBy: args.voidedBy, voidedAt: args.voidedAt }),
    );
  }

  /** Restore several deleted entries. All or nothing, as with `voidEntries`. */
  restoreEntries(args: { guildId: string; ids: number[] }): BatchResult {
    return this.transactBatch(args.ids, (id) =>
      this.restoreOne({ guildId: args.guildId, id }),
    );
  }

  /**
   * Apply a single-entry operation to each of `ids` in one transaction, stopping
   * at the first one it refuses.
   *
   * The throw is what triggers the rollback, so the ids processed before the bad
   * one are undone by the same machinery that guards every other write, rather
   * than by a compensating pass that could itself fail partway.
   */
  private transactBatch(
    ids: number[],
    apply: (id: number) => LedgerEntry | null,
  ): BatchResult {
    try {
      return {
        ok: true,
        entries: this.transact(() =>
          ids.map((id) => {
            const entry = apply(id);
            if (!entry) throw new BatchAbort(id);
            return entry;
          }),
        ),
      };
    } catch (err) {
      if (err instanceof BatchAbort) return { ok: false, failedId: err.failedId };
      throw err;
    }
  }

  /**
   * Change a bill in place: back out the old shares, apply the new ones, and
   * stamp the row as edited.
   *
   * Everything is optional and an omitted field keeps its stored value, so a
   * caller can change only the description without restating the split. Returns
   * the bill as it stood before the edit, so the caller can show what changed.
   */
  editBill(args: {
    guildId: string;
    id: number;
    editedBy: string;
    editedAt: string;
    payerId?: string;
    totalCents?: number;
    splits?: BillSplit[];
    description?: string | null;
    occurredAt?: string | null;
  }): BillEntry | null {
    return this.transact(() => {
      const before = this.entryById(args.guildId, args.id);
      if (!before || before.kind !== 'bill' || before.voidedAt !== null) return null;

      const after: BillEntry = {
        ...before,
        payerId: args.payerId ?? before.payerId,
        totalCents: args.totalCents ?? before.totalCents,
        splits: args.splits ?? before.splits,
        description: args.description !== undefined ? args.description : before.description,
        occurredAt: args.occurredAt !== undefined ? args.occurredAt : before.occurredAt,
      };

      // Out with the old, in with the new. Done as two reversals rather than a
      // computed delta: the arithmetic is then identical to recording the bill
      // twice, and a changed payer is handled without a special case.
      this.reverseEffect(args.guildId, before);
      this.reverseEffect(args.guildId, negated(after));

      this.db
        .prepare(
          `UPDATE entries
              SET description = ?, payer_id = ?, total_cents = ?, occurred_at = ?,
                  detail_json = ?, edited_at = ?, edited_by = ?
            WHERE guild_id = ? AND id = ?`,
        )
        .run(
          after.description,
          after.payerId,
          after.totalCents,
          after.occurredAt,
          JSON.stringify(after.splits),
          args.editedAt,
          args.editedBy,
          args.guildId,
          args.id,
        );

      return before;
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
    /** Include deleted entries, which are hidden by default. */
    includeVoided?: boolean;
    /** Which kinds to list. Omitted means every kind. */
    kinds?: readonly EntryKind[];
  }): { entries: LedgerEntry[]; hasMore: boolean } {
    const offset = args.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0) {
      throw new Error(`recentEntries offset must be a non-negative integer, got ${offset}`);
    }
    // An empty list would return nothing while looking like "no filter", which is
    // the kind of silent empty page that reads as data loss. Callers resolve their
    // options to at least one kind before getting here.
    if (args.kinds?.length === 0) {
      throw new Error('recentEntries kinds must name at least one kind, or be omitted');
    }

    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS}
           FROM entries WHERE guild_id = ?
          ORDER BY COALESCE(occurred_at, created_at) DESC, id DESC`,
      )
      .all(args.guildId) as unknown as EntryRow[];

    // The user filter cannot be expressed in SQL - it depends on the parsed JSON
    // splits - so matches are skipped here rather than with SQL OFFSET.
    const parsed: LedgerEntry[] = [];
    let skipped = 0;
    for (const r of rows) {
      const entry = toLedgerEntry(r);
      // Deleted entries no longer affect any balance, so showing them by default
      // would invite reading a figure that is not in effect.
      if (entry.voidedAt !== null && args.includeVoided !== true) continue;
      if (args.kinds !== undefined && !args.kinds.includes(entry.kind)) continue;
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

  /**
   * Every live entry that moved the debt between two people, oldest first, with
   * how much each one moved it.
   *
   * `cents` is signed in the direction "`debtor` owes `creditor`", so the values
   * sum to the pair's current balance. That is the property worth having: it means
   * a listing of these lines can be checked against `/balances` by adding it up,
   * which is what makes it usable for settling an argument about a figure.
   *
   * Deleted entries are left out. They no longer contribute to the balance, so
   * including them would break that sum; `/history show_deleted:true` is where
   * they remain visible.
   */
  entriesBetween(guildId: string, creditor: string, debtor: string): PairContribution[] {
    // Reuses the ordering `recentEntries` uses, reversed: a running total reads
    // naturally oldest-first, and a backdated bill belongs where it happened.
    const rows = this.db
      .prepare(
        `SELECT ${ENTRY_COLUMNS}
           FROM entries
          WHERE guild_id = ? AND voided_at IS NULL
          ORDER BY COALESCE(occurred_at, created_at) ASC, id ASC`,
      )
      .all(guildId) as unknown as EntryRow[];

    const contributions: PairContribution[] = [];
    for (const row of rows) {
      const entry = toLedgerEntry(row);
      const cents = pairEffect(entry, creditor, debtor);
      // A bill both were in but which moved nothing between *them* - say one they
      // each owed a third person for - is not part of this balance.
      if (cents !== 0) contributions.push({ entry, cents });
    }
    return contributions;
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
