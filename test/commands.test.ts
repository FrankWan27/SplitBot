import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/db.js';
import { UserError } from '../src/errors.js';
import * as bill from '../src/commands/bill.js';
import * as balances from '../src/commands/balances.js';
import * as settle from '../src/commands/settle.js';
import * as history from '../src/commands/history.js';
import { buttonHandlerFor } from '../src/commands/index.js';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';

/**
 * These drive the real command handlers through a stand-in for Discord's
 * interaction object, so option parsing, participant resolution, embed building
 * and the ledger writes are all exercised the way a slash command exercises them.
 */

const GUILD = 'guild-e2e';

interface FakeUser {
  id: string;
  username: string;
  displayName: string;
  bot: boolean;
}

function user(id: string, username: string, bot = false): FakeUser {
  return { id, username, displayName: username, bot };
}

const ALICE = user('100', 'alice');
const BOB = user('200', 'bob');
const CAROL = user('300', 'carol');
const DAVE = user('400', 'dave');
const BOTUSER = user('900', 'robot', true);

const MEMBERS = [ALICE, BOB, CAROL, DAVE, BOTUSER];

interface FakeButton {
  custom_id: string;
  label?: string;
  disabled?: boolean;
}

interface Reply {
  content?: string;
  embeds?: { data: Record<string, unknown> }[];
  components?: { toJSON(): { components: FakeButton[] } }[];
  flags?: number;
}

/** Builds a minimal object shaped like the parts of an interaction we use. */
function makeInteraction(args: {
  caller: FakeUser;
  strings?: Record<string, string>;
  users?: Record<string, FakeUser>;
  booleans?: Record<string, boolean>;
  integers?: Record<string, number>;
  inGuild?: boolean;
  /** Simulates a user-installed app: a guild id present but unresolvable. */
  unresolvableGuildId?: string;
}): { interaction: ChatInputCommandInteraction; replies: Reply[] } {
  const replies: Reply[] = [];
  const strings = args.strings ?? {};
  const users = args.users ?? {};
  const booleans = args.booleans ?? {};

  const guild = {
    id: GUILD,
    members: {
      fetch: async (id: string) => {
        const found = MEMBERS.find((m) => m.id === id);
        if (!found) throw new Error('Unknown Member');
        return { displayName: found.displayName, user: { bot: found.bot } };
      },
    },
  };

  const interaction = {
    user: args.caller,
    guild: args.inGuild === false ? null : guild,
    guildId: args.inGuild === false ? (args.unresolvableGuildId ?? null) : GUILD,
    commandName: 'test',
    deferred: false,
    replied: false,
    options: {
      getString: (name: string, required?: boolean) => {
        const v = strings[name];
        if (v === undefined) {
          if (required) throw new Error(`missing required string ${name}`);
          return null;
        }
        return v;
      },
      getUser: (name: string, required?: boolean) => {
        const v = users[name];
        if (v === undefined) {
          if (required) throw new Error(`missing required user ${name}`);
          return null;
        }
        return v;
      },
      getBoolean: (name: string) => booleans[name] ?? null,
      getInteger: (name: string) => args.integers?.[name] ?? null,
    },
    reply: async (r: Reply) => {
      replies.push(r);
    },
    followUp: async (r: Reply) => {
      replies.push(r);
    },
  };

  return { interaction: interaction as unknown as ChatInputCommandInteraction, replies };
}

/**
 * Stands in for a click on one of the paging buttons. `update` is what the real
 * handler calls to edit the message in place, so the captured payload is the new
 * page exactly as Discord would render it.
 */
function makeButtonClick(customId: string): {
  interaction: ButtonInteraction;
  updates: Reply[];
} {
  const updates: Reply[] = [];
  const interaction = {
    customId,
    user: ALICE,
    guild: { id: GUILD },
    guildId: GUILD,
    deferred: false,
    replied: false,
    update: async (r: Reply) => {
      updates.push(r);
    },
  };
  return { interaction: interaction as unknown as ButtonInteraction, updates };
}

/** The buttons on a reply, as Discord would receive them. */
function buttonsOf(reply: Reply): FakeButton[] {
  return (reply.components ?? []).flatMap((row) => row.toJSON().components);
}

