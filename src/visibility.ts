/**
 * Whether a reply goes to the channel or only to the person who ran the command.
 *
 * Discord's mechanism for the latter is an "ephemeral" message: it is delivered to
 * the invoking user alone, cannot be seen by anyone else in the channel, and
 * disappears when they dismiss it or restart their client. The bot already uses it
 * for error messages, which nobody else needs to read.
 */

import {
  MessageFlags,
  type ChatInputCommandInteraction,
  type SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

/**
 * The name is `private` rather than `silent` because Discord already means
 * something else by silent: an `@silent` message is one that suppresses
 * notifications while staying visible to everyone. This flag changes who can see
 * the reply, not who gets pinged about it.
 */
const OPTION_NAME = 'private';

/**
 * Add the `private` flag to a command.
 *
 * Applied from one place over every command rather than written out in each, so
 * the name, the description and the default cannot drift apart - a flag that
 * meant subtly different things depending on which command carried it would be
 * worse than not having one.
 *
 * It is added last, after every option the command declares itself, because
 * Discord requires optional options to follow required ones.
 */
export function withPrivateOption(
  builder: SlashCommandOptionsOnlyBuilder,
): SlashCommandOptionsOnlyBuilder {
  return builder.addBooleanOption((o) =>
    o
      .setName(OPTION_NAME)
      .setDescription('Show the reply only to you, not the channel (default: no)'),
  );
}

/**
 * Reply options carrying the visibility the user asked for, to be spread into the
 * payload passed to `reply`.
 *
 * Returns an empty object rather than an explicit "public" flag, since Discord has
 * no such flag: a reply is public unless marked ephemeral.
 */
export function visibility(
  interaction: ChatInputCommandInteraction,
): { flags?: MessageFlags.Ephemeral } {
  return interaction.options.getBoolean(OPTION_NAME) === true
    ? { flags: MessageFlags.Ephemeral }
    : {};
}
