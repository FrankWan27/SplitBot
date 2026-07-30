import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { splitEvenly } from '../src/money.js';

const G = 'guild-1';
const AT = '2026-01-01T00:00:00.000Z';

/** Ids chosen so that alice < bob < carol lexicographically, plus one that does not. */
const alice = '100';
const bob = '200';
const carol = '300';
const zed = '099'; // sorts before alice, to exercise the pair-ordering flip

function fresh(): Store {
  return new Store(':memory:');
}

function bill(
  store: Store,
  payer: string,
  totalCents: number,
  participants: string[],
  description: string | null = null,
): void {
  // /bill hands leftover pennies to a random participant. These tests assert
  // exact balances, so the draw is pinned: returning 0 always sends the spare
  // penny to the first name listed, which is how the callers below expect it.
  const shares = splitEvenly(totalCents, participants.length, () => 0);
  store.recordBill({
    guildId: G,
    payerId: payer,
    totalCents,
    splits: participants.map((userId, i) => ({ userId, shareCents: shares[i]! })),
    description,
    createdBy: payer,
    createdAt: AT,
  });
}

test('a simple two-way bill creates one debt', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob]); // alice paid $20, both share
  assert.equal(s.owedBetween(G, bob, alice), 1000);
  assert.equal(s.owedBetween(G, alice, bob), -1000);
  assert.deepEqual(s.allBalances(G), [{ creditor: alice, debtor: bob, cents: 1000 }]);
  s.close();
});

test('the payer never owes themselves', () => {
  const s = fresh();
  bill(s, alice, 3000, [alice, bob, carol]);
  const balances = s.allBalances(G);
  assert.equal(balances.length, 2);
  assert.ok(balances.every((b) => b.creditor === alice));
  assert.equal(s.owedBetween(G, alice, alice), 0);
  s.close();
});

test('pair ordering is canonical regardless of who pays first', () => {
  const s = fresh();
  // zed sorts before alice, so this exercises the sign-flip path in applyDebt.
  bill(s, zed, 1000, [zed, alice]); // alice owes zed 500
  assert.equal(s.owedBetween(G, alice, zed), 500);
  bill(s, alice, 1000, [zed, alice]); // zed owes alice 500, netting to zero
  assert.equal(s.owedBetween(G, alice, zed), 0);
  assert.deepEqual(s.allBalances(G), []);
  s.close();
});

test('debts between the same pair accumulate rather than duplicating rows', () => {
  const s = fresh();
  bill(s, alice, 1000, [alice, bob]);
  bill(s, alice, 500, [alice, bob]);
  // A 1-cent bill split two ways gives [1, 0]: the payer is listed first and
  // absorbs the odd penny, so bob's share is 0 and the debt does not move.
  bill(s, alice, 1, [alice, bob]);
  const balances = s.allBalances(G);
  assert.equal(balances.length, 1, 'should still be a single pair row');
  assert.equal(balances[0]!.cents, 500 + 250);
  s.close();
});

test('a reverse bill nets against an existing debt', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob]); // bob owes alice 1000
  bill(s, bob, 600, [alice, bob]); // alice owes bob 300
  assert.equal(s.owedBetween(G, bob, alice), 700);
  s.close();
});

test('settled pairs disappear from the ledger', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob]);
  const { beforeCents, afterCents } = s.recordPayment({
    guildId: G,
    fromId: bob,
    toId: alice,
    cents: 1000,
    createdBy: bob,
    createdAt: AT,
  });
  assert.equal(beforeCents, 1000);
  assert.equal(afterCents, 0);
  assert.deepEqual(s.allBalances(G), []);
  s.close();
});

test('a partial payment leaves the remainder outstanding', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob]); // bob owes 1000
  const { afterCents } = s.recordPayment({
    guildId: G,
    fromId: bob,
    toId: alice,
    cents: 400,
    createdBy: bob,
    createdAt: AT,
  });
  assert.equal(afterCents, 600);
  assert.equal(s.owedBetween(G, bob, alice), 600);
  s.close();
});