function buttonNamed(reply: Reply, label: string): FakeButton {
  const found = buttonsOf(reply).find((b) => b.label === label);
  assert.ok(found, `expected a "${label}" button`);
  return found;
}

/** Flattens an embed reply into searchable text. */
function replyText(reply: Reply): string {
  if (reply.content) return reply.content;
  const data = reply.embeds?.[0]?.data ?? {};
  const parts: string[] = [];
  if (typeof data['title'] === 'string') parts.push(data['title']);
  if (typeof data['description'] === 'string') parts.push(data['description']);
  for (const f of (data['fields'] as { name: string; value: string }[] | undefined) ?? []) {
    parts.push(f.name, f.value);
  }
  const footer = data['footer'] as { text?: string } | undefined;
  if (footer?.text) parts.push(footer.text);
  return parts.join('\n');
}

test('e2e: bill then balances then settle, full lifecycle', async () => {
  const store = new Store(':memory:');

  // Alice pays $30 for dinner, split with bob and carol.
  const billRun = makeInteraction({
    caller: ALICE,
    strings: { amount: '30', with: '<@200> <@300>', description: 'dinner' },
  });
  await bill.execute(billRun.interaction, store);
  const billText = replyText(billRun.replies[0]!);
  assert.match(billText, /dinner/);
  assert.match(billText, /\$30\.00/);
  assert.match(billText, /<@200> owes \$10\.00/);
  assert.match(billText, /<@300> owes \$10\.00/);

  // Balances should show both debts pointing at alice.
  const balRun = makeInteraction({ caller: BOB });
  await balances.execute(balRun.interaction, store);
  const balText = replyText(balRun.replies[0]!);
  assert.match(balText, /Outstanding balances/);
  assert.match(balText, /<@200> → <@100>/);
  assert.match(balText, /<@300> → <@100>/);
  assert.match(balText, /2 outstanding debts/);
  assert.match(balText, /\$20\.00/);

  // Bob settles in full without naming an amount.
  const settleRun = makeInteraction({ caller: BOB, users: { to: ALICE } });
  await settle.execute(settleRun.interaction, store);
  const settleText = replyText(settleRun.replies[0]!);
  assert.match(settleText, /paid <@100> \*\*\$10\.00\*\*/);
  assert.match(settleText, /Settled up/);

  // Only carol's debt remains.
  const after = store.allBalances(GUILD);
  assert.deepEqual(after, [{ creditor: '100', debtor: '300', cents: 1000 }]);
  store.close();
});

test('e2e: bill on behalf of another payer', async () => {
  const store = new Store(':memory:');
  // Carol logs a bill that BOB actually paid, split between bob and alice.
  const run = makeInteraction({
    caller: CAROL,
    strings: { amount: '15.00', with: '<@100>' },
    users: { payer: BOB },
  });
  await bill.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /paid by <@200>/);
  assert.equal(store.owedBetween(GUILD, ALICE.id, BOB.id), 750);
  assert.equal(store.owedBetween(GUILD, CAROL.id, BOB.id), 0, 'carol only logged it');
  store.close();
});

test('e2e: an uneven split loses no money and says the penny was random', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@200> <@300>' },
  });
  await bill.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /does not divide evenly/);
  assert.match(text, /at random/);

  // $10 three ways is 334/333/333 in some order. Which person carries the extra
  // cent is chance, so the assertion is on the shape, not on a name.
  const entry = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0]!;
  assert.equal(entry.kind, 'bill');
  if (entry.kind === 'bill') {
    const cents = entry.splits.map((s) => s.shareCents).sort();
    assert.deepEqual(cents, [333, 333, 334]);
    assert.equal(
      entry.splits.reduce((a, b) => a + b.shareCents, 0),
      1000,
      'no money invented or lost',
    );
  }
  store.close();
});

