import {
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  type RepliableInteraction,
} from 'discord.js';
import { loadConfigOrExit } from './config.js';
import { Store } from './db.js';
import { buttonHandlerFor, commandsByName } from './commands/index.js';
import { UserError } from './errors.js';

const config = loadConfigOrExit();
const store = new Store(config.databasePath);

// Guilds is the only intent needed: slash commands arrive as interactions, and
// members are fetched over REST on demand. No privileged intents required.
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, (ready) => {
  console.log(`Logged in as ${ready.user.tag}. Serving ${ready.guilds.cache.size} guild(s).`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  // Buttons carry their own state in the custom id, so they route on that prefix
  // rather than on a command name.
  if (interaction.isButton()) {
    const handler = buttonHandlerFor(interaction.customId);
    if (!handler) return;
    try {
      await handler(interaction, store);
    } catch (err) {
      await reportFailure(interaction, err, `button ${interaction.customId}`);
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = commandsByName.get(interaction.commandName);
  if (!command) {
    console.warn(`Received unknown command: ${interaction.commandName}`);
    return;
  }

  try {
    await command.execute(interaction, store);
  } catch (err) {
    await reportFailure(interaction, err, `/${interaction.commandName}`);
  }
});

async function reportFailure(
  interaction: RepliableInteraction,
  err: unknown,
  label: string,
): Promise<void> {
  // A UserError describes something the user can fix, so it is shown verbatim.
  // Anything else is a bug: the user gets a generic message and the detail goes
  // to the logs rather than into the channel.
  const isUserFacing = err instanceof UserError;
  if (!isUserFacing) {
    console.error(`${label} failed:`, err);
  }

  const content = isUserFacing
    ? err.message
    : 'Something went wrong on my end. Check the bot logs.';

  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
    } else {
      await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    }
  } catch (replyErr) {
    console.error('Failed to deliver error message to the user:', replyErr);
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\nReceived ${signal}, shutting down.`);
    void client.destroy().finally(() => {
      store.close();
      process.exit(0);
    });
  });
}

// Startup failures are almost always a misconfigured token or client id, so they
// get a one-line explanation instead of a stack trace the reader has to decode.
try {
  await client.login(config.token);
} catch (err) {
  if (err instanceof Error && 'code' in err && err.code === 'TokenInvalid') {
    console.error(
      'Discord rejected the bot token.\n' +
        'Check DISCORD_TOKEN in .env against Developer Portal -> your app -> Bot -> Reset Token.',
    );
  } else {
    console.error('Failed to connect to Discord:', err);
  }
  store.close();
  process.exit(1);
}
