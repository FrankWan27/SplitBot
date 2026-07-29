import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type BillEntry, type PaymentEntry } from '../src/db.js';
import { splitEvenly } from '../src/money.js';

const G = 'guild-hist';
const alice = '100';
const bob = '200';
const carol = '300';
const dave = '400';

function bill(
  store: Store,
  payer: string,
  totalCents: number,
  participants: string[],
  description: string | null = null,
  createdBy = payer,
  createdAt = '2026-01-01T00:00:00.000Z',
): void {
  // The spare penny is pinned to the first name listed so these tests can assert
  // exact shares; /bill itself picks the recipient at random.
  const shares = splitEvenly(totalCents, participants.length, () => 0);
  store.recordBill({
    guildId: G,
    payerId: payer,
    totalCents,
    splits: participants.map((userId, i) => ({ userId, shareCents: shares[i]! })),
    description,
    createdBy,
    createdAt,
  });
}

test('history returns newest entries first', () => {
  const s = new Store(':memory:');
  bill(s, alice, 1000, [alice, bob], 'first');
  bill(s, alice, 2000, [alice, bob], 'second');
  bill(s, alice, 3000, [alice, bob], 'third');

  const { entries } = s.recentEntries({ guildId: G, limit: 10 });
  assert.deepEqual(
    entries.map((e) => (e.kind === 'bill' ? e.description : 'payment')),
    ['third', 'second', 'first'],
  );
  s.close();
});

test('history round-trips the description that /bill stored', () => {
  const s = new Store(':memory:');
  bill(s, alice, 4250, [alice, bob], 'dinner at Nopa');
  const { entries } = s.recentEntries({ guildId: G, limit: 10 });
  const entry = entries[0] as BillEntry;
  assert.equal(entry.kind, 'bill');
  assert.equal(entry.description, 'dinner at Nopa');
  assert.equal(entry.totalCents, 4250);
  assert.equal(entry.payerId, alice);
  s.close();
});

test('a bill with no description round-trips as null, not an empty string', () => {
  const s = new Store(':memory:');
  bill(s, alice, 1000, [alice, bob], null);
  const entry = s.recentEntries({ guildId: G, limit: 1 }).entries[0] as BillEntry;
  assert.equal(entry.description, null);
  s.close();
});

test('history records the splits a bill was divided into', () => {
  const s = new Store(':memory:');
  bill(s, alice, 1000, [alice, bob, carol]); // 334 / 333 / 333
  const entry = s.recentEntries({ guildId: G, limit: 1 }).entries[0] as BillEntry;
  assert.deepEqual(entry.splits, [
    { userId: alice, shareCents: 334 },
    { userId: bob, shareCents: 333 },
    { userId: carol, shareCents: 333 },
  ]);
  assert.equal(
    entry.splits.reduce((a, b) => a + b.shareCents, 0),
    1000,
  );
  s.close();
});

test('payments appear in history with both sides', () => {
  const s = new Store(':memory:');
  bill(s, alice, 2000, [alice, bob]);
  s.recordPayment({
    guildId: G,
    fromId: bob,
    toId: alice,
    cents: 1000,
    createdBy: bob,
    createdAt: '2026-01-02T00:00:00.000Z',
  });
  const { entries } = s.recentEntries({ guildId: G, limit: 10 });
  assert.equal(entries.length, 2);
  const payment = entries[0] as PaymentEntry;
  assert.equal(payment.kind, 'payment');
  assert.equal(payment.fromId, bob);
  assert.equal(payment.toId, alice);
  assert.equal(payment.cents, 1000);
  s.close();
});

test('filtering by user includes bills they were charged for, not just paid', () => {
  const s = new Store(':memory:');
  bill(s, alice, 2000, [alice, bob], 'bob was charged');
  bill(s, alice, 2000, [alice, carol], 'bob not involved');

  const { entries } = s.recentEntries({ guildId: G, userId: bob, limit: 10 });
  assert.equal(entries.length, 1, 'bob is a participant, not the payer, and must still match');
  assert.equal((entries[0] as BillEntry).description, 'bob was charged');
  s.close();
});