test('e2e: the whole total is always accounted for however the pennies fall', async () => {
  // Runs the real command repeatedly so the random draw varies, checking the
  // ledger balances every time rather than trusting one lucky run.
  const store = new Store(':memory:');
  for (let i = 0; i < 60; i++) {
    const run = makeInteraction({
      caller: ALICE,
      strings: { amount: '10.01', with: '<@200> <@300> <@400>', description: `run ${i}` },
    });
    await bill.execute(run.interaction, store);

    const entry = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0]!;
    if (entry.kind === 'bill') {
      assert.equal(
        entry.splits.reduce((a, b) => a + b.shareCents, 0),
        1001,
        'shares must sum to the total on every draw',
      );
      const cents = entry.splits.map((s) => s.shareCents);
      assert.ok(Math.max(...cents) - Math.min(...cents) <= 1, 'shares stay within a penny');
    }
  }
  store.close();
});

test('e2e: an evenly divisible bill says nothing about pennies', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '30', with: '<@200> <@300>' },
  });
  await bill.execute(run.interaction, store);
  assert.doesNotMatch(replyText(run.replies[0]!), /divide evenly|at random/);
  store.close();
});

test('e2e: the payer can be the one who draws the extra penny', async () => {
  // With the payer in the split, the odd cent can land on them, in which case no
  // debtor is charged it. Over enough runs that outcome must occur.
  const store = new Store(':memory:');
  let payerPaidExtra = 0;
  for (let i = 0; i < 120; i++) {
    const run = makeInteraction({
      caller: ALICE,
      strings: { amount: '10', with: '<@200> <@300>', description: `run ${i}` },
    });
    await bill.execute(run.interaction, store);
    const entry = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0]!;
    if (entry.kind === 'bill') {
      if (entry.splits.find((s) => s.userId === ALICE.id)?.shareCents === 334) payerPaidExtra++;
    }
  }
  assert.ok(payerPaidExtra > 0, 'the payer should sometimes draw the extra penny');
  assert.ok(payerPaidExtra < 120, 'and should not always draw it');
  store.close();
});

test('e2e: a payer taking no share is never charged a penny they did not agree to', async () => {
  // Alice fronts $10 for three others and takes no share. The spare penny has to
  // go to one of the three, since alice is not in the split at all, and she must
  // be reimbursed the full $10.
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@200> <@300> <@400>' },
    booleans: { include_payer: false },
  });
  await bill.execute(run.interaction, store);

  const total = store.allBalances(GUILD).reduce((s, b) => s + b.cents, 0);
  assert.equal(total, 1000, 'the payer recovers everything she laid out');

  const entry = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0]!;
  if (entry.kind === 'bill') {
    assert.equal(entry.splits.length, 3, 'the payer is not in the split');
    assert.ok(!entry.splits.some((s) => s.userId === ALICE.id));
    assert.deepEqual(entry.splits.map((s) => s.shareCents).sort(), [333, 333, 334]);
  }
  store.close();
});

test('e2e: excluding the payer charges the others in full', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '20', with: '<@200> <@300>' },
    booleans: { include_payer: false },
  });
  await bill.execute(run.interaction, store);
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 1000);
  assert.equal(store.owedBetween(GUILD, CAROL.id, ALICE.id), 1000);
  store.close();
});

test('e2e: bad amount is reported to the user, nothing is written', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: 'twenty bucks', with: '<@200>' },
  });
  await assert.rejects(() => bill.execute(run.interaction, store), UserError);
  assert.deepEqual(store.allBalances(GUILD), [], 'ledger must be untouched');
  store.close();
});

test('e2e: mentioning a bot is refused', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@900>' },
  });
  await assert.rejects(() => bill.execute(run.interaction, store), /Bots cannot owe/);
  assert.deepEqual(store.allBalances(GUILD), []);
  store.close();
});

test('e2e: mentioning someone outside the server is refused', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@777>' },
  });
  await assert.rejects(() => bill.execute(run.interaction, store), /not in this server/);
  store.close();
});

test('e2e: plain-text participant names are refused rather than dropped', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: 'bob and carol' },
  });
  await assert.rejects(() => bill.execute(run.interaction, store), /could not read/);
  store.close();
});

test('e2e: a bill with only the payer is refused', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@100>' },
  });
  await assert.rejects(() => bill.execute(run.interaction, store), /nothing to split/);
  store.close();
});

