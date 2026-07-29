import { REST, Routes } from 'discord.js';
import { loadConfigOrExit } from './config.js';
import { commands } from './commands/index.js';

/**
 * Registers slash commands with Discord. Run this once after changing any command
 * definition - the running bot does not register them itself.
 *
 * With DISCORD_GUILD_ID set, commands register to that one server and appear
 * immediately, which is what you want while developing. Without it they register
 * globally and can take up to an hour to propagate.
 */
const config = loadConfigOrExit();
const rest = new REST().setToken(config.token);
const body = commands.map((c) => c.data.toJSON());

const route = config.guildId
  ? Routes.applicationGuildCommands(config.clientId, config.guildId)
  : Routes.applicationCommands(config.clientId);

try {
  const data = (await rest.put(route, { body })) as unknown[];
  console.log(
    `Registered ${data.length} command(s) ${
      config.guildId ? `to guild ${config.guildId}` : 'globally (may take up to an hour to appear)'
    }.`,
  );
} catch (err) {
  // The three realistic failures here are a bad token, a client id that is not
  // the application id, and a guild the bot has not been invited to. Each has a
  // specific fix, so they are named rather than dumped as a stack trace.
  const status = (err as { status?: number }).status;
  if (status === 401) {
    console.error(
      'Discord rejected the token (401).\n' +
        '  Check DISCORD_TOKEN against Developer Portal -> your app -> Bot -> Reset Token.',
    );
  } else if (status === 403 && config.guildId) {
    console.error(
      `Not allowed to add commands to guild ${config.guildId} (403).\n` +
        '  Invite the bot to that server with the applications.commands scope first.',
    );
  } else if (status === 404) {
    console.error(
      'Discord could not find that application or guild (404).\n' +
        '  DISCORD_CLIENT_ID must be the Application ID, and DISCORD_GUILD_ID a server the bot is in.',
    );
  } else {
    console.error('Failed to register commands:', err);
  }
  process.exit(1);
}
