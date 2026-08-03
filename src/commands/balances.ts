import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { entryWhen, type PairBalance, type PairContribution, type Store } from '../db.js';
import { UserError } from '../errors.js';
import { guildOnly, requireGuild } from '../guild.js';
import { formatCents } from '../money.js';
import { visibility, voiceOf } from '../visibility.js';
import { capitalise, verb, who, type Voice } from '../voice.js';

/**
 * A bare `/balances` shows the caller their own debts, privately.
 *
 * That is what the command is nearly always run for, and it is the one answer that
 * is nobody else's business by default: asking what you owe should not announce it
 * to the channel. The server-wide listing it used to give is still there behind
 * `everyone:true`, and `private:false` posts any of it to the channel.
 */
export const privateByDefault = true;

/**
 * How many pairs to list at one line each.
 *
 * Well inside Discord's 4096-character description limit, and past the point where
 * a wall of debts is worth reading top to bottom rather than narrowing with `user`.
 */
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

/**
 * The flag that asks for the whole server rather than just the caller.
 *
 * Named for what it shows rather than as a negation of the default, so it reads the
 * same whichever the default happens to be.
 */
const EVERYONE_OPTION = 'everyone';

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('balances')
    .setDescription('Show what you owe and are owed')
    .addUserOption((o) =>
      o.setName('user').setDescription('Show this person instead of yourself'),
    )
    .addBooleanOption((o) =>
      o
        .setName(EVERYONE_OPTION)
        .setDescription('Show every debt in the server, not just one person (default: no)'),
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
 * One debt, as debtor → creditor.
 *
 * The same line both listings use, so a pair reads identically whether or not the
 * entries behind it are shown.
 *
 * The reader of a private reply appears as `You` rather than as a mention of
 * themselves, which is both shorter and what makes a column of arrows scannable:
 * their own name repeating down one side carries no information.
 */
function pairLine(balance: PairBalance, voice: Voice): string {
  const debtor = capitalise(who(voice, balance.debtor));
  const creditor = who(voice, balance.creditor);
  return `${debtor} → ${creditor}  **${formatCents(balance.cents)}**`;
}

/**
 * A pair's headline followed by the entries that make it up.
 *
 * The pair total is restated at the end of the running column rather than only in
 * the headline, so the two can be compared without scrolling back up.
 */
function detailedBlock(
  balance: PairBalance,
  contributions: PairContribution[],
  voice: Voice,
): string {
  const headline = pairLine(balance, voice);
  if (contributions.length === 0) {
    // Not reachable from a ledger this bot wrote - a nonzero balance always has
    // entries behind it - but a hand-edited database should not render a bare
    // headline that looks like a rendering bug.
    return `${headline}\n _No live entries account for this. Check \`/history\`._`;
  }
  return [headline, ...breakdownLines(contributions)].join('\n');
}

/** Who a listing is about, when it is about one person. */
interface Focus {
  id: string;
  /**
   * How the prose refers to them: their display name, or `you` when the reply is
   * private and they are the one reading it.
   *
   * A name rather than a mention, unlike the pair lines. This appears in a heading
   * and in the title, where Discord would render a mention as a pill inside the
   * underline and the emphasis would sit crookedly around it.
   */
  name: string;
  /** Whether `name` is `you`, which the surrounding prose has to agree with. */
  isReader: boolean;
}

/** Which side of the focus person a debt sits on: money coming in, or going out. */
type Direction = 'in' | 'out';

function directionOf(balance: PairBalance, focus: Focus): Direction {
  return balance.creditor === focus.id ? 'in' : 'out';
}

/**
 * The heading for one direction, carrying that direction's subtotal.
 *
 * Phrased as who owes whom rather than as "incoming" and "outgoing", since which of
 * those a debt counts as depends on whose listing it is - a heading naming the
 * person cannot be read the wrong way round.
 */
function groupHeading(direction: Direction, focus: Focus, voice: Voice, cents: number): string {
  const label =
    direction === 'in'
      ? `Owed to ${focus.name}`
      : `${capitalise(focus.name)} ${verb(voice, focus.id, 'owes', 'owe')}`;
  return `__${label}__ · **${formatCents(cents)}**`;
}

function subtotal(balances: PairBalance[]): number {
  return balances.reduce((sum, b) => sum + b.cents, 0);
}

/**
 * The pairs to render, in the order they are rendered, each carrying the heading
 * that opens its direction if it is the first of them.
 *
 * Which pairs are dropped is decided on the original largest-first order, before
 * grouping, so grouping changes how the same pairs are arranged rather than which
 * ones survive. Each direction then holds a run of consecutive pairs, which is what
 * lets a heading be written once per direction instead of every time the listing
 * would otherwise alternate between them.
 *
 * Headings appear only when the person has debts running both ways. One way only
 * and the list is already homogeneous, with its total already stated as the net
 * position underneath, so a heading would label the obvious and repeat a figure.
 *
 * Each subtotal is taken over *every* debt in its direction, including any that did
 * not fit, so the two of them differ by exactly the net position below. A subtotal
 * of only the visible pairs would be a third figure agreeing with neither the lines
 * above it nor the net below it, which is the worse of the two ways to be
 * incomplete: a figure that is short by a stated number of omitted pairs is
 * checkable, and one that is short by an unstated amount is not.
 */
function arrange(
  balances: PairBalance[],
  focus: Focus | null,
  voice: Voice,
  limit: number,
): Array<{ balance: PairBalance; heading: string | null }> {
  const kept = balances.slice(0, limit);
  if (!focus) return kept.map((balance) => ({ balance, heading: null }));

  const byDirection = (list: PairBalance[], d: Direction): PairBalance[] =>
    list.filter((b) => directionOf(b, focus) === d);

  const directions: Direction[] = ['in', 'out'];
  // Judged on the whole set rather than on what fits, so a listing does not lose
  // its headings - and with them the fact that money runs both ways - purely
  // because the far direction's pairs are the small ones that got cut.
  if (directions.some((d) => byDirection(balances, d).length === 0)) {
    return kept.map((balance) => ({ balance, heading: null }));
  }

  return directions.flatMap((direction) =>
    byDirection(kept, direction).map((balance, i) => ({
      balance,
      heading:
        i === 0
          ? groupHeading(direction, focus, voice, subtotal(byDirection(balances, direction)))
          : null,
    })),
  );
}

/** What a rendered listing came to, and how many pairs it could not fit. */
interface Rendered {
  description: string;
  omitted: number;
}

/** One line per pair: the default listing. */
function renderPlain(balances: PairBalance[], focus: Focus | null, voice: Voice): Rendered {
  const arranged = arrange(balances, focus, voice, MAX_LINES);
  const lines: string[] = [];
  for (const { balance, heading } of arranged) {
    // A blank line before every heading but the first, so the two directions read
    // as separate lists rather than one list with labels in the middle of it.
    if (heading !== null) lines.push(lines.length === 0 ? heading : `\n${heading}`);
    lines.push(pairLine(balance, voice));
  }

  const omitted = balances.length - arranged.length;
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
function renderDetailed(
  balances: PairBalance[],
  focus: Focus | null,
  voice: Voice,
  guildId: string,
  store: Store,
): Rendered {
  const blocks: string[] = [];
  let length = 0;
  let shown = 0;

  for (const { balance, heading } of arrange(balances, focus, voice, MAX_DETAILED_PAIRS)) {
    // The heading joins its pair's block rather than standing as a block of its
    // own, so length-based truncation can never leave a direction labelled with
    // nothing under it.
    const detail = detailedBlock(
      balance,
      store.entriesBetween(guildId, balance.creditor, balance.debtor),
      voice,
    );
    const block = heading === null ? detail : `${heading}\n${detail}`;
    const added = length === 0 ? block.length : length + 2 + block.length;
    if (added > MAX_DESCRIPTION) break;
    blocks.push(block);
    length = added;
    shown += 1;
  }

  const omitted = balances.length - shown;
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

/**
 * The one figure a focused listing exists to report.
 *
 * "Owed" and "Owes" have no subject in the public wording, which reads as a label on
 * the person in the title. A private reply is addressed to that person, so it says
 * so, and the verb has to agree.
 */
function netPosition(net: number, focus: Focus): string {
  if (net === 0) return 'Even overall, though individual debts remain.';
  const amount = `**${formatCents(Math.abs(net))}** overall.`;
  if (net > 0) return focus.isReader ? `You are owed ${amount}` : `Owed ${amount}`;
  return focus.isReader ? `You owe ${amount}` : `Owes ${amount}`;
}

/**
 * The title, which is the only place the listing says whose debts these are.
 *
 * A private listing about the reader says "Your balances" rather than repeating
 * their own name back at them; anything else names the person, since a title of
 * "Balances for you" on a message the channel can read would be addressing nobody.
 */
function titleFor(focus: Focus | null): string {
  if (!focus) return '💰 Outstanding balances';
  if (focus.isReader) return '💰 Your balances';
  return `💰 Balances for ${focus.name}`;
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);

  const user = interaction.options.getUser('user');
  const everyone = interaction.options.getBoolean(EVERYONE_OPTION) ?? false;
  const details = interaction.options.getBoolean('details') ?? false;
  const voice = voiceOf(interaction, privateByDefault);

  if (everyone && user) {
    // Both were given and they contradict each other. Refusing beats picking one:
    // either guess produces a listing that looks like an answer to the other
    // question, and the figures alone do not say which was honoured.
    throw new UserError(
      `\`${EVERYONE_OPTION}:true\` shows the whole server and \`user\` narrows to one ` +
        'person, so naming both says two different things. Drop whichever you did not mean.',
    );
  }

  // The person a bare `/balances` is about: whoever ran it. Naming a `user` is how
  // to ask about somebody else, and `everyone:true` is how to ask about nobody in
  // particular.
  const subject = everyone ? null : (user ?? interaction.user);
  const isReader = subject !== null && voice.you === subject.id;
  const focus: Focus | null = subject
    ? {
        id: subject.id,
        // `you` only when the reply is going to that person alone. In the channel,
        // or when asking about somebody else, their name is the only thing that
        // identifies them.
        name: isReader ? 'you' : subject.displayName,
        isReader,
      }
    : null;

  const balances = focus
    ? store.balancesFor(guild.id, focus.id)
    : store.allBalances(guild.id);

  if (balances.length === 0) {
    await interaction.reply({
      ...visibility(interaction, privateByDefault),
      embeds: [
        new EmbedBuilder()
          .setColor(0x4f9d69)
          .setTitle('✅ All settled up')
          .setDescription(
            focus
              ? `${capitalise(focus.name)} ${
                  verb(voice, focus.id, 'does not owe', 'do not owe')
                } anyone and ${verb(voice, focus.id, 'is', 'are')} not owed anything.`
              : 'Nobody in this server owes anybody.',
          ),
      ],
    });
    return;
  }

  const { description, omitted } = details
    ? renderDetailed(balances, focus, voice, guild.id, store)
    : renderPlain(balances, focus, voice);

  const embed = new EmbedBuilder()
    .setColor(0xd98e04)
    .setTitle(titleFor(focus))
    .setDescription(description);

  if (focus) {
    // A single net figure is the number this person actually cares about.
    const net = netTotals(balances).get(focus.id) ?? 0;
    embed.addFields({ name: 'Net position', value: netPosition(net, focus) });
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

  await interaction.reply({
    ...visibility(interaction, privateByDefault),
    embeds: [embed],
  });
}
