import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { UserError } from '../errors.js';
import { summarise } from './delete.js';

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Bring back a deleted entry, re-applying its balances')
    .addIntegerOption((o) =>
      o
        .setName('id')
        .setDescription('The id of the deleted entry, e.g. 7')
        .setRequired(true)
        .setMinValue(1),
    ),
);

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);
  const id = interaction.options.getInteger('id', true);

  const restored = store.restoreEntry({ guildId: guild.id, id });
  if (!restored) {
    // A live entry and a nonexistent one are different mistakes: one means
    // nothing needed doing, the other means the id was wrong.
    const existing = store.entryById(guild.id, id);
    if (existing) {
      throw new UserError(`Entry \`#${id}\` is not deleted, so there is nothing to restore.`);
    }
    throw new UserError(
      `There is no entry \`#${id}\` in this server. ` +
        'Run `/history show_deleted:true` to see deleted entries and their ids.',
    );
  }

  const embed = new EmbedBuilder()
    .setColor(0x4f9d69)
    .setTitle(`♻️ Restored #${id}`)
    .setDescription(`${summarise(restored)}\n\nIts balances are back in effect.`);

  await interaction.reply({ embeds: [embed] });
}
