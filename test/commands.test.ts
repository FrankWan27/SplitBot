import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store, type BillEntry } from '../src/db.js';
import { UserError } from '../src/errors.js';
import * as bill from '../src/commands/bill.js';
import * as balances from '../src/commands/balances.js';
import * as settle from '../src/commands/settle.js';
import * as history from '../src/commands/history.js';
import * as edit from '../src/commands/edit.js';
import * as del from '../src/commands/delete.js';
import * as restore from '../src/commands/restore.js';
import { buttonHandlerFor } from '../src/commands/index.js';
import { MAX_ENTRY_IDS } from '../src/entryIds.js';
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

test('e2e: a bill with no date happened when it was logged', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@200>', description: 'lunch' },
  });
  await bill.execute(run.interaction, store);

  const entry = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0] as BillEntry;
  assert.equal(entry.occurredAt, null);
  assert.doesNotMatch(replyText(run.replies[0]!), /Dated/, 'nothing to echo back');
  store.close();
});

test('e2e: a dated bill stores the date and echoes back the day it read', async () => {
  const store = new Store(':memory:');
  const run = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@200>', description: 'taxi', date: 'yesterday' },
  });
  await bill.execute(run.interaction, store);

  // Derived from the clock rather than hardcoded, since /bill uses the real one.
  const now = new Date();
  const expected = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 12),
  ).toISOString();

  const entry = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0] as BillEntry;
  assert.equal(entry.occurredAt, expected, 'stored as noon UTC on yesterday');
  assert.notEqual(entry.createdAt, entry.occurredAt, 'logged now, happened yesterday');

  // The echoed timestamp must be the date that was stored, or the confirmation
  // would tell the user something different from what the ledger holds.
  const echoed = replyText(run.replies[0]!).match(/Dated <t:(\d+):D>/);
  assert.ok(echoed, 'the reply confirms the date it parsed');
  assert.equal(Number(echoed[1]) * 1000, Date.parse(expected));
  store.close();
});

test('e2e: a date the parser cannot read is refused and nothing is written', async () => {
  const store = new Store(':memory:');
  for (const date of ['last tuesday', '2026-13-01', '2026-02-30', '7/20/26', 'soon']) {
    const run = makeInteraction({
      caller: ALICE,
      strings: { amount: '10', with: '<@200>', description: 'x', date },
    });
    await assert.rejects(() => bill.execute(run.interaction, store), UserError, date);
  }
  assert.deepEqual(store.allBalances(GUILD), [], 'a rejected date leaves no debt behind');
  assert.equal(store.recentEntries({ guildId: GUILD, limit: 10 }).entries.length, 0);
  store.close();
});

test('e2e: a backdated bill lands in its chronological place in history', async () => {
  const store = new Store(':memory:');
  // Logged in this order, so insertion order alone would list them reversed.
  for (const [description, date] of [
    ['three days ago', '3'],
    ['today', 'today'],
    ['yesterday', 'yesterday'],
  ] as const) {
    const now = new Date();
    const iso =
      date === 'today' || date === 'yesterday'
        ? date
        : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 3, 12))
            .toISOString()
            .slice(0, 10);
    const run = makeInteraction({
      caller: ALICE,
      strings: { amount: '10', with: '<@200>', description, date: iso },
    });
    await bill.execute(run.interaction, store);
  }

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  const order = ['today', 'yesterday', 'three days ago'].map((d) => text.indexOf(d));
  assert.ok(order.every((i) => i >= 0), 'all three bills are listed');
  assert.deepEqual(
    [...order].sort((a, b) => a - b),
    order,
    `newest first, got:\n${text}`,
  );
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
  for (const cmd of [bill, balances, settle, history, edit, del, restore]) {
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
  for (const cmd of [bill, balances, settle, history, edit, del, restore]) {
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
  assert.match(text, /Paid by <@100>/);
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

test('e2e: a bill renders as amount, payer with headcount, borrowers, then provenance', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '9', with: '<@200> <@300>', description: 'Trader Joes' },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);

  // The whole entry, anchored, so a line landing in the wrong order fails: a
  // date heading, the amount, who paid and for how many, who borrowed what, and
  // the time in italics. Alice both paid and logged it, so no "Logged by".
  assert.match(
    text,
    /^## __\d\d\/\d\d__\n `#1` \*\*\$9\.00 - Trader Joes\*\*\nPaid by <@100> for 3 people\.\n<@200> <@300> borrowed \$3\.00\.\n_<t:\d+:R>_$/m,
  );
  store.close();
});

