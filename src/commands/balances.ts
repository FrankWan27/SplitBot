import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { PairBalance, Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { formatCents } from '../money.js';

/** Discord rejects embed descriptions over 4096 characters. */
const MAX_LINES = 40;

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('balances')
    .setDescription('Show who owes who')
    .addUserOption((o) =>
      o.setName('user').setDescription('Only show debts involving this person'),
    ),
);

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
  const balances = focus
    ? store.balancesFor(guild.id, focus.id)
    : store.allBalances(guild.id);

  if (balances.length === 0) {
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setColor(0x4f9d69)
          .setTitle('All settled up')
          .setDescription(
            focus
              ? `<@${focus.id}> does not owe anyone and is not owed anything.`
              : 'Nobody in this server owes anybody.',
          ),
      ],
    });
    return;
  }

  const shown = balances.slice(0, MAX_LINES);
  const lines = shown.map(
    (b) => `<@${b.debtor}> → <@${b.creditor}>  **${formatCents(b.cents)}**`,
  );
  if (balances.length > shown.length) {
    lines.push(`_...and ${balances.length - shown.length} more._`);
  }

  const embed = new EmbedBuilder()
    .setColor(0xd98e04)
    .setTitle(focus ? `Balances for ${focus.displayName}` : 'Outstanding balances')
    .setDescription(lines.join('\n'));

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
  } else {
    const total = balances.reduce((sum, b) => sum + b.cents, 0);
    embed.setFooter({
      text: `${balances.length} outstanding debt${
        balances.length === 1 ? '' : 's'
      }, ${formatCents(total)} total unsettled.`,
    });
  }

  await interaction.reply({ embeds: [embed] });
}