test('overpaying flips the debt direction and reports it', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob]); // bob owes 1000
  const { beforeCents, afterCents } = s.recordPayment({
    guildId: G,
    fromId: bob,
    toId: alice,
    cents: 1500,
    createdBy: bob,
    createdAt: AT,
  });
  assert.equal(beforeCents, 1000);
  assert.equal(afterCents, -500, 'alice should now owe bob 500');
  assert.equal(s.owedBetween(G, alice, bob), 500);
  s.close();
});

test('paying someone you owe nothing creates a debt in the other direction', () => {
  const s = fresh();
  s.recordPayment({
    guildId: G,
    fromId: bob,
    toId: alice,
    cents: 700,
    createdBy: bob,
    createdAt: AT,
  });
  assert.equal(s.owedBetween(G, alice, bob), 700);
  s.close();
});

test('guilds are fully isolated from each other', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob]);
  s.recordBill({
    guildId: 'guild-2',
    payerId: bob,
    totalCents: 800,
    splits: [
      { userId: alice, shareCents: 400 },
      { userId: bob, shareCents: 400 },
    ],
    description: null,
    createdBy: bob,
    createdAt: AT,
  });
  assert.equal(s.owedBetween(G, bob, alice), 1000);
  assert.equal(s.owedBetween('guild-2', alice, bob), 400);
  assert.equal(s.allBalances(G).length, 1);
  assert.equal(s.allBalances('guild-2').length, 1);
  s.close();
});

test('balancesFor returns only debts touching that user', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob]); // bob -> alice
  bill(s, carol, 1000, [carol, zed]); // zed -> carol
  const forBob = s.balancesFor(G, bob);
  assert.equal(forBob.length, 1);
  assert.equal(forBob[0]!.creditor, alice);
  assert.equal(s.balancesFor(G, bob).length, 1);
  assert.equal(s.balancesFor(G, carol).length, 1);
  assert.equal(s.balancesFor(G, '999').length, 0);
  s.close();
});

test('the whole ledger always nets to zero', () => {
  const s = fresh();
  bill(s, alice, 1000, [alice, bob, carol]); // odd pennies involved
  bill(s, bob, 777, [alice, bob, carol, zed]);
  bill(s, carol, 1, [carol, zed]);
  s.recordPayment({ guildId: G, fromId: bob, toId: alice, cents: 100, createdBy: bob, createdAt: AT });
  s.recordPayment({ guildId: G, fromId: zed, toId: bob, cents: 5000, createdBy: zed, createdAt: AT });

  const net = new Map<string, number>();
  for (const b of s.allBalances(G)) {
    net.set(b.creditor, (net.get(b.creditor) ?? 0) + b.cents);
    net.set(b.debtor, (net.get(b.debtor) ?? 0) - b.cents);
  }
  const sum = [...net.values()].reduce((a, b) => a + b, 0);
  assert.equal(sum, 0, 'credits and debits must cancel exactly');
  s.close();
});

test('balances are returned largest first', () => {
  const s = fresh();
  bill(s, alice, 200, [alice, bob]); // 100
  bill(s, alice, 2000, [alice, carol]); // 1000
  bill(s, alice, 600, [alice, zed]); // 300
  const cents = s.allBalances(G).map((b) => b.cents);
  assert.deepEqual(cents, [1000, 300, 100]);
  s.close();
});

test('a bill excluding the payer charges participants their full share', () => {
  const s = fresh();
  // Alice fronts $30 for bob and carol only; she is not splitting it.
  bill(s, alice, 3000, [bob, carol]);
  assert.equal(s.owedBetween(G, bob, alice), 1500);
  assert.equal(s.owedBetween(G, carol, alice), 1500);
  s.close();
});

/** Every id currently in the ledger, oldest first. */
function ids(s: Store): number[] {
  return s
    .recentEntries({ guildId: G, limit: 100, includeVoided: true })
    .entries.map((e) => e.id)
    .reverse();
}