test('e2e: an uneven split states each distinct share rather than one wrong figure', async () => {
  const store = new Store(':memory:');
  // $10 across three is 3.34 / 3.33 / 3.33. Written directly rather than through
  // /bill, because /bill hands the spare penny to a random participant: when the
  // payer draws it the two borrowers owe the same and there is nothing uneven
  // left to assert, which made this test fail about one run in three.
  store.recordBill({
    guildId: GUILD,
    payerId: ALICE.id,
    totalCents: 1000,
    splits: [
      { userId: ALICE.id, shareCents: 333 },
      { userId: BOB.id, shareCents: 334 },
      { userId: CAROL.id, shareCents: 333 },
    ],
    description: 'Trader Joes',
    createdBy: ALICE.id,
    createdAt: '2026-07-27T12:00:00.000Z',
  });

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);

  // Reconstruct who-owes-what from the rendered lines and require it to match the
  // ledger exactly. Anything looser passes when the two shares are collapsed onto
  // a single line, which would print an amount one of them does not owe.
  const rendered = new Map<string, number>();
  for (const line of text.split('\n')) {
    const m = line.match(/^(.+) borrowed \$(\d+\.\d\d)\.$/);
    if (!m) continue;
    const cents = Math.round(Number(m[2]) * 100);
    for (const id of m[1]!.match(/<@(\d+)>/g) ?? []) {
      rendered.set(id.slice(2, -1), cents);
    }
  }

  const entry = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0] as BillEntry;
  const expected = new Map(
    entry.splits.filter((s) => s.userId !== entry.payerId).map((s) => [s.userId, s.shareCents]),
  );
  assert.deepEqual(
    [...rendered].sort(),
    [...expected].sort(),
    `the listing must state each borrower's real share:\n${text}`,
  );
  // Whoever drew the spare penny owes a cent more, so the two lines differ.
  assert.equal(new Set(expected.values()).size, 2, 'this split is genuinely uneven');
  assert.equal((text.match(/borrowed/g) ?? []).length, 2, 'one line per distinct share');
  store.close();
});

test('e2e: a bill the payer took no share of counts only the borrowers', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '20', with: '<@200> <@300>', description: 'fronted it' },
    booleans: { include_payer: false },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  // Two people, not three: the payer took no share, so counting them would make
  // the per-person figure fail to divide the total.
  assert.match(
    replyText(run.replies[0]!),
    /Paid by <@100> for 2 people\.\n<@200> <@300> borrowed \$10\.00\./,
  );
  store.close();
});

test('e2e: a bill split with one other person reads "person", not "people"', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '20', with: '<@200>', description: 'fronted it' },
    booleans: { include_payer: false },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /for 1 person\./);
  store.close();
});

