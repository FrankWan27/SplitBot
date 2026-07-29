import {
  SlashCommandBuilder,
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
 * listing of 25 bills past Discord's message limit on its own.
 */
const MAX_NAMES = 8;

/**
 * Discord rejects a message whose content exceeds this.
 *
 * The listing is sent as message content rather than as an embed because `-#`
 * subtext and `##` headings are only rendered in content - inside an embed the
 * subtext line comes out the same size as everything else, which defeats the
 * point of separating provenance from the amount. The cost is this 2000-character
 * budget in place of an embed's 4096, so a full page of 25 bills in a large group
 * now trims sooner.
 */
const MAX_CONTENT = 2000;

/**
 * Nothing in a history listing should notify anyone. It is full of mentions by
 * design, and in message content - unlike in an embed - a mention pings unless
 * suppressed. Paging would otherwise re-notify everyone on every click.
 */
const NO_PINGS = { parse: [] as const };

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
    return `_${who} borrowed ${formatCents(shareCents)}._`;
  });
}

function describe(entry: LedgerEntry): string {
  // Backdated bills report when they happened, not when they were typed, which
  // is also the order the listing is sorted in.
  const when = timestamp(entryWhen(entry));

  if (entry.kind === 'payment') {
    return [
      ` **${formatCents(entry.cents)}**`,
      `<@${entry.fromId}> paid <@${entry.toId}>.`,
      `-# ${when}`,
    ].join('\n');
  }

  // Counts everyone the bill was divided between, including the payer when they
  // took a share, which is what makes the per-person figure below add up.
  const people = entry.splits.length;
  const lines = [
    ` **${formatCents(entry.totalCents)} - ${entry.description ?? 'no description'}**`,
    `Paid by <@${entry.payerId}> for ${people} ${people === 1 ? 'person' : 'people'}.`,
    ...borrowedLines(entry),
  ];

  // Subtext, so the provenance is available without competing with the amount.
  // Always shown: it is the audit trail, and at this size it costs a glance.
  lines.push(`-# ${when} - Logged by <@${entry.createdBy}>`);
  return lines.join('\n');
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
}

/**
 * Paging state is encoded in the button's own custom id rather than held in
 * memory, so buttons keep working across a bot restart and nothing has to be
 * expired. Format: `history:<offset>:<limit>:<focusId or ->:<focusLabel>`.
 */
const CUSTOM_ID_PREFIX = 'history';

/** Discord rejects a custom id longer than this. */
const MAX_CUSTOM_ID = 100;

export function encodePageId(req: PageRequest, offset: number): string {
  const head = `${CUSTOM_ID_PREFIX}:${offset}:${req.limit}:${req.focusId ?? '-'}:`;
  // A display name can contain a colon, so the label goes last and is parsed as
  // "everything after the fourth colon". Truncated to fit Discord's id limit.
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
  const label = parts.slice(4).join(':');
  return {
    guildId: '',
    focusId,
    focusLabel: label === '' ? null : label,
    limit,
    offset,
  };
}

/** One page of history, ready to be sent or to replace an existing message. */
interface Page {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: typeof NO_PINGS;
}

function buildPage(req: PageRequest, store: Store): Page {
  const { entries, hasMore } = store.recentEntries({
    guildId: req.guildId,
    userId: req.focusId ?? undefined,
    limit: req.limit,
    offset: req.offset,
  });

  const title = req.focusLabel ? `History for ${req.focusLabel}` : 'Recent history';

  if (entries.length === 0) {
    // Reachable on the first page of an empty ledger, and also by paging to an
    // offset whose entries were removed in between clicks.
    const empty =
      req.offset > 0
        ? `**${title}**\nNo more entries. Page back to see earlier ones.`
        : req.focusId
          ? `**Nothing logged yet**\nNo bills or payments involving <@${req.focusId}> yet.`
          : '**Nothing logged yet**\nNo bills or payments have been logged in this server yet. ' +
            'Start with `/bill`.';
    return {
      content: empty,
      components: buttonRows(req, { hasMore: false, shown: 0 }),
      allowedMentions: NO_PINGS,
    };
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
    const heading = day !== null && day !== lastDay ? `## ${dayHeading(iso, zone)}\n` : '';
    if (day !== null) lastDay = day;
    blocks.push(heading + describe(entry));
  }

  // The heading and the footer share the message's character budget with the
  // entries, so they are measured rather than assumed to fit.
  const header = `**${title}**`;
  const first = req.offset + 1;

  // Naming every participant makes an entry far longer than a count did, so 25
  // bills in a big group can exceed Discord's message limit. Drop from the oldest
  // end until it fits: sending a short listing beats the API rejecting the lot.
  // The footer's own length is reserved up front, since it grows when entries are
  // dropped and must not be what pushes the message over.
  // Reserved against the longest footer this page could produce: the
  // "did not fit" variant, with the largest offsets and drop count in play.
  const longestFooter = footer(first, first + req.limit, true, true, req.limit).length;
  const budget = MAX_CONTENT - header.length - longestFooter - 2;
  const rendered: string[] = [];
  let length = 0;
  for (const block of blocks) {
    const added = length === 0 ? block.length : length + 2 + block.length;
    if (added > budget) {
      // A single entry can exceed the budget by itself if its description is
      // enormous. Truncate rather than reply with nothing at all.
      if (rendered.length === 0) rendered.push(block.slice(0, Math.max(budget - 1, 0)) + '…');
      break;
    }
    rendered.push(block);
    length = added;
  }
  const dropped = entries.length - rendered.length;

  const content = [
    header,
    rendered.join('\n\n'),
    footer(first, req.offset + rendered.length, hasMore, dropped > 0, dropped),
  ].join('\n');

  // Anything dropped for length must still be reachable, so the next page starts
  // after what was actually shown rather than after what was fetched.
  return {
    content,
    components: buttonRows(req, { hasMore: hasMore || dropped > 0, shown: rendered.length }),
    allowedMentions: NO_PINGS,
  };
}

/** The range line closing a page, as subtext so it does not compete with entries. */
function footer(
  first: number,
  last: number,
  hasMore: boolean,
  anyDropped: boolean,
  dropped = 0,
): string {
  const range = `Showing ${first}-${last}`;
  if (anyDropped) return `-# ${range} · ${dropped} more did not fit on this page`;
  return `-# ${hasMore ? `${range} · more older entries` : range}`;
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
