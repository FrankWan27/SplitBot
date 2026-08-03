import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { LedgerEntry, Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { UserError } from '../errors.js';
import { summarise } from './delete.js';
import { ID_OPTION_NAME, IDS_OPTION_NAME, readEntryIds } from '../entryIds.js';
import { visibility, voiceOf } from '../visibility.js';
import type { Voice } from '../voice.js';

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Bring back a deleted entry, re-applying its balances')
    .addIntegerOption((o) =>
      o
        .setName(ID_OPTION_NAME)
        .setDescription('The id of the deleted entry, e.g. 7')
        .setMinValue(1),
    )
    .addStringOption((o) =>
      o
        .setName(IDS_OPTION_NAME)
        .setDescription('Several ids to restore together, comma separated, e.g. 7,9'),
    ),
);

/** A summary line per entry, labelled with its id once there is more than one. */
function summariseAll(entries: LedgerEntry[], voice: Voice): string {
  if (entries.length === 1) return summarise(entries[0]!, voice);
  return entries.map((e) => `\`#${e.id}\` ${summarise(e, voice)}`).join('\n');
}

/**
 * Explains why an id could not be restored. A live entry and a nonexistent one
 * are different mistakes: one means nothing needed doing, the other means the id
 * was wrong.
 */
function rejectUnusable(store: Store, guildId: string, id: number, batched: boolean): never {
  const nothingElse = batched
    ? ' Nothing was restored - fix that id and run it again to restore them together.'
    : '';
  if (store.entryById(guildId, id)) {
    throw new UserError(
      `Entry \`#${id}\` is not deleted, so there is nothing to restore.` + nothingElse,
    );
  }
  throw new UserError(
    `There is no entry \`#${id}\` in this server. ` +
      'Run `/history show_deleted:true` to see deleted entries and their ids.' +
      nothingElse,
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);
  const ids = readEntryIds(interaction.options);

  const result = store.restoreEntries({ guildId: guild.id, ids });
  if (!result.ok) rejectUnusable(store, guild.id, result.failedId, ids.length > 1);

  const { entries } = result;
  const one = entries.length === 1;

  const embed = new EmbedBuilder()
    .setColor(0x4f9d69)
    .setTitle(one ? `♻️ Restored #${entries[0]!.id}` : `♻️ Restored ${entries.length} entries`)
    .setDescription(
      `${summariseAll(entries, voiceOf(interaction))}\n\n${
        one ? 'Its' : 'Their'
      } balances are back in effect.`,
    );

  await interaction.reply({ ...visibility(interaction), embeds: [embed] });
}
