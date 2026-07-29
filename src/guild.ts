import { InteractionContextType, ApplicationIntegrationType, type Guild } from 'discord.js';
import type { SlashCommandOptionsOnlyBuilder } from 'discord.js';
import { UserError } from './errors.js';

/**
 * Restrict a command to servers the bot is actually a member of.
 *
 * Without this, Discord offers the command in DMs and - if the app is installed
 * to a user account - in servers the bot was never invited to. A shared ledger
 * makes no sense in either place, so they are refused up front by Discord rather
 * than by a runtime check the user has to decipher.
 */
export function guildOnly(
  builder: SlashCommandOptionsOnlyBuilder,
): SlashCommandOptionsOnlyBuilder {
  return builder
    .setContexts(InteractionContextType.Guild)
    .setIntegrationTypes(ApplicationIntegrationType.GuildInstall);
}

/**
 * Get the guild a command was invoked in, or explain precisely why we cannot.
 *
 * `interaction.guild` is null in two different situations that need different
 * fixes, so they get different messages:
 *   - no guild id at all: the command ran in a DM or group chat
 *   - a guild id we cannot resolve: the app is installed to the user's account
 *     but the bot is not a member of that server, so it cannot read the member
 *     list or keep a ledger there
 *
 * Accepts anything carrying the two fields, so button clicks share the same check
 * as slash commands.
 */
export function requireGuild(interaction: {
  guild: Guild | null;
  guildId: string | null;
}): Guild {
  if (interaction.guild) return interaction.guild;

  if (interaction.guildId) {
    throw new UserError(
      'I am not a member of this server, so I cannot track balances here.\n' +
        'Ask an admin to invite me properly: Developer Portal -> OAuth2 -> URL Generator, ' +
        'tick both `bot` and `applications.commands`, then open the generated link and pick this server.',
    );
  }

  throw new UserError(
    'Bills are shared between people in a server, so this only works in a server channel, not in a DM.',
  );
}