test('e2e: contradicting include_payer and with is refused', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@100> <@200>' },
    booleans: { include_payer: false },
  });
  await assert.rejects(() => bill.execute(run.interaction, store), /include_payer/);
  store.close();
});

test('e2e: settling with nothing owed says so and writes nothing', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({ caller: BOB, users: { to: ALICE } });
  await settle.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /does not owe/);
  assert.deepEqual(store.allBalances(GUILD), [], 'no phantom debt created');
  store.close();
});

test('e2e: settling the wrong way round suggests the correct command', async () => {
  const store = new Store(':memory:');
  // Bob owes alice; alice mistakenly runs settle to:bob.
  const billRun = makeInteraction({ caller: ALICE, strings: { amount: '20', with: '<@200>' } });
  await bill.execute(billRun.interaction, store);

  const run = makeInteraction({ caller: ALICE, users: { to: BOB } });
  await settle.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /in fact/);
  assert.match(text, /\/settle from:@bob to:@alice/);
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 1000, 'balance unchanged');
  store.close();
});

test('e2e: overpaying warns and flips the direction', async () => {
  const store = new Store(':memory:');
  const billRun = makeInteraction({ caller: ALICE, strings: { amount: '20', with: '<@200>' } });
  await bill.execute(billRun.interaction, store);

  const run = makeInteraction({ caller: BOB, users: { to: ALICE }, strings: { amount: '15' } });
  await settle.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /overpaid/);
  assert.match(text, /<@100> now owes <@200> \$5\.00/);
  store.close();
});

test('e2e: partial payment reports the remainder', async () => {
  const store = new Store(':memory:');
  const billRun = makeInteraction({ caller: ALICE, strings: { amount: '20', with: '<@200>' } });
  await bill.execute(billRun.interaction, store);

  const run = makeInteraction({ caller: BOB, users: { to: ALICE }, strings: { amount: '4' } });
  await settle.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /still owes <@100> \$6\.00/);
  store.close();
});

test('e2e: paying yourself is refused', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({ caller: ALICE, users: { to: ALICE } });
  await assert.rejects(() => settle.execute(run.interaction, store), /cannot pay themselves/);
  store.close();
});

test('e2e: balances for a specific user shows their net position', async () => {
  const store = new Store(':memory:');
  // Bob owes alice $10; carol owes bob $4. Bob is net -$6.
  const b1 = makeInteraction({ caller: ALICE, strings: { amount: '20', with: '<@200>' } });
  await bill.execute(b1.interaction, store);
  const b2 = makeInteraction({ caller: BOB, strings: { amount: '8', with: '<@300>' } });
  await bill.execute(b2.interaction, store);

  const run = makeInteraction({ caller: BOB, users: { user: BOB } });
  await balances.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Balances for bob/);
  assert.match(text, /Owes \*\*\$6\.00\*\* overall/);
  store.close();
});

test('e2e: an empty ledger reports all settled', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({ caller: ALICE });
  await balances.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /Nobody in this server owes anybody/);
  store.close();
});

test('e2e: commands used in a DM explain that a server is needed', async () => {
  const store = new Store(':memory:');
  for (const cmd of [bill, balances, settle, history]) {
    const run = makeInteraction({
      caller: ALICE,
      inGuild: false,
      strings: { amount: '10', with: '<@200>' },
      users: { to: BOB },
    });
    await assert.rejects(() => cmd.execute(run.interaction, store), /not in a DM/);
  }
  store.close();
});

test('e2e: a server the bot is not a member of gives the invite fix', async () => {
  // The app can be installed to a user account, in which case the interaction
  // carries a guild id the bot cannot resolve. That needs a different fix from a
  // DM, so it must not produce the same message.
  const store = new Store(':memory:');
  for (const cmd of [bill, balances, settle, history]) {
    const run = makeInteraction({
      caller: ALICE,
      inGuild: false,
      unresolvableGuildId: '555',
      strings: { amount: '10', with: '<@200>' },
      users: { to: BOB },
    });
    await assert.rejects(
      () => cmd.execute(run.interaction, store),
      /not a member of this server/,
    );
  }
  store.close();
});