test('e2e: a payment renders as amount, who paid whom, then provenance', async () => {
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

  // Scoped to the payment's own block: the bill below it legitimately has a
  // borrowed line, so asserting over the whole listing would prove nothing.
  const block = text.split('\n\n').find((b) => b.includes('paid <@100>'));
  assert.ok(block, `expected a payment block in:\n${text}`);
  assert.match(block, / \*\*\$10\.00\*\*\n<@200> paid <@100>\.\n_<t:\d+:R>_$/);
  assert.doesNotMatch(block, /Paid by .* for/, 'a payment has no headcount line');
  assert.doesNotMatch(block, /borrowed/, 'a payment has no borrowed line');
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
  assert.match(text, /and 4 more borrowed \$1\.00\./);
  // The headcount reports everyone, even those the line does not name, or the
  // per-person figure would look like it did not divide the total.
  assert.match(text, /for 12 people\./);
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

test('e2e: history names who logged a bill on another persons behalf', async () => {
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
  // The payer and the person who logged it are different, and the italic line is
  // where that distinction has to be visible.
  assert.match(text, /Paid by <@200> for 2 people\./);
  assert.match(text, /_<t:\d+:R> - Logged by <@300>_$/m);
  store.close();
});

test('e2e: the logger is not named when they are the payer', async () => {
  const store = new Store(':memory:');
  const b = makeInteraction({
    caller: ALICE,
    strings: { amount: '10', with: '<@200>', description: 'taxi' },
  });
  await bill.execute(b.interaction, store);

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  // The common case: "Logged by @alice" under "Paid by @alice" only restates the
  // line above, and naming the logger unconditionally makes the one case that
  // matters - somebody logging on another person's behalf - impossible to spot.
  assert.match(text, /_<t:\d+:R>_$/m);
  assert.doesNotMatch(text, /Logged by/);
  store.close();
});

test('e2e: entries on the same day share one heading', async () => {
  const store = new Store(':memory:');
  // Three bills, same calendar day, logged minutes apart.
  for (const [i, description] of ['first', 'second', 'third'].entries()) {
    store.recordBill({
      guildId: GUILD,
      payerId: ALICE.id,
      totalCents: 1000,
      splits: [
        { userId: ALICE.id, shareCents: 500 },
        { userId: BOB.id, shareCents: 500 },
      ],
      description,
      createdBy: ALICE.id,
      createdAt: `2026-07-27T1${i}:00:00.000Z`,
    });
  }

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);

  assert.equal((text.match(/^## /gm) ?? []).length, 1, `one heading, not three:\n${text}`);
  assert.match(text, /^## __07\/27__$/m);
  // The heading opens the group, so every entry sits below it.
  const heading = text.indexOf('## __07/27__');
  for (const d of ['first', 'second', 'third']) {
    assert.ok(text.indexOf(d) > heading, `${d} should sit under the heading`);
  }
  store.close();
});

test('e2e: each day gets its own heading, in the order the days are listed', async () => {
  const store = new Store(':memory:');
  for (const [day, description] of [
    ['25', 'oldest'],
    ['26', 'middle'],
    ['27', 'newest'],
  ] as const) {
    store.recordBill({
      guildId: GUILD,
      payerId: ALICE.id,
      totalCents: 1000,
      splits: [
        { userId: ALICE.id, shareCents: 500 },
        { userId: BOB.id, shareCents: 500 },
      ],
      description,
      createdBy: ALICE.id,
      createdAt: `2026-07-${day}T12:00:00.000Z`,
    });
  }

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);

  assert.deepEqual(
    (text.match(/^## __(.+)__$/gm) ?? []).map((h) => h.slice(5, -2)),
    ['07/27', '07/26', '07/25'],
    'headings follow the newest-first ordering of the entries',
  );
  store.close();
});

test('e2e: a backdated bill is grouped under the day it happened', async () => {
  const store = new Store(':memory:');
  // Logged on the 28th, dated the 20th: it belongs under 07/20, not 07/28.
  store.recordBill({
    guildId: GUILD,
    payerId: ALICE.id,
    totalCents: 1000,
    splits: [
      { userId: ALICE.id, shareCents: 500 },
      { userId: BOB.id, shareCents: 500 },
    ],
    description: 'backdated',
    createdBy: ALICE.id,
    createdAt: '2026-07-28T10:00:00.000Z',
    occurredAt: '2026-07-20T12:00:00.000Z',
  });

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /^## __07\/20__$/m);
  assert.doesNotMatch(text, /07\/28/, 'the day it was typed is not a heading');
  store.close();
});

test('e2e: a heading is never left with no entries under it', async () => {
  const store = new Store(':memory:');
  // Each bill is its own day, so every entry carries a heading. Enough of them
  // to force the length trim, which is where a stranded heading would appear.
  const ids = Array.from({ length: 8 }, (_, i) => String(2000 + i));
  for (let i = 0; i < 25; i++) {
    store.recordBill({
      guildId: GUILD,
      payerId: ALICE.id,
      totalCents: 800,
      splits: ids.map((userId) => ({ userId, shareCents: 100 })),
      description: `bill number ${i} with a reasonably wordy description`,
      createdBy: ALICE.id,
      createdAt: `2026-06-${String(i + 1).padStart(2, '0')}T12:00:00.000Z`,
    });
  }

  const run = makeInteraction({ caller: ALICE, integers: { count: 25 } });
  await history.execute(run.interaction, store);
  const description = run.replies[0]!.embeds![0]!.data['description'] as string;

  assert.ok(description.length <= 4096, `over the embed limit at ${description.length}`);
  assert.doesNotMatch(
    description,
    /## __[\d/]+__$/,
    'a heading is never the last thing shown',
  );
  // Every heading has an amount line after it.
  const headings = description.match(/^## .+$/gm) ?? [];
  assert.ok(headings.length > 0);
  for (const h of headings) {
    const after = description.slice(description.indexOf(h) + h.length);
    assert.match(after, /^\n `#\d+` \*\*\$/, `heading ${h} has no entry under it`);
  }
  store.close();
});

test('e2e: a day split across a page boundary is headed on both pages', async () => {
  const store = new Store(':memory:');
  // Four bills on one day, two per page: the second page opens mid-day and still
  // needs to say which day it is showing.
  for (let i = 1; i <= 4; i++) {
    store.recordBill({
      guildId: GUILD,
      payerId: ALICE.id,
      totalCents: 1000,
      splits: [
        { userId: ALICE.id, shareCents: 500 },
        { userId: BOB.id, shareCents: 500 },
      ],
      description: `bill ${i}`,
      createdBy: ALICE.id,
      createdAt: `2026-07-27T0${i}:00:00.000Z`,
    });
  }

  const run = makeInteraction({ caller: ALICE, integers: { count: 2 } });
  await history.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /^## __07\/27__$/m);

  const older = makeButtonClick(buttonNamed(run.replies[0]!, 'Older').custom_id);
  await history.handleButton(older.interaction, store);
  const next = replyText(older.updates[0]!);
  assert.match(
    next,
    /^## __07\/27__$/m,
    'the second page repeats the heading, not a bare list',
  );
  assert.match(next, /bill 2/, 'and it is the continuation of the same day');
  store.close();
});

test('e2e: the date headings follow DISPLAY_TIMEZONE, not the server clock', async () => {
  const store = new Store(':memory:');
  // 1am UTC on the 28th is 6pm on the 27th in Los Angeles. The two zones disagree
  // about which day this is, which is the whole point of the setting.
  store.recordBill({
    guildId: GUILD,
    payerId: ALICE.id,
    totalCents: 1000,
    splits: [
      { userId: ALICE.id, shareCents: 500 },
      { userId: BOB.id, shareCents: 500 },
    ],
    description: 'evening groceries',
    createdBy: ALICE.id,
    createdAt: '2026-07-28T01:00:00.000Z',
  });

  const headingWith = async (zone: string | undefined): Promise<string> => {
    const original = process.env['DISPLAY_TIMEZONE'];
    try {
      if (zone === undefined) delete process.env['DISPLAY_TIMEZONE'];
      else process.env['DISPLAY_TIMEZONE'] = zone;
      const run = makeInteraction({ caller: ALICE });
      await history.execute(run.interaction, store);
      const found = replyText(run.replies[0]!).match(/^## __(.+)__$/m);
      assert.ok(found, 'every entry sits under a heading');
      return found[1]!;
    } finally {
      if (original === undefined) delete process.env['DISPLAY_TIMEZONE'];
      else process.env['DISPLAY_TIMEZONE'] = original;
    }
  };

  assert.equal(await headingWith(undefined), '07/28', 'unset means UTC');
  assert.equal(await headingWith('America/Los_Angeles'), '07/27', 'grouped by the local day');
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
    {
      guildId: GUILD,
      focusId: BOB.id,
      focusLabel: longName,
      limit: 10,
      offset: 0,
      showDeleted: false,
    },
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
    {
      guildId: GUILD,
      focusId: '200',
      focusLabel: 'bob: the third',
      limit: 5,
      offset: 15,
      showDeleted: false,
    },
    15,
  );
  const parsed = history.parsePageId(id);
  assert.equal(parsed?.focusLabel, 'bob: the third');
  assert.equal(parsed?.offset, 15);
  assert.equal(parsed?.limit, 5);
});

test('delete and restore offer id and ids, neither of them required', async () => {
  // A bad option definition only fails when deploy-commands runs against Discord,
  // so the shape is asserted here instead. Neither may be required: Discord would
  // then demand the one the user did not mean to use.
  const { ApplicationCommandOptionType } = await import('discord.js');
  for (const cmd of [del, restore]) {
    const json = cmd.data.toJSON() as {
      name: string;
      options?: Array<{ name: string; type: number; required?: boolean }>;
    };
    const byName = new Map((json.options ?? []).map((o) => [o.name, o]));

    assert.equal(byName.get('id')?.type, ApplicationCommandOptionType.Integer, `${json.name} id`);
    assert.equal(byName.get('ids')?.type, ApplicationCommandOptionType.String, `${json.name} ids`);
    for (const name of ['id', 'ids']) {
      assert.notEqual(byName.get(name)?.required, true, `${json.name} ${name} must be optional`);
    }
  }
});

test('all commands are registered as guild-only, server-installed', async () => {
  // Declaring this on the command stops Discord offering it in DMs at all,
  // rather than relying on the runtime guard to catch it after the fact.
  const { InteractionContextType, ApplicationIntegrationType } = await import('discord.js');
  for (const cmd of [bill, balances, settle, history, edit, del, restore]) {
    const json = cmd.data.toJSON() as {
      name: string;
      contexts?: number[];
      integration_types?: number[];
    };
    assert.deepEqual(json.contexts, [InteractionContextType.Guild], `${json.name} contexts`);
    assert.deepEqual(json.integration_types, [ApplicationIntegrationType.GuildInstall]);
  }
});

/**
 * Editing and deleting are the only operations that reach backwards into the
 * ledger, so these lean hardest on the balances afterwards rather than on the
 * wording of the reply: a wrong reversal is silent, and a stale balance is the
 * only place it shows up.
 */

/** Logs one bill and returns the id it was given, which is what /edit takes. */
async function logBill(
  store: Store,
  strings: Record<string, string>,
  caller: FakeUser = ALICE,
  users: Record<string, FakeUser> = {},
): Promise<number> {
  const run = makeInteraction({ caller, strings, users });
  await bill.execute(run.interaction, store);
  return store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0]!.id;
}

/** An interaction naming several entries through the `ids` option. */
function idsRun(caller: FakeUser, ids: string) {
  return makeInteraction({ caller, strings: { ids } });
}

test('e2e: deleting a bill undoes exactly the balances it created', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '30', with: '<@200> <@300>', description: 'dinner' });
  const keep = await logBill(store, { amount: '10', with: '<@200>', description: 'coffee' });
  assert.notEqual(keep, id, 'each entry gets its own id');
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 1500);

  const run = makeInteraction({ caller: ALICE, integers: { id } });
  await del.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Deleted #1/);
  assert.match(text, /dinner/, 'says what was deleted, not just its id');
  assert.match(text, new RegExp(`/restore id:${id}`), 'says how to undo it');

  // Only the deleted bill's shares come off; the other bill is untouched.
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 500);
  assert.equal(store.owedBetween(GUILD, CAROL.id, ALICE.id), 0);
  store.close();
});

test('e2e: a deleted bill is hidden from history until show_deleted asks for it', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '30', with: '<@200>', description: 'dinner' });
  await logBill(store, { amount: '10', with: '<@200>', description: 'coffee' });
  await del.execute(makeInteraction({ caller: BOB, integers: { id } }).interaction, store);

  const hidden = makeInteraction({ caller: ALICE });
  await history.execute(hidden.interaction, store);
  const hiddenText = replyText(hidden.replies[0]!);
  assert.doesNotMatch(hiddenText, /dinner/, 'a deleted bill is not listed by default');
  assert.match(hiddenText, /coffee/);
  assert.doesNotMatch(hiddenText, /including deleted/);

  const shown = makeInteraction({ caller: ALICE, booleans: { show_deleted: true } });
  await history.execute(shown.interaction, store);
  const shownText = replyText(shown.replies[0]!);
  // Struck through, and the title says so - a listing including deleted entries
  // does not add up against /balances, so it has to announce itself.
  assert.match(shownText, /including deleted/);
  assert.match(shownText, /~~\*\*\$30\.00 - dinner\*\*~~/);
  assert.match(shownText, /Deleted by <@200>/, 'names who deleted it');
  store.close();
});

