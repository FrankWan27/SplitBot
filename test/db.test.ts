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