test('e2e: history shows the description that was logged with the bill', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '42.50', with: '<@200> <@300>', description: 'dinner at Nopa' },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Recent history/);
  assert.match(text, /dinner at Nopa/);
  assert.match(text, /\$42\.50/);
  assert.match(text, /paid by <@100>/);
  store.close();
});

test('e2e: history lists newest first and includes payments', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '20', with: '<@200>', description: 'coffee' },
  });
  await bill.execute(b.interaction, store);
  const p = makeInteraction({ caller: BOB, users: { to: ALICE } });
  await settle.execute(p.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /<@200> paid <@100>/);
  // The payment is newer, so it must appear above the bill.
  assert.ok(
    text.indexOf('paid <@100>') < text.indexOf('coffee'),
    'newest entry should be listed first',
  );
  store.close();
});

test('e2e: a blank description never reaches the ledger as whitespace', async () => {
  // Discord rejects a blank value for a required option, so these do not arrive
  // in practice. Asserted anyway: a stored "   " would render as a bill with an
  // empty description line, which reads as a bug rather than as missing data.
  for (const [i, blank] of ['   ', '', '\t\n'].entries()) {
    const store = new Store(':memory:');
    const b = makeInteraction({
      caller: ALICE,
      strings: { amount: '20', with: '<@200>', description: blank },
    });
    await bill.execute(b.interaction, store);

    const entry = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0]!;
    assert.equal(
      entry.kind === 'bill' ? entry.description : 'wrong kind',
      null,
      `blank #${i} should store as null, not whitespace`,
    );
    assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 1000, 'the bill still posts');

    const run = makeInteraction({ caller: ALICE });
    await history.execute(run.interaction, store);
    assert.match(replyText(run.replies[0]!), /no description/);
    store.close();
  }
});

test('the description option is required, so Discord will not accept a blank one', () => {
  const json = bill.data.toJSON() as {
    options?: { name: string; required?: boolean }[];
  };
  const option = json.options?.find((o) => o.name === 'description');
  assert.ok(option, 'description option should exist');
  assert.equal(option.required, true);
});

test('e2e: a bill with no description is labelled rather than left blank', async () => {
  // Entries written before the option was required still have a null
  // description, and /history has to render them without a blank line.
  const store = new Store(':memory:');
  const b = makeInteraction({ caller: ALICE, strings: { amount: '20', with: '<@200>' } });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /no description/);
  store.close();
});

test('e2e: a bill renders as amount, payer with time, then who it was split with', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@200> <@300>', description: 'Trader Joes' },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);

  // Three lines: the amount and what it was for, who paid and when, then the
  // people it was split with. Per-person amounts are deliberately absent.
  assert.match(
    text,
    /\*\*\$10\.00\*\* - Trader Joes\npaid by <@100> · <t:\d+:R>\nsplit with <@200>, <@300>/,
  );
  assert.doesNotMatch(text, /\$3\.33|\$3\.34|each/, 'individual shares are not listed');
  store.close();
});

test('e2e: a bill the payer took no share of still lists who it was split with', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '20', with: '<@200> <@300>', description: 'fronted it' },
    booleans: { include_payer: false },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /paid by <@100>[^\n]*\nsplit with <@200>, <@300>/);
  store.close();
});

test('e2e: a payment renders as amount then who paid whom', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '20', with: '<@200>', description: 'coffee' },
  });
  await bill.execute(b.interaction, store);
  const p = makeInteraction({ caller: BOB, users: { to: ALICE } });
  await settle.execute(p.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /\*\*\$10\.00\*\*\n<@200> paid <@100> · <t:\d+:R>/);
  assert.doesNotMatch(text, /split with <@200> paid/, 'a payment has no split line');
  store.close();
});

