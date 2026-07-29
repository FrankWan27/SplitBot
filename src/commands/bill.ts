import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { UserError } from '../errors.js';
import { formatCents, parseAmountToCents, splitEvenly } from '../money.js';
import { parseMentionIds, resolveParticipants } from '../participants.js';

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('bill')
    .setDescription('Log a bill and split it evenly between people')
    .addStringOption((o) =>
      o
        .setName('amount')
        .setDescription('Total amount of the bill, e.g. 42.50')
        .setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName('with')
        .setDescription('Mention everyone splitting this, e.g. @alice @bob')
        .setRequired(true),
    )
    // Required: Discord will not accept a blank or whitespace-only value for a
    // required option, so every bill logged through the picker has a real one.
    .addStringOption((o) =>
      o
        .setName('description')
        .setDescription('What was it for? e.g. Pulled a guy from a blind box')
        .setRequired(true),
    )
    .addUserOption((o) =>
      o
        .setName('payer')
        .setDescription('Who actually paid (defaults to you)'),
    )
    .addBooleanOption((o) =>
      o
        .setName('include_payer')
        .setDescription('Does the payer share the cost too? (default: yes)'),
    ),
);

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);

  const totalCents = parseAmountToCents(interaction.options.getString('amount', true));
  // Discord enforces a non-blank value on a required option, so this normally
  // just trims. The null fallback stays because /history must render entries
  // written before the option was required, and a blank line reads as a bug.
  const description = interaction.options.getString('description')?.trim() || null;
  const payerOption = interaction.options.getUser('payer');
  const includePayer = interaction.options.getBoolean('include_payer') ?? true;

  const payer = payerOption ?? interaction.user;
  if (payer.bot) {
    throw new UserError('A bot cannot be the payer.');
  }

  const mentionedIds = parseMentionIds(interaction.options.getString('with', true));

  // The payer is a participant unless explicitly excluded. Listing the payer
  // first keeps the leftover-penny assignment deterministic for a given bill.
  const participantIds = includePayer ? [payer.id, ...mentionedIds] : [...mentionedIds];
  const participants = await resolveParticipants(guild, participantIds);

  if (!includePayer && participants.some((p) => p.id === payer.id)) {
    throw new UserError(
      'You set `include_payer` to false but also mentioned the payer in `with`. ' +
        'Either drop them from `with` or leave `include_payer` on.',
    );
  }
  if (participants.length === 1 && participants[0]!.id === payer.id) {
    throw new UserError('That bill is only you - there is nothing to split.');
  }

  // Leftover pennies land on randomly chosen participants, so no single person
  // is systematically the one rounded up.
  const shares = splitEvenly(totalCents, participants.length);
  const splits = participants.map((p, i) => ({ userId: p.id, shareCents: shares[i]! }));

  store.recordBill({
    guildId: guild.id,
    payerId: payer.id,
    totalCents,
    splits,
    description,
    createdBy: interaction.user.id,
    createdAt: new Date().toISOString(),
  });

  const owedLines = splits
    .filter((s) => s.userId !== payer.id)
    .map((s) => `<@${s.userId}> owes ${formatCents(s.shareCents)}`);

  // Shares differing by a penny looks like a rounding bug unless the reply says
  // it was chance. Named explicitly, since the person paying an extra cent is the
  // one most likely to ask why.
  const uneven = new Set(shares).size > 1;
  const unlucky = splits
    .filter((s) => s.shareCents > Math.min(...shares))
    .map((s) => `<@${s.userId}>`);
  const pennyNote = uneven
    ? ` It does not divide evenly, so the spare ${
        unlucky.length === 1 ? 'penny went' : 'pennies went'
      } to ${unlucky.join(', ')} at random.`
    : '';

  const embed = new EmbedBuilder()
    .setColor(0x4f9d69)
    .setTitle(description ? `Bill: ${description}` : 'Bill logged')
    .setDescription(
      `**${formatCents(totalCents)}** paid by <@${payer.id}>, split ${
        participants.length
      } way${participants.length === 1 ? '' : 's'}.${pennyNote}`,
    )
    .addFields({ name: 'Who owes what', value: owedLines.join('\n') });

  await interaction.reply({ embeds: [embed] });
}
