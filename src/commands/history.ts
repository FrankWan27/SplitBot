import {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BillEntry, LedgerEntry, Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { formatCents } from '../money.js';

const DEFAULT_COUNT = 10;
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
    ),
);

/** Renders a Discord relative timestamp, which localises itself per viewer. */
function timestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

/** Names everyone a bill was split with, minus the payer named on the line above. */
function splitWith(entry: BillEntry): string | null {
  const others = entry.splits.filter((s) => s.userId !== entry.payerId);
  if (others.length === 0) return null;

  const shown = others.slice(0, MAX_NAMES).map((s) => `<@${s.userId}>`);
  const hidden = others.length - shown.length;
  return `split with ${shown.join(', ')}${hidden > 0 ? ` and ${hidden} more` : ''}`;
}

function describe(entry: LedgerEntry): string {
  const when = timestamp(entry.createdAt);
  const suffix = when ? ` · ${when}` : '';

  if (entry.kind === 'payment') {
    return `**${formatCents(entry.cents)}**\n` + `<@${entry.fromId}> paid <@${entry.toId}>${suffix}`;
  }

  // The `createdBy` note only appears when someone logged a bill on another
  // person's behalf, since that is the case worth being able to audit later.
  const loggedBy = entry.createdBy !== entry.payerId ? ` · logged by <@${entry.createdBy}>` : '';

  const lines = [
    `**${formatCents(entry.totalCents)}** - ${entry.description ?? '_no description_'}`,
    `paid by <@${entry.payerId}>${suffix}${loggedBy}`,
  ];
  const others = splitWith(entry);
  if (others) lines.push(others);

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
  });

  const title = req.focusLabel ? `History for ${req.focusLabel}` : 'Recent history';

  if (entries.length === 0) {
    // Reachable on the first page of an empty ledger, and also by paging to an
    // offset whose entries were removed in between clicks.
    const empty = new EmbedBuilder().setColor(0x5865f2);
    if (req.offset > 0) {
      empty.setTitle(title).setDescription('No more entries. Page back to see earlier ones.');
    } else {
      empty
        .setTitle('Nothing logged yet')
        .setDescription(
          req.focusId
            ? `No bills or payments involving <@${req.focusId}> yet.`
            : 'No bills or payments have been logged in this server yet. Start with `/bill`.',
        );
    }
    return { embeds: [empty], components: buttonRows(req, { hasMore: false, shown: 0 }) };
  }

  // Naming every participant makes a line far longer than a count did, so 25
  // bills in a big group can exceed Discord's embed limit. Drop from the oldest
  // end until it fits: sending a short listing beats the API rejecting the lot.
  const rendered: string[] = [];
  let length = 0;
  for (const entry of entries) {
    const line = describe(entry);
    const added = length === 0 ? line.length : length + 2 + line.length;
    if (added > MAX_DESCRIPTION) {
      // A single entry can exceed the limit by itself if its description is
      // enormous. Truncate rather than reply with an empty embed.
      if (rendered.length === 0) rendered.push(line.slice(0, MAX_DESCRIPTION - 1) + '…');
      break;
    }
    rendered.push(line);
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