test('filtering by user includes bills they paid', () => {
  const s = new Store(':memory:');
  bill(s, alice, 2000, [alice, bob], 'alice paid');
  bill(s, carol, 2000, [carol, dave], 'alice absent');
  const { entries } = s.recentEntries({ guildId: G, userId: alice, limit: 10 });
  assert.equal(entries.length, 1);
  assert.equal((entries[0] as BillEntry).description, 'alice paid');
  s.close();
});

test('filtering by user includes payments on either side', () => {
  const s = new Store(':memory:');
  s.recordPayment({
    guildId: G,
    fromId: bob,
    toId: alice,
    cents: 500,
    createdBy: bob,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  assert.equal(s.recentEntries({ guildId: G, userId: bob, limit: 10 }).entries.length, 1);
  assert.equal(s.recentEntries({ guildId: G, userId: alice, limit: 10 }).entries.length, 1);
  assert.equal(s.recentEntries({ guildId: G, userId: carol, limit: 10 }).entries.length, 0);
  s.close();
});

test('a bill excluding the payer still matches the payer when filtering', () => {
  const s = new Store(':memory:');
  // Alice fronts money but takes no share; she is payer and not a participant.
  bill(s, alice, 2000, [bob, carol], 'alice fronted it');
  const { entries } = s.recentEntries({ guildId: G, userId: alice, limit: 10 });
  assert.equal(entries.length, 1);
  s.close();
});

test('someone who only logged a bill for others is not counted as involved', () => {
  const s = new Store(':memory:');
  // Dave types the command; bob paid and carol shared. Dave owes nothing.
  bill(s, bob, 1000, [bob, carol], 'logged by dave', dave);
  assert.equal(s.recentEntries({ guildId: G, userId: dave, limit: 10 }).entries.length, 0);
  assert.equal(s.recentEntries({ guildId: G, userId: bob, limit: 10 }).entries.length, 1);
  s.close();
});

test('limit caps the result and reports whether older entries exist', () => {
  const s = new Store(':memory:');
  for (let i = 0; i < 5; i++) bill(s, alice, 1000, [alice, bob], `bill ${i}`);

  const capped = s.recentEntries({ guildId: G, limit: 3 });
  assert.equal(capped.entries.length, 3);
  assert.equal(capped.hasMore, true);

  const exact = s.recentEntries({ guildId: G, limit: 5 });
  assert.equal(exact.entries.length, 5);
  assert.equal(exact.hasMore, false, 'exactly filling the limit is not "more"');

  const roomy = s.recentEntries({ guildId: G, limit: 50 });
  assert.equal(roomy.entries.length, 5);
  assert.equal(roomy.hasMore, false);
  s.close();
});

test('offset walks the whole history in pages, losing and repeating nothing', () => {
  const s = new Store(':memory:');
  for (let i = 0; i < 7; i++) bill(s, alice, 1000, [alice, bob], `bill ${i}`);

  const seen: (string | null)[] = [];
  for (let offset = 0; offset < 9; offset += 3) {
    const page = s.recentEntries({ guildId: G, limit: 3, offset });
    seen.push(...page.entries.map((e) => (e.kind === 'bill' ? e.description : null)));
    // 7 entries in pages of 3: only the third page, holding the single leftover,
    // has nothing beyond it.
    assert.equal(page.hasMore, offset < 6, `hasMore wrong at offset ${offset}`);
  }
  assert.deepEqual(seen, ['bill 6', 'bill 5', 'bill 4', 'bill 3', 'bill 2', 'bill 1', 'bill 0']);

  const past = s.recentEntries({ guildId: G, limit: 3, offset: 20 });
  assert.deepEqual(past.entries, [], 'paging past the end is empty, not an error');
  assert.equal(past.hasMore, false);
  s.close();
});

test('offset skips only entries matching the user filter', () => {
  const s = new Store(':memory:');
  // Interleaved so an offset applied before the filter would pick the wrong ones.
  bill(s, alice, 1000, [alice, carol], 'carol 0');
  bill(s, alice, 1000, [alice, bob], 'bob 0');
  bill(s, alice, 1000, [alice, carol], 'carol 1');
  bill(s, alice, 1000, [alice, bob], 'bob 1');

  const page = s.recentEntries({ guildId: G, userId: carol, limit: 1, offset: 1 });
  assert.deepEqual(
    page.entries.map((e) => (e.kind === 'bill' ? e.description : null)),
    ['carol 0'],
  );
  assert.equal(page.hasMore, false);
  s.close();
});

test('a nonsensical offset is a programming error, not a silent empty page', () => {
  const s = new Store(':memory:');
  bill(s, alice, 1000, [alice, bob]);
  for (const offset of [-1, 1.5, Number.NaN]) {
    assert.throws(() => s.recentEntries({ guildId: G, limit: 1, offset }), /non-negative integer/);
  }
  s.close();
});

test('hasMore accounts for the user filter, not just raw row count', () => {
  const s = new Store(':memory:');
  // Ten bills, only two involving carol. Asking for 2 of carol's is exact.
  for (let i = 0; i < 8; i++) bill(s, alice, 1000, [alice, bob]);
  bill(s, alice, 1000, [alice, carol]);
  bill(s, alice, 1000, [alice, carol]);

  const r = s.recentEntries({ guildId: G, userId: carol, limit: 2 });
  assert.equal(r.entries.length, 2);
  assert.equal(r.hasMore, false, 'there are no older carol entries, despite 8 other rows');
  s.close();
});

test('history is isolated per guild', () => {
  const s = new Store(':memory:');
  bill(s, alice, 1000, [alice, bob], 'in guild one');
  s.recordBill({
    guildId: 'other-guild',
    payerId: alice,
    totalCents: 1000,
    splits: [{ userId: bob, shareCents: 1000 }],
    description: 'in guild two',
    createdBy: alice,
    createdAt: '2026-01-01T00:00:00.000Z',
  });
  const one = s.recentEntries({ guildId: G, limit: 10 }).entries;
  const two = s.recentEntries({ guildId: 'other-guild', limit: 10 }).entries;
  assert.equal(one.length, 1);
  assert.equal(two.length, 1);
  assert.equal((one[0] as BillEntry).description, 'in guild one');
  assert.equal((two[0] as BillEntry).description, 'in guild two');
  s.close();
});

test('history survives a corrupt splits payload instead of failing wholesale', () => {
  const s = new Store(':memory:');
  bill(s, alice, 1000, [alice, bob], 'good entry');

  // Simulate a row damaged by an older version or manual edit. The amount and
  // payer live in real columns, so they must still be reported.
  const raw = s as unknown as { db: { prepare: (q: string) => { run: (...a: unknown[]) => void } } };
  raw.db
    .prepare(
      `INSERT INTO entries
         (guild_id, kind, description, payer_id, total_cents, created_by, created_at, detail_json)
       VALUES (?, 'bill', ?, ?, ?, ?, ?, ?)`,
    )
    .run(G, 'damaged', alice, 5000, alice, '2026-01-03T00:00:00.000Z', 'not json at all');

  const { entries } = s.recentEntries({ guildId: G, limit: 10 });
  assert.equal(entries.length, 2);
  const damaged = entries[0] as BillEntry;
  assert.equal(damaged.description, 'damaged');
  assert.equal(damaged.totalCents, 5000, 'the amount is still readable');
  assert.deepEqual(damaged.splits, [], 'unparseable splits degrade to empty');
  s.close();
});

test('history reflects entries written across a restart', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'splitbot-hist-'));
  try {
    const path = join(dir, 'splits.db');
    const first = new Store(path);
    bill(first, alice, 1000, [alice, bob], 'before restart');
    first.close();

    const second = new Store(path);
    bill(second, alice, 2000, [alice, bob], 'after restart');
    const { entries } = second.recentEntries({ guildId: G, limit: 10 });
    assert.deepEqual(
      entries.map((e) => (e.kind === 'bill' ? e.description : null)),
      ['after restart', 'before restart'],
    );
    second.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