test('e2e: a very large group is summarised rather than listing everyone', async () => {
  const store = new Store(':memory:');
  const ids = Array.from({ length: 12 }, (_, i) => String(1000 + i));
  store.recordBill({
    guildId: GUILD,
    payerId: ALICE.id,
    totalCents: 1200,
    splits: ids.map((userId) => ({ userId, shareCents: 100 })),
    description: 'big group',
    createdBy: ALICE.id,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /<@1000>/, 'the first names are still shown');
  assert.match(text, /<@1007>/);
  assert.doesNotMatch(text, /<@1008>/, 'the tail is summarised, not listed');
  assert.match(text, /and 4 more$/m);
  store.close();
});

test('e2e: history stays within Discord embed limits when names are long', async () => {
  const store = new Store(':memory:');
  // Twenty-five bills, each naming eight people, comfortably exceeds 4096
  // characters if nothing trims it.
  const ids = Array.from({ length: 8 }, (_, i) => String(2000 + i));
  for (let i = 0; i < 25; i++) {
    store.recordBill({
      guildId: GUILD,
      payerId: ALICE.id,
      totalCents: 800,
      splits: ids.map((userId) => ({ userId, shareCents: 100 })),
      description: `bill number ${i} with a reasonably wordy description`,
      createdBy: ALICE.id,
      createdAt: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
    });
  }

  const run = makeInteraction({ caller: ALICE, integers: { count: 25 } });
  await history.execute(run.interaction, store);
  const data = run.replies[0]!.embeds![0]!.data;
  const description = data['description'] as string;
  assert.ok(
    description.length <= 4096,
    `embed description was ${description.length} characters, over Discord's limit`,
  );
  assert.match(description, /bill number 24/, 'the newest entry is kept');
  assert.match(replyText(run.replies[0]!), /did not fit/, 'the drop is reported, not silent');

  // Whatever was trimmed for length must still be reachable, so Older starts
  // after what was actually shown rather than after what was fetched.
  const oldest = description.match(/bill number (\d+)/g)!.at(-1)!;
  const older = makeButtonClick(buttonNamed(run.replies[0]!, 'Older').custom_id);
  await history.handleButton(older.interaction, store);
  const next = replyText(older.updates[0]!);
  assert.doesNotMatch(next, new RegExp(`${oldest} `), 'the next page does not repeat an entry');
  assert.match(next, /bill number \d+/, 'and it is not blank either');
  store.close();
});

test('e2e: history notes when someone logged a bill on another persons behalf', async () => {
  const store = new Store(':memory:');
  // Carol types it, but bob paid.
  const b = makeInteraction({
    caller: CAROL,
    strings: { amount: '10', with: '<@100>', description: 'taxi' },
    users: { payer: BOB },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  // A fourth line of its own, after the split, rather than crowding the payer line.
  assert.match(
    text,
    /\*\*\$10\.00\*\* - taxi\npaid by <@200> · <t:\d+:R>\nsplit with <@100>\nlogged by <@300>/,
  );
  store.close();
});

test('e2e: history has no logged-by line when the payer logged it themselves', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@200>', description: 'taxi' },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.doesNotMatch(text, /logged by/, 'the usual case stays three lines');
  assert.match(text, /\*\*\$10\.00\*\* - taxi\npaid by <@100> · <t:\d+:R>\nsplit with <@200>$/m);
  store.close();
});

test('e2e: history filtered by user covers bills they were merely charged for', async () => {
  const store = new Store(':memory:');
  const b1 = makeInteraction({
    caller: ALICE,
    strings: { amount: '20', with: '<@200>', description: 'bob involved' },
  });
  await bill.execute(b1.interaction, store);
  const b2 = makeInteraction({
    caller: ALICE,
    strings: { amount: '20', with: '<@300>', description: 'bob absent' },
  });
  await bill.execute(b2.interaction, store);

  const run = makeInteraction({ caller: BOB, users: { user: BOB } });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /History for bob/);
  assert.match(text, /bob involved/);
  assert.doesNotMatch(text, /bob absent/);
  store.close();
});

test('e2e: count limits the listing and says older entries exist', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 4; i++) {
    const b = makeInteraction({
      caller: ALICE,
      strings: { amount: '10', with: '<@200>', description: `entry ${i}` },
    });
    await bill.execute(b.interaction, store);
  }

  const run = makeInteraction({ caller: ALICE, integers: { count: 2 } });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /entry 3/);
  assert.match(text, /entry 2/);
  assert.doesNotMatch(text, /entry 1/);
  assert.match(text, /Showing 1-2 · more older entries/);
  store.close();
});

