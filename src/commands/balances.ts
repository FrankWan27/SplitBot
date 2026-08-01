import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { entryWhen, type PairBalance, type PairContribution, type Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { formatCents } from '../money.js';
import { visibility } from '../visibility.js';

/** Discord rejects embed descriptions over 4096 characters. */
const MAX_LINES = 40;

/** Discord rejects an embed whose description exceeds this. */
const MAX_DESCRIPTION = 4096;

/**
 * How many pairs to break down when `details` is on.
 *
 * A breakdown runs to several lines per pair, so a busy server would blow the
 * embed limit long before the 40 pairs a plain listing manages. Kept low enough
 * that the reply stays readable rather than merely legal.
 */
export const MAX_DETAILED_PAIRS = 8;

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('balances')
    .setDescription('Show who owes who')
    .addUserOption((o) =>
      o.setName('user').setDescription('Only show debts involving this person'),
    )
    .addBooleanOption((o) =>
      o
        .setName('details')
        .setDescription('Show the bills and payments that add up to each balance (default: no)'),
    ),
);

/** Renders a Discord date, which localises itself per viewer. */
function shortDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return `<t:${Math.floor(ms / 1000)}:d>`;
}

/**
 * One line per entry behind a pair's balance, with a running total.
 *
 * The running total is the whole point of the breakdown: it lets a reader follow
 * the figure from zero to the number `/balances` reports, so a disputed balance
 * can be checked line by line rather than taken on trust. Signs are shown as `+`
 * and `-` against the debtor for the same reason - a payment has to visibly
 * subtract.
 */
function breakdownLines(contributions: PairContribution[]): string[] {
  let running = 0;
  return contributions.map(({ entry, cents }) => {
    running += cents;
    const sign = cents >= 0 ? '+' : '-';
    // A payment has no description to show, and italics mark the difference
    // between a label this bot chose and text somebody typed.
    const what = entry.kind === 'payment' ? '_payment_' : (entry.description ?? 'no description');
    // The id is included so a line the reader disagrees with can be taken
    // straight to `/edit` or `/delete`.
    return (
      ` \`#${entry.id}\` ${shortDate(entryWhen(entry))} ${what} ` +
      `**${sign}${formatCents(Math.abs(cents))}** → ${formatCents(running)}`
    );
  });
}

/**
 * A pair's headline followed by the entries that make it up.
 *
 * The pair total is restated at the end of the running column rather than only in
 * the headline, so the two can be compared without scrolling back up.
 */
function detailedBlock(balance: PairBalance, contributions: PairContribution[]): string {
  const headline = `<@${balance.debtor}> → <@${balance.creditor}>  **${formatCents(balance.cents)}**`;
  if (contributions.length === 0) {
    // Not reachable from a ledger this bot wrote - a nonzero balance always has
    // entries behind it - but a hand-edited database should not render a bare
    // headline that looks like a rendering bug.
    return `${headline}\n _No live entries account for this. Check \`/history\`._`;
  }
  return [headline, ...breakdownLines(contributions)].join('\n');
}

/** What a rendered listing came to, and how many pairs it could not fit. */
interface Rendered {
  description: string;
  omitted: number;
}

/** One line per pair: the default listing, unchanged. */
function renderPlain(balances: PairBalance[]): Rendered {
  const shown = balances.slice(0, MAX_LINES);
  const lines = shown.map(
    (b) => `<@${b.debtor}> → <@${b.creditor}>  **${formatCents(b.cents)}**`,
  );
  const omitted = balances.length - shown.length;
  if (omitted > 0) lines.push(`_...and ${omitted} more._`);
  return { description: lines.join('\n'), omitted };
}

/**
 * Each pair followed by the entries behind it, dropping whole pairs from the end
 * once the embed limit is close.
 *
 * Truncation is by whole pair rather than by line, because half a breakdown no
 * longer sums to its headline and would read as an arithmetic error rather than
 * as a listing that ran out of room.
 */
function renderDetailed(balances: PairBalance[], guildId: string, store: Store): Rendered {
  const blocks: string[] = [];
  let length = 0;

  for (const balance of balances.slice(0, MAX_DETAILED_PAIRS)) {
    const block = detailedBlock(
      balance,
      store.entriesBetween(guildId, balance.creditor, balance.debtor),
    );
    const added = length === 0 ? block.length : length + 2 + block.length;
    if (added > MAX_DESCRIPTION) break;
    blocks.push(block);
    length = added;
  }

  const omitted = balances.length - blocks.length;
  if (omitted > 0) {
    // Said in the body as well as the footer: a reader looking for a pair that is
    // not here needs to know it was dropped rather than settled.
    const note = `_...and ${omitted} more pair${omitted === 1 ? '' : 's'} not broken down. ` +
      'Name a `user` to narrow it down._';
    if (length + 2 + note.length <= MAX_DESCRIPTION) blocks.push(note);
  }

  return { description: blocks.join('\n\n'), omitted };
}

function netTotals(balances: PairBalance[]): Map<string, number> {
  const net = new Map<string, number>();
  for (const b of balances) {
    net.set(b.creditor, (net.get(b.creditor) ?? 0) + b.cents);
    net.set(b.debtor, (net.get(b.debtor) ?? 0) - b.cents);
  }
  return net;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);

  const focus = interaction.options.getUser('user');
  const details = interaction.options.getBoolean('details') ?? false;
  const balances = focus
    ? store.balancesFor(guild.id, focus.id)
    : store.allBalances(guild.id);

  if (balances.length === 0) {
    await interaction.reply({
      ...visibility(interaction),
      embeds: [
        new EmbedBuilder()
          .setColor(0x4f9d69)
          .setTitle('✅ All settled up')
          .setDescription(
            focus
              ? `<@${focus.id}> does not owe anyone and is not owed anything.`
              : 'Nobody in this server owes anybody.',
          ),
      ],
    });
    return;
  }

  const { description, omitted } = details
    ? renderDetailed(balances, guild.id, store)
    : renderPlain(balances);

  const embed = new EmbedBuilder()
    .setColor(0xd98e04)
    .setTitle(focus ? `💰 Balances for ${focus.displayName}` : '💰 Outstanding balances')
    .setDescription(description);

  if (focus) {
    // A single net figure is the number this person actually cares about.
    const net = netTotals(balances).get(focus.id) ?? 0;
    embed.addFields({
      name: 'Net position',
      value:
        net > 0
          ? `Owed **${formatCents(net)}** overall.`
          : net < 0
            ? `Owes **${formatCents(-net)}** overall.`
            : 'Even overall, though individual debts remain.',
    });
    // A focused listing has no footer of its own, so a dropped pair would
    // otherwise vanish without trace.
    if (omitted > 0) {
      embed.setFooter({ text: `${omitted} more pair${omitted === 1 ? '' : 's'} did not fit.` });
    }
  } else {
    const total = balances.reduce((sum, b) => sum + b.cents, 0);
    const summary = `${balances.length} outstanding debt${
      balances.length === 1 ? '' : 's'
    }, ${formatCents(total)} total unsettled.`;
    // The total covers every pair, including any the body could not show, so the
    // shortfall has to be stated or the figures look inconsistent.
    embed.setFooter({
      text: omitted > 0 ? `${summary} ${omitted} not shown above.` : summary,
    });
  }

  await interaction.reply({ ...visibility(interaction), embeds: [embed] });
}
