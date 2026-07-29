import type {
  ButtonInteraction,
  ChatInputCommandInteraction,
  SlashCommandOptionsOnlyBuilder,
} from 'discord.js';
import type { Store } from '../db.js';
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
}

export const commands: Command[] = [bill, balances, settle, history, edit, del, restore];

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