test('e2e: restoring reproduces the balances the delete removed, exactly', async () => {
  const store = new Store(':memory:');
  // An uneven split, so a reversal that re-split instead of restoring the stored
  // shares would land the spare penny somewhere else and be caught here.
  const id = await logBill(store, { amount: '10', with: '<@200> <@300>', description: 'dinner' });
  const before = store.allBalances(GUILD);
  const splitsBefore = (store.entryById(GUILD, id) as BillEntry).splits;

  await del.execute(makeInteraction({ caller: ALICE, integers: { id } }).interaction, store);
  assert.deepEqual(store.allBalances(GUILD), [], 'nothing owed once it is deleted');

  const run = makeInteraction({ caller: CAROL, integers: { id } });
  await restore.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /Restored #1/);
  assert.match(replyText(run.replies[0]!), /dinner/);

  assert.deepEqual(store.allBalances(GUILD), before, 'restored penny-for-penny');
  assert.deepEqual((store.entryById(GUILD, id) as BillEntry).splits, splitsBefore);
  assert.equal(store.entryById(GUILD, id)?.voidedAt, null, 'no longer marked deleted');
  store.close();
});

test('e2e: deleting a payment puts the debt back', async () => {
  const store = new Store(':memory:');
  await logBill(store, { amount: '20', with: '<@200>', description: 'dinner' });
  await settle.execute(makeInteraction({ caller: BOB, users: { to: ALICE } }).interaction, store);
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 0);

  const paymentId = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0]!.id;
  const run = makeInteraction({ caller: BOB, integers: { id: paymentId } });
  await del.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /from <@200> to <@100>/);
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 1000, 'the debt is owed again');
  store.close();
});

