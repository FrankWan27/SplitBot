import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import type { Store } from '../db.js';
import { withPrivateOption } from '../visibility.js';
import * as bill from './bill.js';
import * as balances from './balances.js';
import * as settle from './settle.js';
import * as history from './history.js';
import * as edit from './edit.js';
import * as del from './delete.js';
import * as restore from './restore.js';

export interface Command {
  data: SlashCommandOptionsOnlyBuilder;
  execute: (interaction: ChatInputCommandInteraction, store: Store) => Promise<void>;
  /**
   * Whether this command's reply goes to the caller alone when `private` is not
   * given. Omitted means public, which is the right default for anything that
   * records a shared fact.
   */
  privateByDefault?: boolean;
}

export const commands: Command[] = [bill, balances, settle, history, edit, del, restore];

// Every command can reply privately, so the flag is added once here rather than
// declared seven times. Declaring it per command would let the name or the meaning
// drift between them, and a flag that means subtly different things depending on
// which command carries it is worse than no flag at all.
//
// What each command *defaults* to is its own business, and comes from the command
// itself: `/balances` answers a question about one person and is private unless
// asked otherwise, while the rest record shared facts and belong in the channel.
//
// This mutates each builder in place, which is what `addBooleanOption` does
// anyway; the exported `data` objects are the same ones `deploy-commands` reads.
for (const command of commands) {
  withPrivateOption(command.data, command.privateByDefault ?? false);
}

export const commandsByName = new Map(commands.map((c) => [c.data.name, c]));

export type ButtonHandler = (interaction: ButtonInteraction, store: Store) => Promise<void>;

/**
 * A button's custom id starts with the name of whatever owns it, since Discord
 * gives us nothing else to route on. Everything after that prefix belongs to the
 * handler, which is where the paging state lives.
 */
const buttonHandlers: Array<{ prefix: string; handle: ButtonHandler }> = [
  { prefix: 'history:', handle: history.handleButton },
];

export function buttonHandlerFor(customId: string): ButtonHandler | null {
  return buttonHandlers.find((h) => customId.startsWith(h.prefix))?.handle ?? null;
}
