import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { entryWhen, type BillEntry, type LedgerEntry, type Store } from '../db.js';
import { dayHeading, dayKey, displayTimeZone } from '../dates.js';
import { guildOnly, requireGuild } from '../guild.js';
import { formatCents } from '../money.js';

const DEFAULT_COUNT = 5;
const MAX_COUNT = 25;

/**
 * How many participants to name on one bill before summarising the rest. A
 * mention costs about 21 characters, so a large group would otherwise push a
 * listing of 25 bills past Discord's embed limit on its own.
 */
const MAX_NAMES = 8;

/** Discord rejects an embed whose description exceeds this. */
const MAX_DESCRIPTION = 4096;

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Show recently logged bills and payments')
    .addUserOption((o) =>
      o.setName('user').setDescription('Only show entries involving this person'),
    )
    .addIntegerOption((o) =>
      o
        .setName('count')
        .setDescription(`How many entries to show (1-${MAX_COUNT}, default ${DEFAULT_COUNT})`)
        .setMinValue(1)
        .setMaxValue(MAX_COUNT),
    )
    .addBooleanOption((o) =>
      o
        .setName('show_deleted')
        .setDescription('Also show deleted entries, struck through (default: no)'),
    ),
);

/** Renders a Discord relative timestamp, which localises itself per viewer. */
function timestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/**
 * Who borrowed how much, as one line per distinct share.
 *
 * Usually every borrower owes the same amount and this is a single line. An
 * uneven split leaves one or two people a penny short, and lumping them under a
 * single figure would state an amount somebody does not actually owe, so each
 * distinct share gets its own line.
 */
function borrowedLines(entry: BillEntry): string[] {
  const others = entry.splits.filter((s) => s.userId !== entry.payerId && s.shareCents > 0);
  if (others.length === 0) return [];

  // Keyed by share so the grouping is exact, and insertion-ordered so the
  // largest-share line comes first only if it was listed first - the order the
  // bill was entered in is the least surprising one.
  const byShare = new Map<number, string[]>();
  for (const { userId, shareCents } of others) {
    const names = byShare.get(shareCents) ?? [];
    names.push(`<@${userId}>`);
    byShare.set(shareCents, names);
  }

  return [...byShare].map(([shareCents, names]) => {
    const shown = names.slice(0, MAX_NAMES);
    const hidden = names.length - shown.length;
    const who = `${shown.join(' ')}${hidden > 0 ? ` and ${hidden} more` : ''}`;
    return `${who} borrowed ${formatCents(shareCents)}.`;
  });
}

/**
 * The italic closing line: when it happened, plus whatever has been done to it
 * since. The logger is named only when it is not the payer - usually the two are
 * the same person and "Logged by" would restate the line above it, so mentioning
 * it only on the exception is what makes the exception visible at a glance.
 *
 * Each clause is capitalised, since the dashes make them separate labels rather
 * than one sentence, and a mixture would read as a mistake.
 */
function provenance(entry: LedgerEntry, payerId: string): string {
  const parts = [timestamp(entryWhen(entry))];
  if (entry.createdBy !== payerId) parts.push(`Logged by <@${entry.createdBy}>`);
  if (entry.editedBy) parts.push(`Edited by <@${entry.editedBy}>`);
  if (entry.voidedBy) parts.push(`Deleted by <@${entry.voidedBy}>`);
  return `_${parts.join(' - ')}_`;
}

function describe(entry: LedgerEntry): string {
  // The id is what `/edit` and `/delete` take, so it has to be visible on every
  // entry. In code formatting: it is a token to be retyped, not prose.
  const tag = `\`#${entry.id}\``;

  // A deleted entry is struck through, so it cannot be mistaken for one still in
  // effect, while its amount stays legible enough to decide whether to restore it.
  const headline = (body: string): string =>
    entry.voidedAt ? ` ${tag} ~~**${body}**~~` : ` ${tag} **${body}**`;

  if (entry.kind === 'payment') {
    return [
      headline(formatCents(entry.cents)),
      `<@${entry.fromId}> paid <@${entry.toId}>.`,
      provenance(entry, entry.fromId),
    ].join('\n');
  }

  // Counts everyone the bill was divided between, including the payer when they
  // took a share, which is what makes the per-person figure below add up.
  const people = entry.splits.length;
  return [
    headline(`${formatCents(entry.totalCents)} - ${entry.description ?? 'no description'}`),
    `Paid by <@${entry.payerId}> for ${people} ${people === 1 ? 'person' : 'people'}.`,
    ...borrowedLines(entry),
    provenance(entry, entry.payerId),
  ].join('\n');
}