test('e2e: ids deletes several at once, undoing each of their balances', async () => {
  const store = new Store(':memory:');
  const a = await logBill(store, { amount: '30', with: '<@200> <@300>', description: 'dinner' });
  const b = await logBill(store, { amount: '10', with: '<@200>', description: 'coffee' });
  const keep = await logBill(store, { amount: '8', with: '<@200>', description: 'bagel' });
  // Alice pays and shares, so dinner is 3 ways and the other two are 2 ways.
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 1000 + 500 + 400);

  const run = idsRun(ALICE, `${a},${b}`);
  await del.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Deleted 2 entries/);
  // Each line has to name its id: once they are gone from /history there is
  // nothing else to tell the reader which entry was which.
  assert.match(text, /`#1`.*dinner/);
  assert.match(text, /`#2`.*coffee/);
  assert.match(text, new RegExp(`/restore ids:${a},${b}`), 'the undo hint names them all');

  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 400, 'only the bagel is left');
  assert.equal(store.owedBetween(GUILD, CAROL.id, ALICE.id), 0);
  assert.equal(store.entryById(GUILD, keep)?.voidedAt, null, 'an unnamed entry is untouched');
  store.close();
});

test('e2e: restoring several at once puts every balance back exactly', async () => {
  const store = new Store(':memory:');
  // Uneven totals, so a restore that re-split rather than reusing the stored
  // shares would land a spare penny on the wrong person and be caught here.
  const a = await logBill(store, { amount: '10', with: '<@200> <@300>', description: 'dinner' });
  const b = await logBill(store, { amount: '20', with: '<@200> <@300>', description: 'lunch' });
  const before = store.allBalances(GUILD);

  await del.execute(idsRun(ALICE, `${a},${b}`).interaction, store);
  assert.deepEqual(store.allBalances(GUILD), []);

  const run = idsRun(BOB, `${a},${b}`);
  await restore.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /Restored 2 entries/);
  assert.deepEqual(store.allBalances(GUILD), before, 'restored penny-for-penny');
  store.close();
});

test('e2e: one bad id in a batch deletes nothing at all', async () => {
  const store = new Store(':memory:');
  const a = await logBill(store, { amount: '30', with: '<@200>', description: 'dinner' });
  const b = await logBill(store, { amount: '10', with: '<@200>', description: 'coffee' });
  const before = store.allBalances(GUILD);

  // 999 comes last, so the two valid ids ahead of it have already been voided
  // inside the transaction by the time it fails. Nothing may survive that.
  const run = idsRun(ALICE, `${a},${b},999`);
  await assert.rejects(() => del.execute(run.interaction, store), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /no entry `#999`/);
    assert.match(err.message, /Nothing was deleted/, 'says the batch did not go through');
    return true;
  });

  assert.deepEqual(store.allBalances(GUILD), before, 'balances are exactly as they were');
  assert.equal(store.entryById(GUILD, a)?.voidedAt, null, 'the ids before the bad one survive');
  assert.equal(store.entryById(GUILD, b)?.voidedAt, null);
  store.close();
});

test('e2e: a batch that names an already-deleted entry rolls the rest back', async () => {
  const store = new Store(':memory:');
  const gone = await logBill(store, { amount: '30', with: '<@200>', description: 'dinner' });
  const live = await logBill(store, { amount: '10', with: '<@200>', description: 'coffee' });
  await del.execute(makeInteraction({ caller: ALICE, integers: { id: gone } }).interaction, store);
  const before = store.allBalances(GUILD);

  const run = idsRun(ALICE, `${live},${gone}`);
  await assert.rejects(() => del.execute(run.interaction, store), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /already deleted/);
    assert.match(err.message, /Nothing was deleted/);
    return true;
  });
  assert.deepEqual(store.allBalances(GUILD), before);
  assert.equal(store.entryById(GUILD, live)?.voidedAt, null);
  store.close();
});

test('e2e: ids collapses duplicates rather than deleting twice', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });

  // The second mention must not be treated as a separate delete: that would hit
  // the already-deleted check and refuse a request that is perfectly clear.
  const run = idsRun(ALICE, `${id}, ${id}`);
  await del.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /Deleted #1/, 'one entry, so the single-id wording');
  assert.deepEqual(store.allBalances(GUILD), []);
  store.close();
});