test('voidEntries reverses every named entry and leaves the rest alone', () => {
  const s = fresh();
  bill(s, alice, 3000, [alice, bob]);
  bill(s, alice, 1000, [alice, bob]);
  bill(s, alice, 500, [alice, bob]);
  const [first, second, third] = ids(s) as [number, number, number];
  assert.equal(s.owedBetween(G, bob, alice), 1500 + 500 + 250);

  const result = s.voidEntries({ guildId: G, ids: [first, second], voidedBy: bob, voidedAt: AT });
  assert.ok(result.ok);
  assert.deepEqual(result.entries.map((e) => e.id), [first, second]);
  assert.equal(s.owedBetween(G, bob, alice), 250, 'only the third bill still counts');
  assert.equal(s.entryById(G, third)?.voidedAt, null);
  // Who deleted it is recorded on every row in the batch, not just the first.
  assert.equal(s.entryById(G, second)?.voidedBy, bob);
  s.close();
});

test('voidEntries is all or nothing when one id is unusable', () => {
  const s = fresh();
  bill(s, alice, 3000, [alice, bob]);
  bill(s, alice, 1000, [alice, bob]);
  const [first, second] = ids(s) as [number, number];
  const before = s.allBalances(G);

  // The bad id is last, so the two ahead of it are already voided inside the
  // transaction when it fails. The rollback is what has to undo them.
  const result = s.voidEntries({
    guildId: G,
    ids: [first, second, 9999],
    voidedBy: bob,
    voidedAt: AT,
  });
  assert.equal(result.ok, false);
  assert.ok(!result.ok && result.failedId === 9999, 'names the id that stopped it');
  assert.deepEqual(s.allBalances(G), before);
  assert.equal(s.entryById(G, first)?.voidedAt, null);
  assert.equal(s.entryById(G, second)?.voidedAt, null);
  s.close();
});

test('voidEntries refuses a batch containing an already-voided entry', () => {
  const s = fresh();
  bill(s, alice, 3000, [alice, bob]);
  bill(s, alice, 1000, [alice, bob]);
  const [first, second] = ids(s) as [number, number];
  s.voidEntries({ guildId: G, ids: [first], voidedBy: bob, voidedAt: AT });
  const before = s.allBalances(G);

  const result = s.voidEntries({
    guildId: G,
    ids: [second, first],
    voidedBy: bob,
    voidedAt: AT,
  });
  assert.ok(!result.ok && result.failedId === first);
  assert.deepEqual(s.allBalances(G), before, 'the live entry was not voided either');
  assert.equal(s.entryById(G, second)?.voidedAt, null);
  s.close();
});

test('restoreEntries puts back exactly what voidEntries removed', () => {
  const s = fresh();
  // An uneven total, so restoring the stored shares rather than re-splitting is
  // what makes the balances come back identical.
  bill(s, alice, 1000, [alice, bob, carol]);
  bill(s, alice, 2000, [alice, bob, carol]);
  const [first, second] = ids(s) as [number, number];
  const before = s.allBalances(G);

  s.voidEntries({ guildId: G, ids: [first, second], voidedBy: bob, voidedAt: AT });
  assert.deepEqual(s.allBalances(G), []);

  const result = s.restoreEntries({ guildId: G, ids: [first, second] });
  assert.ok(result.ok);
  assert.deepEqual(s.allBalances(G), before, 'restored penny for penny');
  assert.equal(s.entryById(G, first)?.voidedAt, null);
  assert.equal(s.entryById(G, first)?.voidedBy, null, 'the deleter is cleared too');
  s.close();
});

test('restoreEntries rolls back entirely when one id is not deleted', () => {
  const s = fresh();
  bill(s, alice, 3000, [alice, bob]);
  bill(s, alice, 1000, [alice, bob]);
  const [first, second] = ids(s) as [number, number];
  s.voidEntries({ guildId: G, ids: [first], voidedBy: bob, voidedAt: AT });
  const before = s.allBalances(G);

  // `second` is live, so restoring it is meaningless and must abandon the batch
  // rather than double-apply the balances of `first`.
  const result = s.restoreEntries({ guildId: G, ids: [first, second] });
  assert.ok(!result.ok && result.failedId === second);
  assert.deepEqual(s.allBalances(G), before, 'balances must not double up');
  assert.ok(s.entryById(G, first)?.voidedAt, 'the deleted entry is still deleted');
  s.close();
});