test('e2e: history shows five entries when no count is given', async () => {
  const store = new Store(':memory:');
  await seedBills(store, 8);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Showing 1-5 · more older entries/, 'the default page is five');
  assert.match(text, /entry 3/, 'the fifth-newest is included');
  assert.doesNotMatch(text, /entry 2/, 'the sixth-newest is not');

  // The picker text has to agree with the code, or the option is misdocumented.
  const json = history.data.toJSON() as { options?: { name: string; description: string }[] };
  const count = json.options?.find((o) => o.name === 'count');
  assert.match(count!.description, /default 5/);
  store.close();
});

test('e2e: an empty history says so instead of showing a blank embed', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /No bills or payments have been logged/);

  const focused = makeInteraction({ caller: ALICE, users: { user: BOB } });
  await history.execute(focused.interaction, store);
  assert.match(replyText(focused.replies[0]!), /No bills or payments involving <@200>/);
  store.close();
});

/** Logs `count` bills, oldest first, so `entry 0` is the earliest. */
async function seedBills(store: Store, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    const b = makeInteraction({
      caller: ALICE,
      strings: { amount: '10', with: '<@200>', description: `entry ${i}` },
    });
    await bill.execute(b.interaction, store);
  }
}

test('e2e: paging older then newer walks the history and comes back', async () => {
  const store = new Store(':memory:');
  await seedBills(store, 5);

  const run = makeInteraction({ caller: ALICE, integers: { count: 2 } });
  await history.execute(run.interaction, store);
  const first = run.replies[0]!;
  assert.match(replyText(first), /entry 4/);
  assert.match(replyText(first), /entry 3/);

  // Older takes us to the next two, and Newer must land back on the same page
  // rather than somewhere adjacent to it.
  const older = makeButtonClick(buttonNamed(first, 'Older').custom_id);
  await history.handleButton(older.interaction, store);
  const second = older.updates[0]!;
  assert.match(replyText(second), /entry 2/);
  assert.match(replyText(second), /entry 1/);
  assert.doesNotMatch(replyText(second), /entry 4|entry 3/);
  assert.match(replyText(second), /Showing 3-4/);

  const newer = makeButtonClick(buttonNamed(second, 'Newer').custom_id);
  await history.handleButton(newer.interaction, store);
  assert.match(replyText(newer.updates[0]!), /entry 4/);
  assert.match(replyText(newer.updates[0]!), /Showing 1-2/);
  store.close();
});

test('e2e: paging buttons are disabled at each end rather than lying', async () => {
  const store = new Store(':memory:');
  await seedBills(store, 3);

  const run = makeInteraction({ caller: ALICE, integers: { count: 2 } });
  await history.execute(run.interaction, store);
  const first = run.replies[0]!;
  assert.equal(buttonNamed(first, 'Newer').disabled, true, 'nothing newer than page one');
  assert.equal(buttonNamed(first, 'Older').disabled, false);

  const older = makeButtonClick(buttonNamed(first, 'Older').custom_id);
  await history.handleButton(older.interaction, store);
  const last = older.updates[0]!;
  assert.equal(buttonNamed(last, 'Newer').disabled, false);
  assert.equal(buttonNamed(last, 'Older').disabled, true, 'that was the last entry');
  store.close();
});

test('e2e: no buttons appear when everything fits on one page', async () => {
  const store = new Store(':memory:');
  await seedBills(store, 2);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  assert.deepEqual(buttonsOf(run.replies[0]!), [], 'buttons that do nothing are clutter');

  const empty = new Store(':memory:');
  const emptyRun = makeInteraction({ caller: ALICE });
  await history.execute(emptyRun.interaction, empty);
  assert.deepEqual(buttonsOf(emptyRun.replies[0]!), []);
  empty.close();
  store.close();
});

