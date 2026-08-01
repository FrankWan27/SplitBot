import {
  SlashCommandBuilder,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';
import type { LedgerEntry, Store } from '../db.js';
import { guildOnly, requireGuild } from '../guild.js';
import { UserError } from '../errors.js';
import { formatCents } from '../money.js';
import { visibility } from '../visibility.js';
import {
  ID_OPTION_NAME,
  IDS_OPTION_NAME,
  idOption,
  readEntryIds,
} from '../entryIds.js';

export const data = guildOnly(
  new SlashCommandBuilder()
    .setName('delete')
    .setDescription('Delete a bill or payment, undoing its effect on balances')
    .addIntegerOption((o) =>
      o
        .setName(ID_OPTION_NAME)
        .setDescription('The id shown next to the entry in /history, e.g. 7')
        .setMinValue(1),
    )
    .addStringOption((o) =>
      o
        .setName(IDS_OPTION_NAME)
        .setDescription('Several ids to delete together, comma separated, e.g. 7,9'),
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
 * A summary line per entry, each labelled with its id.
 *
 * Deleting several at once has to say which entry each line was, since `#7` and
 * `#9` are indistinguishable once they are gone from `/history`. A single delete
 * has its id in the title already, so repeating it here would be noise.
 */
function summariseAll(entries: LedgerEntry[]): string {
  if (entries.length === 1) return summarise(entries[0]!);
  return entries.map((e) => `\`#${e.id}\` ${summarise(e)}`).join('\n');
}

/**
 * Explains why an id could not be deleted.
 *
 * "Already deleted" and "no such entry" are separated deliberately: the first
 * means the job is done, the second means the id was wrong and retyping it is
 * worth doing.
 *
 * `batched` says whether other ids were named alongside this one, which decides
 * whether the message has to point out that nothing was deleted. On a single
 * delete that is obvious; in a batch it is the thing the user most needs to know.
 */
function rejectUnusable(store: Store, guildId: string, id: number, batched: boolean): never {
  const nothingElse = batched
    ? ' Nothing was deleted - fix that id and run it again to delete them together.'
    : '';
  const existing = store.entryById(guildId, id);
  if (existing?.voidedAt) {
    throw new UserError(
      `Entry \`#${id}\` was already deleted. ` +
        `Use \`/restore ${ID_OPTION_NAME}:${id}\` to bring it back.` +
        nothingElse,
    );
  }
  throw new UserError(
    `There is no entry \`#${id}\` in this server. ` +
      'Run `/history` to see the ids alongside each entry.' +
      nothingElse,
  );
}

export async function execute(
  interaction: ChatInputCommandInteraction,
  store: Store,
): Promise<void> {
  const guild = requireGuild(interaction);
  const ids = readEntryIds(interaction.options);

  const result = store.voidEntries({
    guildId: guild.id,
    ids,
    voidedBy: interaction.user.id,
    voidedAt: new Date().toISOString(),
  });
  if (!result.ok) rejectUnusable(store, guild.id, result.failedId, ids.length > 1);

  const { entries } = result;
  const one = entries.length === 1;
  // The undo hint has to name the option the ids will fit in, which is not
  // necessarily the one they arrived in: `ids:` is the only one that takes a list.
  const undo = one
    ? `/restore ${ID_OPTION_NAME}:${entries[0]!.id}`
    : `/restore ${IDS_OPTION_NAME}:${idOption(ids)}`;

  const embed = new EmbedBuilder()
    .setColor(0xb4453c)
    .setTitle(one ? `🗑️ Deleted #${entries[0]!.id}` : `🗑️ Deleted ${entries.length} entries`)
    .setDescription(
      `${summariseAll(entries)}\n\nBalances have been adjusted as though ${
        one ? 'it' : 'they'
      } never happened. ${one ? 'It is' : 'They are'} kept in the log, so \`${undo}\` undoes this.`,
    );

  await interaction.reply({ ...visibility(interaction), embeds: [embed] });
}