test('an empty batch is a no-op rather than an error', () => {
  const s = fresh();
  bill(s, alice, 3000, [alice, bob]);
  const before = s.allBalances(G);

  const result = s.voidEntries({ guildId: G, ids: [], voidedBy: bob, voidedAt: AT });
  assert.ok(result.ok);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(s.allBalances(G), before);
  s.close();
});

test('a batch cannot reach into another guild', () => {
  const s = fresh();
  bill(s, alice, 3000, [alice, bob]);
  const [mine] = ids(s) as [number];
  s.recordBill({
    guildId: 'guild-2',
    payerId: alice,
    totalCents: 1000,
    splits: [{ userId: bob, shareCents: 1000 }],
    description: 'theirs',
    createdBy: alice,
    createdAt: AT,
  });
  const theirs = s.recentEntries({ guildId: 'guild-2', limit: 1 }).entries[0]!.id;

  const result = s.voidEntries({ guildId: G, ids: [mine, theirs], voidedBy: bob, voidedAt: AT });
  assert.ok(!result.ok && result.failedId === theirs, 'the other guild\'s id does not exist here');
  assert.equal(s.entryById(G, mine)?.voidedAt, null);
  assert.equal(s.entryById('guild-2', theirs)?.voidedAt, null);
  s.close();
});

/**
 * `entriesBetween` reconstructs a pair's balance from the append-only log, while
 * the balance itself is maintained separately. The two agreeing is the whole
 * contract: a breakdown that did not sum to the figure `/balances` prints would be
 * worse than no breakdown at all. So every test here checks the sum, not just the
 * rows returned.
 */

/** What each contribution was for, in order. Payments have no description. */
function labels(s: Store, creditor: string, debtor: string): (string | null)[] {
  return s
    .entriesBetween(G, creditor, debtor)
    .map(({ entry }) => (entry.kind === 'payment' ? 'payment' : entry.description));
}

/** The reconstructed balance for a pair, as the breakdown's running total ends. */
function reconstructed(s: Store, creditor: string, debtor: string): number {
  return s
    .entriesBetween(G, creditor, debtor)
    .reduce((sum, c) => sum + c.cents, 0);
}

/** Asserts every live pair's reconstruction equals its stored balance. */
function assertReconstructsAll(s: Store): void {
  const balances = s.allBalances(G);
  assert.ok(balances.length > 0, 'nothing to check');
  for (const b of balances) {
    assert.equal(
      reconstructed(s, b.creditor, b.debtor),
      b.cents,
      `${b.debtor} → ${b.creditor} must reconstruct to its stored balance`,
    );
  }
}

test('entriesBetween sums to the stored balance for a simple debt', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'dinner');
  const contributions = s.entriesBetween(G, alice, bob);
  assert.equal(contributions.length, 1);
  assert.equal(contributions[0]!.cents, 1000, 'signed as what bob owes alice');
  assertReconstructsAll(s);
  s.close();
});

test('a payment contributes negatively, so the breakdown pays the debt down', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'dinner');
  s.recordPayment({ guildId: G, fromId: bob, toId: alice, cents: 400, createdBy: bob, createdAt: AT });

  const contributions = s.entriesBetween(G, alice, bob);
  assert.deepEqual(contributions.map((c) => c.cents), [1000, -400]);
  assertReconstructsAll(s);
  s.close();
});

test('bills running both ways net out to the stored figure', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'alice paid');
  bill(s, bob, 800, [alice, bob], 'bob paid');
  // A pair with debt in both directions is where a sign error hides: each figure
  // is plausible alone and only the total gives it away.
  assert.equal(reconstructed(s, alice, bob), 600);
  assertReconstructsAll(s);
  s.close();
});

test('the sign flips with the argument order, since either person can be the debtor', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'dinner');
  assert.equal(reconstructed(s, alice, bob), 1000);
  assert.equal(reconstructed(s, bob, alice), -1000, 'the same debt seen from the other side');
  s.close();
});

test('a bill two people merely shared is not part of their own balance', () => {
  const s = fresh();
  // Both owe carol; neither owes the other because of it.
  bill(s, carol, 3000, [alice, bob, carol], 'carol paid');
  assert.deepEqual(s.entriesBetween(G, alice, bob), []);
  assert.deepEqual(s.entriesBetween(G, bob, alice), []);
  assertReconstructsAll(s);
  s.close();
});

