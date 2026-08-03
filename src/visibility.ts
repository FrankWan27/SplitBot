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
import { CHANNEL, addressing, type Voice } from './voice.js';

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
 * the name and the meaning cannot drift apart - a flag that meant subtly different
 * things depending on which command carried it would be worse than not having one.
 *
 * `defaultPrivate` is a command's own answer to "who is this reply for by default",
 * which is not the same for all of them: a `/bill` is a shared fact and belongs in
 * the channel, while `/balances` is about one person and is nobody else's business
 * unless they say so. It is stated in the description too, since an option whose
 * default a user cannot see is one they have to test to understand.
 *
 * It is added last, after every option the command declares itself, because
 * Discord requires optional options to follow required ones.
 */
export function withPrivateOption(
  builder: SlashCommandOptionsOnlyBuilder,
  defaultPrivate = false,
): SlashCommandOptionsOnlyBuilder {
  return builder.addBooleanOption((o) =>
    o
      .setName(OPTION_NAME)
      .setDescription(
        defaultPrivate
          ? 'Show the reply only to you, not the channel (default: yes)'
          : 'Show the reply only to you, not the channel (default: no)',
      ),
  );
}

/**
 * Whether this interaction's reply should be kept to the caller.
 *
 * An unanswered flag falls back to the command's own default rather than to a
 * single global one, since what a reply is for differs by command.
 */
export function isPrivate(
  interaction: ChatInputCommandInteraction,
  defaultPrivate = false,
): boolean {
  return interaction.options.getBoolean(OPTION_NAME) ?? defaultPrivate;
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
  defaultPrivate = false,
): { flags?: MessageFlags.Ephemeral } {
  return isPrivate(interaction, defaultPrivate) ? { flags: MessageFlags.Ephemeral } : {};
}

/**
 * How a reply should refer to people, given who will be able to read it.
 *
 * Derived from the visibility rather than passed separately, so the two cannot
 * disagree: a reply saying "you" to a channel would be addressing whoever happened
 * to read it, and a private reply naming its only reader in the third person is
 * just stilted. Both follow from one flag, so both are decided in one place.
 */
export function voiceOf(
  interaction: ChatInputCommandInteraction,
  defaultPrivate = false,
): Voice {
  return isPrivate(interaction, defaultPrivate)
    ? addressing(interaction.user.id)
    : CHANNEL;
}
