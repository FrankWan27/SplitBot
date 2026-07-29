import 'dotenv/config';

/**
 * Thrown when the environment is not set up. Callers print the message and exit
 * rather than letting a stack trace be the first thing a new user sees.
 */
export class ConfigError extends Error {}

function required(name: string, hint: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigError(`${name} is not set.\n  Find it at: ${hint}`);
  }
  return value.trim();
}

export function loadConfig() {
  return {
    token: required('DISCORD_TOKEN', 'Developer Portal -> your app -> Bot -> Reset Token'),
    clientId: required(
      'DISCORD_CLIENT_ID',
      'Developer Portal -> your app -> General Information -> Application ID',
    ),
    /** Optional: register commands to one guild for instant availability while developing. */
    guildId: process.env.DISCORD_GUILD_ID?.trim() || undefined,
    databasePath: process.env.DATABASE_PATH?.trim() || './data/splits.db',
  };
}

export type Config = ReturnType<typeof loadConfig>;

/**
 * Load configuration or exit with a readable message. Used by the entry points,
 * where a missing token is a setup mistake rather than an exception to handle.
 */
export function loadConfigOrExit(): Config {
  try {
    return loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`Configuration problem:\n\n  ${err.message}\n`);
      console.error('Copy .env.example to .env and fill in the missing values.\n');
      process.exit(1);
    }
    throw err;
  }
}