test('a voided entry drops out of the breakdown as it drops out of the balance', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'keep');
  bill(s, alice, 800, [alice, bob], 'drop');
  const [, second] = ids(s) as [number, number];
  s.voidEntries({ guildId: G, ids: [second], voidedBy: bob, voidedAt: AT });

  assert.deepEqual(labels(s, alice, bob), ['keep']);
  assertReconstructsAll(s);
  s.close();
});

test('a restored entry comes back into the breakdown', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'dinner');
  const [first] = ids(s) as [number];
  s.voidEntries({ guildId: G, ids: [first], voidedBy: bob, voidedAt: AT });
  assert.deepEqual(s.entriesBetween(G, alice, bob), []);

  s.restoreEntries({ guildId: G, ids: [first] });
  assert.equal(reconstructed(s, alice, bob), 1000);
  assertReconstructsAll(s);
  s.close();
});

test('an edited bill reconstructs to its edited amount, not its original', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'dinner');
  const [first] = ids(s) as [number];
  s.editBill({
    guildId: G,
    id: first,
    totalCents: 3000,
    splits: [
      { userId: alice, shareCents: 1500 },
      { userId: bob, shareCents: 1500 },
    ],
    editedBy: bob,
    editedAt: AT,
  });
  assert.equal(reconstructed(s, alice, bob), 1500);
  assertReconstructsAll(s);
  s.close();
});

test('an uneven split reconstructs at the stored shares, penny included', () => {
  const s = fresh();
  // $10 three ways: the pinned draw gives alice the spare penny, so bob and carol
  // owe $3.33 each. Reconstructing by dividing the total would give them $3.34.
  bill(s, alice, 1000, [alice, bob, carol], 'coffee');
  assert.equal(reconstructed(s, alice, bob), 333);
  assert.equal(reconstructed(s, alice, carol), 333);
  assertReconstructsAll(s);
  s.close();
});

test('the breakdown is ordered oldest first, so a running total reads forwards', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'first');
  bill(s, alice, 1000, [alice, bob], 'second');
  bill(s, alice, 600, [alice, bob], 'third');
  assert.deepEqual(labels(s, alice, bob), ['first', 'second', 'third']);
  s.close();
});

test('a backdated bill sits where it happened, not where it was typed', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'typed first');
  s.recordBill({
    guildId: G,
    payerId: alice,
    totalCents: 1000,
    splits: [
      { userId: alice, shareCents: 500 },
      { userId: bob, shareCents: 500 },
    ],
    description: 'happened earlier',
    createdBy: alice,
    createdAt: AT,
    occurredAt: '2025-12-01T00:00:00.000Z',
  });
  assert.deepEqual(labels(s, alice, bob), ['happened earlier', 'typed first']);
  assertReconstructsAll(s);
  s.close();
});

test('a settled pair reconstructs to zero rather than to its last bill', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'dinner');
  s.recordPayment({ guildId: G, fromId: bob, toId: alice, cents: 1000, createdBy: bob, createdAt: AT });
  // The pair is gone from allBalances, so assertReconstructsAll would not see it.
  assert.equal(s.owedBetween(G, bob, alice), 0);
  assert.equal(reconstructed(s, alice, bob), 0);
  assert.equal(s.entriesBetween(G, alice, bob).length, 2, 'both entries are still listed');
  s.close();
});

test('a breakdown does not reach into another guild', () => {
  const s = fresh();
  bill(s, alice, 2000, [alice, bob], 'mine');
  s.recordBill({
    guildId: 'guild-2',
    payerId: alice,
    totalCents: 5000,
    splits: [{ userId: bob, shareCents: 5000 }],
    description: 'theirs',
    createdBy: alice,
    createdAt: AT,
  });
  assert.deepEqual(labels(s, alice, bob), ['mine']);
  s.close();
});

test('the pair-ordering flip does not affect the reconstruction', () => {
  const s = fresh();
  // zed sorts before alice, so this pair is stored with the ids the other way
  // round from how they are asked for here.
  bill(s, zed, 2000, [zed, alice], 'dinner');
  assert.equal(reconstructed(s, zed, alice), 1000);
  assertReconstructsAll(s);
  s.close();
});