test('e2e: paging keeps the user filter and the count it started with', async () => {
  const store = new Store(':memory:');
  // Two bills bob is in, two he is not, interleaved so a lost filter shows up.
  for (const [i, other] of ['200', '300', '200', '300'].entries()) {
    const b = makeInteraction({
      caller: ALICE,
      strings: { amount: '10', with: `<@${other}>`, description: `entry ${i}` },
    });
    await bill.execute(b.interaction, store);
  }

  const run = makeInteraction({ caller: ALICE, users: { user: BOB }, integers: { count: 1 } });
  await history.execute(run.interaction, store);
  const first = run.replies[0]!;
  assert.match(replyText(first), /History for bob/);
  assert.match(replyText(first), /entry 2/);

  const older = makeButtonClick(buttonNamed(first, 'Older').custom_id);
  await history.handleButton(older.interaction, store);
  const second = older.updates[0]!;
  assert.match(replyText(second), /History for bob/, 'the filter survives the click');
  assert.match(replyText(second), /entry 0/);
  assert.doesNotMatch(replyText(second), /entry 1|entry 3/);
  assert.match(replyText(second), /Showing 2-2/, 'count of 1 is still in force');
  store.close();
});

test('e2e: paging past the end says so instead of showing a blank page', async () => {
  const store = new Store(':memory:');
  await seedBills(store, 2);

  // Hand-built id: reachable in practice when entries are removed between clicks.
  const click = makeButtonClick('history:10:2:-:');
  await history.handleButton(click.interaction, store);
  const page = click.updates[0]!;
  assert.match(replyText(page), /No more entries/);
  assert.equal(buttonNamed(page, 'Newer').disabled, false, 'paging back must stay possible');
  assert.equal(buttonNamed(page, 'Older').disabled, true);
  store.close();
});

test('a malformed or foreign button id is ignored rather than crashing', async () => {
  const store = new Store(':memory:');
  for (const id of [
    'history',
    'history:x:2:-:',
    'history:-1:2:-:',
    'history:0:0:-:',
    `history:0:99:-:`,
  ]) {
    const click = makeButtonClick(id);
    await history.handleButton(click.interaction, store);
    assert.deepEqual(click.updates, [], `${id} should be ignored`);
  }
  store.close();
});

test('button routing finds the history handler and nothing else', () => {
  assert.equal(buttonHandlerFor('history:0:10:-:'), history.handleButton);
  assert.equal(buttonHandlerFor('settle:confirm'), null);
  assert.equal(buttonHandlerFor(''), null);
});

test('a button id stays inside Discord limits even with a long display name', () => {
  const longName = 'x'.repeat(200);
  // The label is truncated to fit, but the offset and limit ahead of it must
  // survive intact or paging would break for anyone with a long nickname.
  const id = history.encodePageId(
    { guildId: GUILD, focusId: BOB.id, focusLabel: longName, limit: 10, offset: 0 },
    20,
  );
  assert.ok(id.length <= 100, `custom id was ${id.length} chars`);

  const parsed = history.parsePageId(id);
  assert.equal(parsed?.offset, 20);
  assert.equal(parsed?.limit, 10);
  assert.equal(parsed?.focusId, BOB.id);
  assert.ok(parsed?.focusLabel && longName.startsWith(parsed.focusLabel));
});

test('a display name containing a colon does not corrupt the paging state', () => {
  const id = history.encodePageId(
    { guildId: GUILD, focusId: '200', focusLabel: 'bob: the third', limit: 5, offset: 15 },
    15,
  );
  const parsed = history.parsePageId(id);
  assert.equal(parsed?.focusLabel, 'bob: the third');
  assert.equal(parsed?.offset, 15);
  assert.equal(parsed?.limit, 5);
});

test('all commands are registered as guild-only, server-installed', async () => {
  // Declaring this on the command stops Discord offering it in DMs at all,
  // rather than relying on the runtime guard to catch it after the fact.
  const { InteractionContextType, ApplicationIntegrationType } = await import('discord.js');
  for (const cmd of [bill, balances, settle, history]) {
    const json = cmd.data.toJSON() as {
      name: string;
      contexts?: number[];
      integration_types?: number[];
    };
    assert.deepEqual(json.contexts, [InteractionContextType.Guild], `${json.name} contexts`);
    assert.deepEqual(json.integration_types, [ApplicationIntegrationType.GuildInstall]);
  }
});