test('e2e: a single id given through ids reads as one entry, not a batch', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });

  const run = idsRun(ALICE, `#${id}`);
  await del.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Deleted #1/);
  assert.match(text, new RegExp(`/restore id:${id}`), 'hints the single-entry option');
  assert.doesNotMatch(text, /`#1` \*\*/, 'no id prefix on the only line');
  store.close();
});

test('e2e: id and ids together is refused rather than guessed at', async () => {
  const store = new Store(':memory:');
  const a = await logBill(store, { amount: '30', with: '<@200>', description: 'dinner' });
  const b = await logBill(store, { amount: '10', with: '<@200>', description: 'coffee' });
  const before = store.allBalances(GUILD);

  for (const cmd of [del, restore]) {
    const run = makeInteraction({ caller: ALICE, integers: { id: a }, strings: { ids: String(b) } });
    await assert.rejects(() => cmd.execute(run.interaction, store), (err: unknown) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /not both/);
      return true;
    });
  }
  assert.deepEqual(store.allBalances(GUILD), before);
  store.close();
});

test('e2e: naming no id at all explains both ways to name one', async () => {
  const store = new Store(':memory:');
  await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });

  for (const cmd of [del, restore]) {
    const run = makeInteraction({ caller: ALICE });
    await assert.rejects(() => cmd.execute(run.interaction, store), (err: unknown) => {
      assert.ok(err instanceof UserError);
      assert.match(err.message, /id:7/);
      assert.match(err.message, /ids:7,9/);
      return true;
    });
  }
  store.close();
});

test('ids rejects anything that is not a plain whole number', async () => {
  const store = new Store(':memory:');
  await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });

  // Number() would take all of these; none is an id anybody meant to type, and
  // silently rounding one would delete an entry the user never named.
  for (const bad of ['1.5', '0x1', '1e3', '+1', '-1', '0', 'abc', '1,,two']) {
    const run = idsRun(ALICE, bad);
    await assert.rejects(() => del.execute(run.interaction, store), (err: unknown) => {
      assert.ok(err instanceof UserError, `${bad} should raise a UserError`);
      assert.match(err.message, /is not an entry id|Ids start at 1/);
      return true;
    });
  }
  assert.deepEqual(store.allBalances(GUILD), [{ creditor: '100', debtor: '200', cents: 500 }]);
  store.close();
});

test('ids refuses a batch larger than the cap', async () => {
  const store = new Store(':memory:');
  const tooMany = Array.from({ length: MAX_ENTRY_IDS + 1 }, (_, i) => i + 1).join(',');
  const run = idsRun(ALICE, tooMany);
  await assert.rejects(() => del.execute(run.interaction, store), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, new RegExp(`most I can act on at once is ${MAX_ENTRY_IDS}`));
    return true;
  });
  store.close();
});

test('e2e: deleting the same entry twice is refused and points at restore', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });
  await del.execute(makeInteraction({ caller: ALICE, integers: { id } }).interaction, store);

  const second = makeInteraction({ caller: ALICE, integers: { id } });
  await assert.rejects(() => del.execute(second.interaction, store), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /already deleted/);
    assert.match(err.message, /\/restore id:1/);
    return true;
  });
  // The refusal must not have reversed the balances a second time.
  assert.deepEqual(store.allBalances(GUILD), []);
  store.close();
});

test('e2e: restoring an entry that is not deleted says there is nothing to do', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });
  const before = store.allBalances(GUILD);

  const run = makeInteraction({ caller: ALICE, integers: { id } });
  await assert.rejects(() => restore.execute(run.interaction, store), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /is not deleted/);
    return true;
  });
  assert.deepEqual(store.allBalances(GUILD), before, 'balances must not double up');
  store.close();
});

test('e2e: an id that does not exist is refused by every command that takes one', async () => {
  const store = new Store(':memory:');
  await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });

  for (const cmd of [del, restore, edit]) {
    const run = makeInteraction({
      caller: ALICE,
      integers: { id: 999 },
      strings: { amount: '5' },
    });
    await assert.rejects(() => cmd.execute(run.interaction, store), (err: unknown) => {
      assert.ok(err instanceof UserError, `${cmd.data.name} should raise a UserError`);
      assert.match(err.message, /no entry `#999`/);
      return true;
    });
  }
  assert.deepEqual(store.allBalances(GUILD), [{ creditor: '100', debtor: '200', cents: 500 }]);
  store.close();
});

test('e2e: editing the amount re-splits it and moves the balances with it', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '30', with: '<@200> <@300>', description: 'dinner' });
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 1000);

  const run = makeInteraction({ caller: BOB, integers: { id }, strings: { amount: '60' } });
  await edit.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Edited #1/);
  assert.match(text, /\$30\.00 → \*\*\$60\.00\*\*/);
  assert.match(text, /<@200> owes \$20\.00/);

  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 2000);
  assert.equal(store.owedBetween(GUILD, CAROL.id, ALICE.id), 2000);
  store.close();
});

