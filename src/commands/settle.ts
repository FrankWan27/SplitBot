import {
  SlashCommandBuilder,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { UserError } from '../errors.js';
import { formatCents, parseAmountToCents } from '../money.js';
import { visibility } from '../visibility.js';

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('settle')
    .setDescription('Record a payment from one person to another')
    .addUserOption((o) =>
      o.setName('to').setDescription('Who is being paid').setRequired(true),
    )
    .addStringOption((o) =>
      o
        .setName('amount')
        .setDescription('How much was paid; omit to settle the full balance')
        .setRequired(false),
    )
    .addUserOption((o) =>
      o.setName('from').setDescription('Who paid (defaults to you)'),
    ),
);

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);

  const to = interaction.options.getUser('to', true);
  const from = interaction.options.getUser('from') ?? interaction.user;
  const amountRaw = interaction.options.getString('amount');

  if (from.id === to.id) {
    throw new UserError('A person cannot pay themselves.');
  }
  if (from.bot || to.bot) {
    throw new UserError('Bots cannot owe or be owed money.');
  }

  const owed = store.owedBetween(guild.id, from.id, to.id);

  // With no amount given, settle exactly what is outstanding. This is the common
  // case and saves the user from retyping a figure the bot already knows.
  let cents: number;
  if (amountRaw === null) {
    if (owed <= 0) {
      const message =
        owed === 0
          ? `<@${from.id}> does not owe <@${to.id}> anything.`
          : `<@${from.id}> does not owe <@${to.id}> anything - in fact <@${to.id}> ` +
            `owes <@${from.id}> ${formatCents(-owed)}. ` +
            `Did you mean \`/settle from:@${to.username} to:@${from.username}\`?`;
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
      return;
    }
    cents = owed;
  } else {
    cents = parseAmountToCents(amountRaw);
  }

  const { afterCents } = store.recordPayment({
    guildId: guild.id,
    fromId: from.id,
    toId: to.id,
    cents,
    createdBy: interaction.user.id,
    createdAt: new Date().toISOString(),
  });

  const embed = new EmbedBuilder()
    .setColor(0x4f9d69)
    .setTitle('✅ Payment settled')
    .setDescription(`<@${from.id}> paid <@${to.id}> **${formatCents(cents)}**.`);

  // Report the resulting state plainly, including the awkward cases: paying more
  // than was owed flips the debt, and that should be visible rather than hidden.
  if (afterCents === 0) {
    embed.addFields({ name: 'Now', value: 'Settled up' });
  } else if (afterCents > 0) {
    embed.addFields({
      name: 'Remaining',
      value: `<@${from.id}> still owes <@${to.id}> ${formatCents(afterCents)}.`,
    });
  } else {
    embed
      .setColor(0xd98e04)
      .addFields({
        name: 'Heads up - overpaid',
        value:
          `That was more than was owed. <@${to.id}> now owes <@${from.id}> ` +
          `${formatCents(-afterCents)}.`,
      });
  }

  await interaction.reply({ ...visibility(interaction), embeds: [embed] });
}