/** What a page of history needs to render itself and its buttons. */
export interface PageRequest {
  guildId: string;
  /** Id of the user the listing is filtered to, if any. */
  focusId: string | null;
  /** Label for the title; the id alone cannot be resolved from a button click. */
  focusLabel: string | null;
  limit: number;
  offset: number;
  /** Whether deleted entries are included, which paging has to carry across. */
  showDeleted: boolean;
}

/**
 * Paging state is encoded in the button's own custom id rather than held in
 * memory, so buttons keep working across a bot restart and nothing has to be
 * expired. Format:
 *
 *     history:<offset>:<limit>:<focusId or ->:<d or ->:<focusLabel>
 *
 * The `d` flag carries `show_deleted`, so paging a listing that includes deleted
 * entries does not silently drop them on the second page.
 */
const CUSTOM_ID_PREFIX = 'history';

/** Discord rejects a custom id longer than this. */
const MAX_CUSTOM_ID = 100;

export function encodePageId(req: PageRequest, offset: number): string {
  const flag = req.showDeleted ? 'd' : '-';
  const head = `${CUSTOM_ID_PREFIX}:${offset}:${req.limit}:${req.focusId ?? '-'}:${flag}:`;
  // A display name can contain a colon, so the label goes last and is parsed as
  // "everything after the fifth colon". Truncated to fit Discord's id limit.
  return head + (req.focusLabel ?? '').slice(0, MAX_CUSTOM_ID - head.length);
}

export function parsePageId(customId: string): PageRequest | null {
  const parts = customId.split(':');
  if (parts.length < 5 || parts[0] !== CUSTOM_ID_PREFIX) return null;

  const offset = Number(parts[1]);
  const limit = Number(parts[2]);
  if (!Number.isInteger(offset) || offset < 0) return null;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_COUNT) return null;

  const focusId = parts[3] === '-' ? null : parts[3]!;

  // Buttons on messages sent before the flag existed have the label at index 4.
  // Reading it as a label in that case keeps those buttons working rather than
  // leaving them dead, at the cost of misreading a label of exactly `d` or `-`.
  const flagged = parts.length >= 6 && (parts[4] === 'd' || parts[4] === '-');
  const label = parts.slice(flagged ? 5 : 4).join(':');

  return {
    guildId: '',
    focusId,
    focusLabel: label === '' ? null : label,
    limit,
    offset,
    showDeleted: flagged && parts[4] === 'd',
  };
}

