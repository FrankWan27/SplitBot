import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { LedgerEntry, Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { UserError } from '../errors.js';
import { formatCents } from '../money.js';

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Delete a bill or payment, undoing its effect on balances')
    .addIntegerOption((o) =>
      o
        .setName('id')
        .setDescription('The id shown next to the entry in /history, e.g. 7')
        .setRequired(true)
        .setMinValue(1),
    ),
);

/** One line summarising what an entry was, for a confirmation message. */
export function summarise(entry: LedgerEntry): string {
  if (entry.kind === 'payment') {
    return `**${formatCents(entry.cents)}** from <@${entry.fromId}> to <@${entry.toId}>`;
  }
  const what = entry.description ?? 'no description';
  return `**${formatCents(entry.totalCents)} - ${what}**, paid by <@${entry.payerId}>`;
}

/**
 * Explains why an id could not be deleted.
 *
 * "Already deleted" and "no such entry" are separated deliberately: the first
 * means the job is done, the second means the id was wrong and retyping it is
 * worth doing.
 */
function rejectMissing(store: Store, guildId: string, id: number): never {
  const existing = store.entryById(guildId, id);
  if (existing?.voidedAt) {
    throw new UserError(
      `Entry \`#${id}\` was already deleted. ` +
        'Use `/restore id:' +
        id +
        '` to bring it back.',
    );
  }
  throw new UserError(
    `There is no entry \`#${id}\` in this server. ` +
      'Run `/history` to see the ids alongside each entry.',
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);
  const id = interaction.options.getInteger('id', true);

  const deleted = store.voidEntry({
    guildId: guild.id,
    id,
    voidedBy: interaction.user.id,
    voidedAt: new Date().toISOString(),
  });
  if (!deleted) rejectMissing(store, guild.id, id);

  const embed = new EmbedBuilder()
    .setColor(0xb4453c)
    .setTitle(`Deleted #${id}`)
    .setDescription(
      `${summarise(deleted)}\n\nBalances have been adjusted as though it never happened. ` +
        `It is kept in the log, so \`/restore id:${id}\` undoes this.`,
    );

  await interaction.reply({ embeds: [embed] });
}