test('e2e: editing only the description leaves the leftover penny where it was', async () => {
  const store = new Store(':memory:');
  // $10 three ways is 334/333/333, so a needless re-split would move a real cent
  // of debt between two people without saying so.
  const id = await logBill(store, { amount: '10', with: '<@200> <@300>', description: 'dinner' });
  const before = store.allBalances(GUILD);
  const splitsBefore = (store.entryById(GUILD, id) as BillEntry).splits;

  // Repeated, because the spare penny is assigned at random: a single edit that
  // wrongly re-split would land on the same person by chance often enough to look
  // fine, and drift that only appears on the fourth edit is still real drift.
  for (const description of ['thai food', 'thai', 'thai food again', 'dinner', 'supper']) {
    const run = makeInteraction({ caller: ALICE, integers: { id }, strings: { description } });
    await edit.execute(run.interaction, store);
    assert.deepEqual(
      (store.entryById(GUILD, id) as BillEntry).splits,
      splitsBefore,
      `the shares must be untouched after renaming to ${description}`,
    );
    assert.deepEqual(store.allBalances(GUILD), before);
  }
  store.close();
});

test('e2e: changing who paid keeps the same people in the split', async () => {
  const store = new Store(':memory:');
  // Alice paid and shared it, so bob is already a participant. Handing the bill
  // to bob must not drop alice: it is still three people sharing $30.
  const id = await logBill(store, {
    amount: '30',
    with: '<@200> <@300>',
    description: 'dinner',
  });

  const run = makeInteraction({ caller: ALICE, integers: { id }, users: { payer: BOB } });
  await edit.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Paid by: <@100> → \*\*<@200>\*\*/);
  assert.doesNotMatch(text, /Split between/, 'the split membership did not change');

  const after = store.entryById(GUILD, id) as BillEntry;
  assert.equal(after.payerId, BOB.id);
  assert.deepEqual(
    after.splits.map((s) => s.userId).sort(),
    [ALICE.id, BOB.id, CAROL.id],
    'all three still share it',
  );
  // The debts now point at bob, and alice owes her own share rather than none.
  assert.equal(store.owedBetween(GUILD, ALICE.id, BOB.id), 1000);
  assert.equal(store.owedBetween(GUILD, CAROL.id, BOB.id), 1000);
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), -1000, 'the old debt is gone');
  store.close();
});

test('e2e: replacing the participants re-splits between the new ones only', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '30', with: '<@200> <@300>', description: 'dinner' });

  const run = makeInteraction({ caller: ALICE, integers: { id }, strings: { with: '<@400>' } });
  await edit.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /Split between: 3 → \*\*2 people\*\*/);

  assert.equal(store.owedBetween(GUILD, DAVE.id, ALICE.id), 1500);
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 0, 'bob is out of it entirely');
  assert.equal(store.owedBetween(GUILD, CAROL.id, ALICE.id), 0);
  store.close();
});

test('e2e: excluding the payer on an edit charges the others in full', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '30', with: '<@200> <@300>', description: 'dinner' });

  const run = makeInteraction({
    caller: ALICE,
    integers: { id },
    booleans: { include_payer: false },
  });
  await edit.execute(run.interaction, store);

  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 1500);
  assert.equal(store.owedBetween(GUILD, CAROL.id, ALICE.id), 1500);
  const after = store.entryById(GUILD, id) as BillEntry;
  assert.deepEqual(after.splits.map((s) => s.userId).sort(), [BOB.id, CAROL.id]);
  store.close();
});

test('e2e: an edit naming nothing to change is refused', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });

  const run = makeInteraction({ caller: ALICE, integers: { id } });
  await assert.rejects(() => edit.execute(run.interaction, store), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /at least one thing to change/);
    return true;
  });
  assert.equal(store.entryById(GUILD, id)?.editedAt, null, 'nothing was stamped as edited');
  store.close();
});

test('e2e: editing a payment is refused with the two commands that do work', async () => {
  const store = new Store(':memory:');
  await logBill(store, { amount: '20', with: '<@200>', description: 'dinner' });
  await settle.execute(makeInteraction({ caller: BOB, users: { to: ALICE } }).interaction, store);
  const paymentId = store.recentEntries({ guildId: GUILD, limit: 1 }).entries[0]!.id;

  const run = makeInteraction({
    caller: BOB,
    integers: { id: paymentId },
    strings: { amount: '5' },
  });
  await assert.rejects(() => edit.execute(run.interaction, store), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /is a payment, not a bill/);
    assert.match(err.message, /\/delete id:2/);
    assert.match(err.message, /\/settle/);
    return true;
  });
  assert.equal(store.owedBetween(GUILD, BOB.id, ALICE.id), 0, 'the payment still stands');
  store.close();
});

test('e2e: editing a deleted entry is refused until it is restored', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });
  await del.execute(makeInteraction({ caller: ALICE, integers: { id } }).interaction, store);

  const run = makeInteraction({ caller: ALICE, integers: { id }, strings: { amount: '20' } });
  await assert.rejects(() => edit.execute(run.interaction, store), (err: unknown) => {
    assert.ok(err instanceof UserError);
    assert.match(err.message, /is deleted/);
    assert.match(err.message, /\/restore id:1/);
    return true;
  });
  // Editing a deleted entry must not resurrect its balances by the back door.
  assert.deepEqual(store.allBalances(GUILD), []);
  store.close();
});

test('e2e: an edited entry says so in history, and names the editor', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });
  await edit.execute(
    makeInteraction({ caller: CAROL, integers: { id }, strings: { amount: '20' } }).interaction,
    store,
  );

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  assert.match(text, /Edited by <@300>/);
  assert.match(text, /\$20\.00 - dinner/, 'the new amount is what is listed');
  assert.doesNotMatch(text, /\$10\.00 - dinner/);
  store.close();
});

