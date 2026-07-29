import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMentionIds, ParticipantError } from '../src/participants.js';

test('extracts mention ids in the order given', () => {
  assert.deepEqual(parseMentionIds('<@111> <@222> <@333>'), ['111', '222', '333']);
});

test('accepts the legacy nickname mention form', () => {
  assert.deepEqual(parseMentionIds('<@!111> <@222>'), ['111', '222']);
});

test('tolerates commas and irregular spacing between mentions', () => {
  assert.deepEqual(parseMentionIds('<@111>,<@222>,  <@333>'), ['111', '222', '333']);
});

test('keeps duplicates for the caller to dedupe', () => {
  // Dedupe happens in resolveParticipants, which is also where the count is
  // validated; parsing stays purely syntactic.
  assert.deepEqual(parseMentionIds('<@111> <@111>'), ['111', '111']);
});

test('rejects plain-text names instead of silently dropping them', () => {
  assert.throws(() => parseMentionIds('<@111> bob'), ParticipantError);
  assert.throws(() => parseMentionIds('alice and bob'), ParticipantError);
});

test('rejects an empty participant list', () => {
  assert.throws(() => parseMentionIds(''), ParticipantError);
  assert.throws(() => parseMentionIds('   '), ParticipantError);
});

test('the error names the text it could not understand', () => {
  try {
    parseMentionIds('<@111> steve');
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(err instanceof ParticipantError);
    assert.match(err.message, /steve/);
  }
});