test('a many-entry ledger reconstructs every pair exactly', () => {
  const s = fresh();
  // Mixed shapes, both directions, an uneven total, a payment, a delete and an
  // edit: the sum has to survive all of them together, not one at a time.
  bill(s, alice, 3000, [alice, bob, carol], 'group dinner');
  bill(s, bob, 1000, [alice, bob], 'bob paid');
  bill(s, carol, 700, [alice, bob, carol], 'coffee');
  s.recordPayment({ guildId: G, fromId: bob, toId: alice, cents: 250, createdBy: bob, createdAt: AT });
  bill(s, alice, 1600, [alice, carol], 'taxi');
  const all = ids(s);
  s.voidEntries({ guildId: G, ids: [all[2]!], voidedBy: bob, voidedAt: AT });
  s.editBill({
    guildId: G,
    id: all[4]!,
    totalCents: 2000,
    splits: [
      { userId: alice, shareCents: 1000 },
      { userId: carol, shareCents: 1000 },
    ],
    editedBy: bob,
    editedAt: AT,
  });
  assertReconstructsAll(s);
  s.close();
});

test('data survives reopening the same database file', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'splitbot-test-'));
  const path = join(dir, 'nested', 'splits.db');
  try {
    const first = new Store(path);
    bill(first, alice, 2000, [alice, bob]);
    first.close();

    const second = new Store(path);
    assert.equal(second.owedBetween(G, bob, alice), 1000);
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a database written before occurred_at existed gains the column and still reads', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = await mkdtemp(join(tmpdir(), 'splitbot-migrate-'));
  const path = join(dir, 'splits.db');

  try {
    // The original schema, byte for byte, including the row shape it wrote.
    // `CREATE TABLE IF NOT EXISTS` will leave this table alone, so only the
    // explicit migration can bring it up to date.
    const old = new DatabaseSync(path);
    old.exec(`
      CREATE TABLE entries (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id      TEXT    NOT NULL,
        kind          TEXT    NOT NULL CHECK (kind IN ('bill', 'payment')),
        description   TEXT,
        payer_id      TEXT    NOT NULL,
        total_cents   INTEGER NOT NULL,
        created_by    TEXT    NOT NULL,
        created_at    TEXT    NOT NULL,
        detail_json   TEXT    NOT NULL
      ) STRICT;
    `);
    old
      .prepare(
        `INSERT INTO entries
           (guild_id, kind, description, payer_id, total_cents, created_by, created_at, detail_json)
         VALUES (?, 'bill', 'old dinner', ?, 2000, ?, ?, ?)`,
      )
      .run(G, alice, alice, AT, JSON.stringify([{ userId: bob, shareCents: 1000 }]));
    old.close();

    const store = new Store(path);
    const entries = store.recentEntries({ guildId: G, limit: 10 }).entries;
    assert.equal(entries.length, 1, 'the pre-existing row is still readable');
    const entry = entries[0]!;
    assert.equal(entry.kind, 'bill');
    assert.equal(entry.description, 'old dinner');
    assert.equal(entry.totalCents, 2000);
    // Missing rather than null in the raw row, which would leak as `undefined`
    // and render as "undefined" in the history listing.
    assert.equal(entry.occurredAt, null, 'a row written before the column reads as null');

    // The added column has to be writable too, not merely present.
    store.recordBill({
      guildId: G,
      payerId: alice,
      totalCents: 1000,
      splits: [{ userId: bob, shareCents: 1000 }],
      description: 'backdated after migrating',
      createdBy: alice,
      createdAt: '2026-07-28T10:00:00.000Z',
      occurredAt: '2025-12-25T12:00:00.000Z',
    });

    // Dated before the old row, so it must sort below it.
    assert.deepEqual(
      store.recentEntries({ guildId: G, limit: 10 }).entries.map((e) =>
        e.kind === 'bill' ? e.description : 'payment',
      ),
      ['old dinner', 'backdated after migrating'],
    );
    store.close();

    // Opening again must be a no-op rather than a duplicate-column error.
    const reopened = new Store(path);
    assert.equal(reopened.recentEntries({ guildId: G, limit: 10 }).entries.length, 2);
    reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