/** Builds the embed and buttons for one page. */
function buildPage(
  req: PageRequest,
  store: Store,
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const { entries, hasMore } = store.recentEntries({
    guildId: req.guildId,
    userId: req.focusId ?? undefined,
    limit: req.limit,
    offset: req.offset,
    includeVoided: req.showDeleted,
  });

  const base = req.focusLabel ? `🕓 History for ${req.focusLabel}` : '🕓 Recent history';
  // Stated in the title, since a struck-through entry is easy to miss and a
  // listing that includes deleted ones does not add up against `/balances`.
  const title = req.showDeleted ? `${base} (including deleted)` : base;

  if (entries.length === 0) {
    // Reachable on the first page of an empty ledger, and also by paging to an
    // offset whose entries were removed in between clicks.
    const empty = new EmbedBuilder().setColor(0x5865f2);
    if (req.offset > 0) {
      empty.setTitle(title).setDescription('No more entries. Page back to see earlier ones.');
    } else {
      empty
        .setTitle('🕓 Nothing logged yet')
        .setDescription(
          req.focusId
            ? `No bills or payments involving <@${req.focusId}> yet.`
            : 'No bills or payments have been logged in this server yet. Start with `/bill`.',
        );
    }
    return { embeds: [empty], components: buttonRows(req, { hasMore: false, shown: 0 }) };
  }

  // Entries are grouped under a date heading, which means an entry's rendered
  // length sometimes includes a heading and sometimes does not. Blocks are built
  // first, then appended one whole entry at a time so a heading can never be
  // stranded at the end with nothing under it.
  const zone = displayTimeZone();
  const blocks: string[] = [];
  let lastDay: string | null = null;
  for (const entry of entries) {
    const iso = entryWhen(entry);
    const day = dayKey(iso, zone);
    // A heading opens a group; a null key means an unparseable timestamp, which
    // stays under whatever heading precedes it rather than inventing one.
    // Underlined as well as headed, so the day reads as a divider between groups
    // rather than as a title belonging to the entry directly beneath it.
    const heading = day !== null && day !== lastDay ? `## __${dayHeading(iso, zone)}__\n` : '';
    if (day !== null) lastDay = day;
    blocks.push(heading + describe(entry));
  }

  // Naming every participant makes an entry far longer than a count did, so 25
  // bills in a big group can exceed Discord's embed limit. Drop from the oldest
  // end until it fits: sending a short listing beats the API rejecting the lot.
  const rendered: string[] = [];
  let length = 0;
  for (const block of blocks) {
    const added = length === 0 ? block.length : length + 2 + block.length;
    if (added > MAX_DESCRIPTION) {
      // A single entry can exceed the limit by itself if its description is
      // enormous. Truncate rather than reply with an empty embed.
      if (rendered.length === 0) rendered.push(block.slice(0, MAX_DESCRIPTION - 1) + '…');
      break;
    }
    rendered.push(block);
    length = added;
  }
  const dropped = entries.length - rendered.length;

  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setTitle(title)
    .setDescription(rendered.join('\n\n'));

  const first = req.offset + 1;
  const last = req.offset + rendered.length;
  const range = `Showing ${first}-${last}`;
  if (dropped > 0) {
    embed.setFooter({ text: `${range} · ${dropped} more did not fit on this page` });
  } else {
    embed.setFooter({ text: hasMore ? `${range} · more older entries` : range });
  }

  // Anything dropped for length must still be reachable, so the next page starts
  // after what was actually shown rather than after what was fetched.
  return {
    embeds: [embed],
    components: buttonRows(req, { hasMore: hasMore || dropped > 0, shown: rendered.length }),
  };
}

function buttonRows(
  req: PageRequest,
  page: { hasMore: boolean; shown: number },
): ActionRowBuilder<ButtonBuilder>[] {
  const atStart = req.offset === 0;
  // A page that showed nothing must not advance, or the next click would stick.
  const nextOffset = req.offset + Math.max(page.shown, 1);

  // Both buttons are always present so the row does not reflow between pages;
  // the unavailable direction is disabled instead of removed.
  const newer = new ButtonBuilder()
    .setCustomId(encodePageId(req, Math.max(req.offset - req.limit, 0)))
    .setLabel('Newer')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('⬆️')
    .setDisabled(atStart);

  const older = new ButtonBuilder()
    .setCustomId(encodePageId(req, nextOffset))
    .setLabel('Older')
    .setStyle(ButtonStyle.Secondary)
    .setEmoji('⬇️')
    .setDisabled(!page.hasMore);

  // With nothing to page in either direction the buttons are pure clutter.
  if (atStart && !page.hasMore) return [];

  return [new ActionRowBuilder<ButtonBuilder>().addComponents(newer, older)];
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);
  const focus = interaction.options.getUser('user');

  const page = buildPage(
    {
      guildId: guild.id,
      focusId: focus?.id ?? null,
      focusLabel: focus?.displayName ?? null,
      limit: interaction.options.getInteger('count') ?? DEFAULT_COUNT,
      offset: 0,
      showDeleted: interaction.options.getBoolean('show_deleted') ?? false,
    },
    store,
  );

  await interaction.reply(page);
}

/** Handles a click on one of the paging buttons by editing the message in place. */
export async function handleButton(
  interaction: ButtonInteraction,
  store: Store,
): Promise<void> {
  const parsed = parsePageId(interaction.customId);
  if (!parsed) return;

  const guild = requireGuild(interaction);
  const page = buildPage({ ...parsed, guildId: guild.id }, store);

  // Editing rather than replying keeps one message that pages in place, instead
  // of filling the channel with a listing per click.
  await interaction.update(page);
}