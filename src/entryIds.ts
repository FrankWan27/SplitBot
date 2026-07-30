/**
 * The id options of the commands that act on entries already in the ledger.
 *
 * `id` stays a Discord integer option, so the single-entry case - which is nearly
 * every use - keeps the numeric validation Discord does client-side. Naming
 * several entries needs a string option, because Discord has no list-of-numbers
 * type, so `ids` is parsed here and everything an integer option would have
 * rejected has to be rejected in this file instead.
 */

import { UserError } from './errors.js';

export class EntryIdError extends UserError {}

/** Hard cap so one command cannot sweep an entire ledger in a single call. */
export const MAX_ENTRY_IDS = 25;

/**
 * Read a list of entry ids from the raw `ids` option.
 *
 * Accepts `7,9`, `7 9` and `#7, #9`. The hash is tolerated because `/history`
 * labels entries `#7`, so pasting the label back is the obvious thing to try.
 * Duplicates collapse - naming an entry twice is still one deletion - and the
 * order given is kept, so the reply lists entries the way they were typed.
 */
export function parseEntryIds(raw: string): number[] {
  const tokens = raw.split(/[,\s]+/).filter((token) => token !== '');
  if (tokens.length === 0) {
    throw new EntryIdError('Give at least one id, for example `7,9`.');
  }

  const ids: number[] = [];
  for (const token of tokens) {
    const digits = token.startsWith('#') ? token.slice(1) : token;
    // Digits only, deliberately: Number() would otherwise accept `7.0`, `0x7`,
    // `1e3` and `+7`, none of which is an id anybody meant to type, and treating
    // them as one would act on an entry the user did not name.
    const value = Number(digits);
    if (!/^\d+$/.test(digits) || !Number.isSafeInteger(value) || value < 1) {
      throw new EntryIdError(
        `\`${token}\` is not an entry id. Ids are the whole numbers shown as \`#7\` ` +
          'in `/history`; separate several with commas, like `7,9`.',
      );
    }
    if (!ids.includes(value)) ids.push(value);
  }

  if (ids.length > MAX_ENTRY_IDS) {
    throw new EntryIdError(
      `That is ${ids.length} ids; the most I can act on at once is ${MAX_ENTRY_IDS}.`,
    );
  }
  return ids;
}

/** Ids as an `id:`/`ids:` option value that names all of them again, e.g. `1,2`. */
export function idOption(ids: number[]): string {
  return ids.join(',');
}

/**
 * The two id options every entry command offers, for `addIntegerOption` and
 * `addStringOption` respectively.
 *
 * Shared so `/delete` and `/restore` cannot describe the same option differently;
 * `verb` is the only thing that varies between them.
 */
export const ID_OPTION_NAME = 'id';
export const IDS_OPTION_NAME = 'ids';

/**
 * Resolve the ids a command was given.
 *
 * Neither option is required on its own, because either one alone is a complete
 * request. That means "neither given" and "both given" have to be caught here -
 * Discord enforces required-ness but cannot express "exactly one of these two".
 */
export function readEntryIds(options: {
  getInteger: (name: string) => number | null;
  getString: (name: string) => string | null;
}): number[] {
  const single = options.getInteger(ID_OPTION_NAME);
  const list = options.getString(IDS_OPTION_NAME)?.trim();

  if (single !== null && list) {
    throw new EntryIdError(
      `Use either \`${ID_OPTION_NAME}\` for one entry or \`${IDS_OPTION_NAME}\` for several, not both. ` +
        `To include \`#${single}\`, put it in \`${IDS_OPTION_NAME}\` with the others.`,
    );
  }
  if (single !== null) {
    // An integer option can still arrive as 0 or a negative from a client that
    // does not honour setMinValue, so the floor is enforced here as well.
    if (!Number.isSafeInteger(single) || single < 1) {
      throw new EntryIdError(`\`${single}\` is not an entry id. Ids start at 1.`);
    }
    return [single];
  }
  if (list) return parseEntryIds(list);

  throw new EntryIdError(
    `Give the id of an entry, for example \`${ID_OPTION_NAME}:7\` - ` +
      `or \`${IDS_OPTION_NAME}:7,9\` to do several at once.`,
  );
}
