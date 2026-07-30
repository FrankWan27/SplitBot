import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { BillEntry, BillSplit, Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { UserError } from '../errors.js';
import { parseDateToIso } from '../dates.js';
import { formatCents, parseAmountToCents, splitEvenly } from '../money.js';
import { parseMentionIds, resolveParticipants } from '../participants.js';

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('edit')
    .setDescription('Change a bill that was already logged')
    .addIntegerOption((o) =>
      o
        .setName('id')
        .setDescription('The id shown next to the entry in /history, e.g. 7')
        .setRequired(true)
        .setMinValue(1),
    )
    .addStringOption((o) =>
      o.setName('amount').setDescription('New total, e.g. 42.50'),
    )
    .addStringOption((o) =>
      o.setName('description').setDescription('New description of what it was for'),
    )
    .addStringOption((o) =>
      o.setName('with').setDescription('Replace who it was split with, e.g. @kaisa @bob'),
    )
    .addUserOption((o) => o.setName('payer').setDescription('Change who paid'))
    .addBooleanOption((o) =>
      o.setName('include_payer').setDescription('Does the payer share the cost too?'),
    )
    .addStringOption((o) =>
      o
        .setName('date')
        .setDescription('Change when it happened: yesterday, 2026-07-20, 7/20, or July 20'),
    ),
);

/**
 * Everyone the bill is split between apart from `payerId`.
 *
 * Keyed on the *new* payer rather than the stored one, so changing who paid keeps
 * the same people in the split: `payer:@bob` on a bill alice paid and bob shared
 * must still be split three ways, not silently drop alice by leaving her out of
 * the list the payer is then prepended to.
 */
function othersOf(entry: BillEntry, payerId: string): string[] {
  return entry.splits.filter((s) => s.userId !== payerId).map((s) => s.userId);
}

/** `a` and `b` hold the same ids, in any order. */
function sameIds(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);
  const id = interaction.options.getInteger('id', true);

  const before = store.entryById(guild.id, id);
  if (!before) {
    throw new UserError(
      `There is no entry \`#${id}\` in this server. ` +
        'Run `/history` to see the ids alongside each entry.',
    );
  }
  if (before.voidedAt) {
    throw new UserError(
      `Entry \`#${id}\` is deleted. Use \`/restore id:${id}\` first if you want to change it.`,
    );
  }
  if (before.kind !== 'bill') {
    // A payment is two people and one amount; there is nothing to edit that
    // deleting and re-recording does not express more clearly.
    throw new UserError(
      `Entry \`#${id}\` is a payment, not a bill. ` +
        `Delete it with \`/delete id:${id}\` and record the corrected one with \`/settle\`.`,
    );
  }

  const amountOption = interaction.options.getString('amount')?.trim();
  const withOption = interaction.options.getString('with')?.trim();
  const dateOption = interaction.options.getString('date')?.trim();
  const descriptionOption = interaction.options.getString('description')?.trim();
  const payerOption = interaction.options.getUser('payer');
  const includePayerOption = interaction.options.getBoolean('include_payer');

  if (
    amountOption === undefined &&
    withOption === undefined &&
    dateOption === undefined &&
    descriptionOption === undefined &&
    payerOption === null &&
    includePayerOption === null
  ) {
    throw new UserError(
      'Name at least one thing to change, for example `amount`, `description`, or `with`.',
    );
  }

  const payer = payerOption ?? { id: before.payerId, bot: false };
  if (payer.bot) {
    throw new UserError('A bot cannot be the payer.');
  }

  const totalCents = amountOption ? parseAmountToCents(amountOption) : before.totalCents;
  const occurredAt = dateOption ? parseDateToIso(dateOption) : before.occurredAt;

  // Defaults to whether the new payer already had a share, which is what makes a
  // change of payer alone leave the split membership exactly as it was.
  const includePayer =
    includePayerOption ?? before.splits.some((s) => s.userId === payer.id);

  // The stable notion is "everyone apart from the payer": it survives a change of
  // payer, and it is what `with` replaces. Payer participation is then a separate
  // flag rather than something to be inferred from the new list.
  const others = withOption ? parseMentionIds(withOption) : othersOf(before, payer.id);
  const participantIds = includePayer ? [payer.id, ...others] : [...others];

  const participants = await resolveParticipants(guild, participantIds);
  if (!includePayer && others.includes(payer.id)) {
    throw new UserError(
      'You set `include_payer` to false but the payer is still in the split. ' +
        'Either drop them from `with` or leave `include_payer` on.',
    );
  }
  if (participants.length === 0) {
    throw new UserError('That would leave nobody in the split.');
  }
  if (participants.length === 1 && participants[0]!.id === payer.id) {
    throw new UserError('That bill would be only you - there is nothing to split.');
  }

  // Re-split only when the split actually changed. Editing a description must not
  // reshuffle who carries the leftover penny, since that would silently move a
  // cent of real debt between two people.
  const newIds = participants.map((p) => p.id);
  const oldIds = before.splits.map((s) => s.userId);
  const resplit = totalCents !== before.totalCents || !sameIds(newIds, oldIds);

  let splits: BillSplit[];
  if (resplit) {
    const shares = splitEvenly(totalCents, participants.length);
    splits = participants.map((p, i) => ({ userId: p.id, shareCents: shares[i]! }));
  } else {
    splits = before.splits;
  }

  const edited = store.editBill({
    guildId: guild.id,
    id,
    editedBy: interaction.user.id,
    editedAt: new Date().toISOString(),
    payerId: payer.id,
    totalCents,
    splits,
    ...(descriptionOption !== undefined ? { description: descriptionOption || null } : {}),
    occurredAt,
  });
  // Only reachable if the entry was deleted between the read above and this write.
  if (!edited) {
    throw new UserError(`Entry \`#${id}\` changed while I was editing it. Try again.`);
  }

  const changes: string[] = [];
  if (totalCents !== before.totalCents) {
    changes.push(`Amount: ${formatCents(before.totalCents)} → **${formatCents(totalCents)}**`);
  }
  if (descriptionOption !== undefined && (descriptionOption || null) !== before.description) {
    changes.push(
      `Description: ${before.description ?? 'none'} → **${descriptionOption || 'none'}**`,
    );
  }
  if (payer.id !== before.payerId) {
    changes.push(`Paid by: <@${before.payerId}> → **<@${payer.id}>**`);
  }
  if (!sameIds(newIds, oldIds)) {
    changes.push(`Split between: ${oldIds.length} → **${newIds.length} people**`);
  }
  if (occurredAt !== before.occurredAt) {
    const shown = occurredAt
      ? `<t:${Math.floor(Date.parse(occurredAt) / 1000)}:D>`
      : 'when it was logged';
    changes.push(`Date: **${shown}**`);
  }

  const owedLines = splits
    .filter((s) => s.userId !== payer.id)
    .map((s) => `<@${s.userId}> owes ${formatCents(s.shareCents)}`);

  const embed = new EmbedBuilder()
    .setColor(0xd9a13b)
    .setTitle(`✏️ Edited #${id}`)
    .setDescription(
      changes.length > 0
        ? changes.join('\n')
        : 'Nothing actually changed - the new values match what was already stored.',
    )
    .addFields({
      name: 'Who owes what now',
      value: owedLines.length > 0 ? owedLines.join('\n') : 'Nobody owes anything on this bill.',
    });

  await interaction.reply({ embeds: [embed] });
}
