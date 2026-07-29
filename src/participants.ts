import type { Guild } from 'discord.js';
import { UserError } from './errors.js';

export class ParticipantError extends UserError {}

/** Hard cap so one command cannot fan out into hundreds of REST lookups. */
export const MAX_PARTICIPANTS = 25;

const MENTION_PATTERN = /<@!?(\d+)>/g;

/**
 * Pull user ids out of a raw slash-command string in the order they were typed.
 *
 * Discord's client turns an `@name` picked from its autocomplete into a real
 * `<@id>` token inside string options, so parsing those tokens is what lets one
 * option accept any number of people. Plain text that is not a mention is
 * reported rather than ignored, so a typo never silently drops someone from a
 * split.
 */
export function parseMentionIds(raw: string): string[] {
  const ids: string[] = [];
  for (const match of raw.matchAll(MENTION_PATTERN)) {
    ids.push(match[1]!);
  }

  const leftover = raw.replace(MENTION_PATTERN, ' ').replace(/[,\s]+/g, ' ').trim();
  if (leftover !== '') {
    throw new ParticipantError(
      `I could not read \`${leftover}\` as a person. Pick people from the ` +
        `autocomplete list so they come through as real mentions (like @name), ` +
        `rather than typing their name as plain text.`,
    );
  }
  if (ids.length === 0) {
    throw new ParticipantError('Mention at least one person to split with.');
  }
  return ids;
}

/**
 * Turn raw ids into a deduplicated, validated participant list.
 *
 * Members are fetched one id at a time over REST, which deliberately avoids the
 * privileged GuildMembers gateway intent - the bot works as soon as it is
 * invited, with no extra toggles in the developer portal.
 */
export async function resolveParticipants(
  guild: Guild,
  ids: string[],
): Promise<{ id: string; label: string }[]> {
  const unique = [...new Set(ids)];
  if (unique.length > MAX_PARTICIPANTS) {
    throw new ParticipantError(
      `That is ${unique.length} people; the most I can split between at once is ${MAX_PARTICIPANTS}.`,
    );
  }

  const resolved = await Promise.all(
    unique.map(async (id) => {
      try {
        const member = await guild.members.fetch(id);
        return { id, label: member.displayName, bot: member.user.bot };
      } catch {
        return null;
      }
    }),
  );

  const missing = unique.filter((_, i) => resolved[i] === null);
  if (missing.length > 0) {
    throw new ParticipantError(
      `These users are not in this server: ${missing.map((id) => `<@${id}>`).join(', ')}`,
    );
  }

  const found = resolved as { id: string; label: string; bot: boolean }[];
  const bots = found.filter((m) => m.bot);
  if (bots.length > 0) {
    throw new ParticipantError(
      `Bots cannot owe money: ${bots.map((m) => `<@${m.id}>`).join(', ')}`,
    );
  }

  return found.map(({ id, label }) => ({ id, label }));
}
