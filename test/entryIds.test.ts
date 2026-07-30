import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  EntryIdError,
  MAX_ENTRY_IDS,
  idOption,
  parseEntryIds,
  readEntryIds,
} from '../src/entryIds.js';

/**
 * `ids` is a string option because Discord has no list-of-numbers type, so every
 * check an integer option would have done client-side has to happen here. These
 * lean hardest on what is *rejected*: a value quietly coerced to the wrong number
 * would delete an entry nobody named.
 */

test('a single id parses to one entry', () => {
  assert.deepEqual(parseEntryIds('7'), [7]);
});

test('commas, spaces and both together all separate ids', () => {
  assert.deepEqual(parseEntryIds('1,2'), [1, 2]);
  assert.deepEqual(parseEntryIds('1 2'), [1, 2]);
  assert.deepEqual(parseEntryIds('1, 2,  3'), [1, 2, 3]);
  assert.deepEqual(parseEntryIds('  4 , 5  '), [4, 5]);
});

test('the # that /history prints is accepted, since pasting the label back is natural', () => {
  assert.deepEqual(parseEntryIds('#7'), [7]);
  assert.deepEqual(parseEntryIds('#7, #9'), [7, 9]);
});

test('the order typed is kept, so the reply reads back the way it was asked', () => {
  assert.deepEqual(parseEntryIds('9,3,7'), [9, 3, 7]);
});

test('duplicates collapse - naming an entry twice is still one deletion', () => {
  assert.deepEqual(parseEntryIds('7,7'), [7]);
  assert.deepEqual(parseEntryIds('7,#7, 7'), [7]);
  assert.deepEqual(parseEntryIds('2,1,2'), [2, 1]);
});

test('anything Number() would coerce is rejected rather than rounded into an id', () => {
  // Every one of these is a number to JavaScript. Accepting any of them would
  // act on an entry the user did not type.
  for (const bad of ['1.5', '1.0', '0x7', '1e3', '+7', ' 7.', '7f', '--7']) {
    assert.throws(() => parseEntryIds(bad), EntryIdError, `${bad} must be refused`);
  }
});

test('ids below one are refused, since entry ids start at one', () => {
  for (const bad of ['0', '-1', '-0']) {
    assert.throws(() => parseEntryIds(bad), EntryIdError, `${bad} must be refused`);
  }
});

test('an id past the safe integer range is refused rather than silently rounded', () => {
  // 2^53 is where consecutive integers stop being representable; an id that far
  // out is a typo, and parsing it as its nearest double would be worse.
  assert.throws(() => parseEntryIds('9007199254740993'), EntryIdError);
});

test('an empty or separator-only value asks for an id instead of doing nothing', () => {
  for (const empty of ['', '   ', ',', ' , , ']) {
    assert.throws(() => parseEntryIds(empty), EntryIdError);
  }
});

test('the error names the token it could not read', () => {
  assert.throws(() => parseEntryIds('1,two,3'), (err: unknown) => {
    assert.ok(err instanceof EntryIdError);
    assert.match(err.message, /`two`/, 'quotes the bad token, not the whole option');
    return true;
  });
});

test('a batch at the cap is allowed and one past it is not', () => {
  const atCap = Array.from({ length: MAX_ENTRY_IDS }, (_, i) => i + 1);
  assert.deepEqual(parseEntryIds(atCap.join(',')), atCap);

  const overCap = Array.from({ length: MAX_ENTRY_IDS + 1 }, (_, i) => i + 1);
  assert.throws(() => parseEntryIds(overCap.join(',')), (err: unknown) => {
    assert.ok(err instanceof EntryIdError);
    assert.match(err.message, new RegExp(String(MAX_ENTRY_IDS)));
    return true;
  });
});

test('the cap counts distinct ids, so repeats do not use it up', () => {
  const repeated = Array.from({ length: MAX_ENTRY_IDS + 5 }, () => '7').join(',');
  assert.deepEqual(parseEntryIds(repeated), [7]);
});

/** Stands in for Discord's option accessors. */
function options(args: { id?: number; ids?: string }) {
  return {
    getInteger: (name: string) => (name === 'id' ? (args.id ?? null) : null),
    getString: (name: string) => (name === 'ids' ? (args.ids ?? null) : null),
  };
}

test('either option alone is a complete request', () => {
  assert.deepEqual(readEntryIds(options({ id: 7 })), [7]);
  assert.deepEqual(readEntryIds(options({ ids: '7,9' })), [7, 9]);
});

test('id and ids together is refused rather than one of them being guessed at', () => {
  assert.throws(() => readEntryIds(options({ id: 7, ids: '9' })), (err: unknown) => {
    assert.ok(err instanceof EntryIdError);
    assert.match(err.message, /not both/);
    return true;
  });
});

test('a blank ids alongside id is treated as absent, not as a conflict', () => {
  // Discord sends an omitted string option as null, but a client that sends an
  // empty one must not turn a perfectly good `id:7` into an error.
  assert.deepEqual(readEntryIds(options({ id: 7, ids: '   ' })), [7]);
});

test('neither option given explains both ways to name an entry', () => {
  assert.throws(() => readEntryIds(options({})), (err: unknown) => {
    assert.ok(err instanceof EntryIdError);
    assert.match(err.message, /id:7/);
    assert.match(err.message, /ids:7,9/);
    return true;
  });
});

test('the integer option is floored here too, in case a client ignores setMinValue', () => {
  for (const bad of [0, -3, 1.5]) {
    assert.throws(() => readEntryIds(options({ id: bad })), EntryIdError, `${bad} must be refused`);
  }
});

test('idOption round-trips through the parser, so an undo hint always works', () => {
  const ids = [9, 3, 7];
  assert.deepEqual(parseEntryIds(idOption(ids)), ids);
});