test('e2e: an edit that changes nothing is reported as such rather than faked', async () => {
  const store = new Store(':memory:');
  const id = await logBill(store, { amount: '10', with: '<@200>', description: 'dinner' });
  const before = store.allBalances(GUILD);

  // Restating the stored values: accepted, but the reply must not claim a change.
  const run = makeInteraction({
    caller: ALICE,
    integers: { id },
    strings: { amount: '10', description: 'dinner' },
  });
  await edit.execute(run.interaction, store);
  assert.match(replyText(run.replies[0]!), /Nothing actually changed/);
  assert.deepEqual(store.allBalances(GUILD), before);
  store.close();
});

test('e2e: every entry in history carries the id that /delete takes', async () => {
  const store = new Store(':memory:');
  const first = await logBill(store, { amount: '10', with: '<@200>', description: 'one' });
  const second = await logBill(store, { amount: '20', with: '<@300>', description: 'two' });

  const run = makeInteraction({ caller: ALICE });
  await history.execute(run.interaction, store);
  const text = replyText(run.replies[0]!);
  // Reading the ids back out of the rendering is what proves they are usable:
  // a listing that showed the wrong id would send /delete at the wrong entry.
  const shown = [...text.matchAll(/`#(\d+)`/g)].map((m) => Number(m[1]));
  assert.deepEqual(shown.sort(), [first, second].sort());
  store.close();
});

test('paging keeps show_deleted on, so page two does not silently drop them', async () => {
  const store = new Store(':memory:');
  for (let i = 0; i < 4; i += 1) {
    const id = await logBill(store, { amount: '10', with: '<@200>', description: `bill ${i}` });
    if (i === 3) {
      await del.execute(makeInteraction({ caller: ALICE, integers: { id } }).interaction, store);
    }
  }

  const run = makeInteraction({ caller: ALICE, integers: { count: 2 }, booleans: { show_deleted: true } });
  await history.execute(run.interaction, store);
  const older = buttonNamed(run.replies[0]!, 'Older');
  assert.equal(history.parsePageId(older.custom_id)?.showDeleted, true);

  const click = makeButtonClick(older.custom_id);
  await history.handleButton(click.interaction, store);
  assert.match(replyText(click.updates[0]!), /including deleted/, 'page two still includes them');
  store.close();
});

test('a paging button written before show_deleted existed still works', () => {
  // Old messages carry ids with the label where the flag now sits. Those buttons
  // have to keep paging rather than going dead after a deploy.
  const parsed = history.parsePageId('history:10:5:200:bob');
  assert.equal(parsed?.offset, 10);
  assert.equal(parsed?.limit, 5);
  assert.equal(parsed?.focusId, '200');
  assert.equal(parsed?.focusLabel, 'bob');
  assert.equal(parsed?.showDeleted, false, 'absent means off, never on');
});

test('e2e: each kind of reply is prefixed with its own emoji', async () => {
  const store = new Store(':memory:');
  // The emoji is the fastest way to tell what a reply is when several are
  // scrolling past in a busy channel, so one is pinned per category here rather
  // than left to drift as titles get reworded.
  const id = await logBill(store, { amount: '20', with: '<@200>', description: 'dinner' });
  const seen = new Map<string, string>();

  const runs: [string, () => Promise<Reply>][] = [
    ['bill', async () => {
      const r = makeInteraction({ caller: ALICE, strings: { amount: '5', with: '<@300>', description: 'coffee' } });
      await bill.execute(r.interaction, store);
      return r.replies[0]!;
    }],
    ['balances', async () => {
      const r = makeInteraction({ caller: ALICE });
      await balances.execute(r.interaction, store);
      return r.replies[0]!;
    }],
    ['history', async () => {
      const r = makeInteraction({ caller: ALICE });
      await history.execute(r.interaction, store);
      return r.replies[0]!;
    }],
    ['edit', async () => {
      const r = makeInteraction({ caller: ALICE, integers: { id }, strings: { amount: '30' } });
      await edit.execute(r.interaction, store);
      return r.replies[0]!;
    }],
    ['settle', async () => {
      const r = makeInteraction({ caller: BOB, users: { to: ALICE } });
      await settle.execute(r.interaction, store);
      return r.replies[0]!;
    }],
    ['delete', async () => {
      const r = makeInteraction({ caller: ALICE, integers: { id } });
      await del.execute(r.interaction, store);
      return r.replies[0]!;
    }],
    ['restore', async () => {
      const r = makeInteraction({ caller: ALICE, integers: { id } });
      await restore.execute(r.interaction, store);
      return r.replies[0]!;
    }],
  ];

  for (const [name, run] of runs) {
    const title = (await run()).embeds?.[0]?.data['title'];
    assert.equal(typeof title, 'string', `${name} should reply with a titled embed`);
    seen.set(name, title as string);
  }

  assert.match(seen.get('bill')!, /^💳 /);
  assert.match(seen.get('balances')!, /^💰 /);
  assert.match(seen.get('history')!, /^🕓 /);
  assert.match(seen.get('settle')!, /^✅ Payment settled/);
  assert.match(seen.get('edit')!, /^✏️ /);
  assert.match(seen.get('delete')!, /^🗑️ /);
  assert.match(seen.get('restore')!, /^♻️ /);
  store.close();
});
