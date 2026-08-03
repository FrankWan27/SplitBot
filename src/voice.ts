/**
 * How a reply refers to the people in it.
 *
 * A private reply goes to exactly one reader, so naming that reader by mention
 * reads as a sentence about somebody else: "@franky owes @gant $61.58", shown
 * privately to franky, is worse than "you owe @gant $61.58". A public reply
 * addresses the channel, where every reader is a third party and a mention is the
 * only thing that works.
 *
 * Which one applies follows from who can see the reply, so it is derived from the
 * visibility rather than chosen separately - see `voiceOf`.
 */

/** The one person a reply is addressed to, if it is addressed to anyone. */
export interface Voice {
  /** Their user id, or null when the reply addresses the channel at large. */
  readonly you: string | null;
}

/** A reply everyone can read, and so one that addresses nobody in particular. */
export const CHANNEL: Voice = { you: null };

export function addressing(userId: string): Voice {
  return { you: userId };
}

/** How to refer to a person: `you` for the reader, a mention for anyone else. */
export function who(voice: Voice, userId: string): string {
  return voice.you === userId ? 'you' : `<@${userId}>`;
}

/**
 * A verb agreeing with its subject: the third-person form for a mention, the
 * second-person form for `you`.
 *
 * Both forms are spelt out rather than derived by trimming an `s`, because the
 * irregular ones are exactly the ones worth getting right: `is`/`are` and
 * `does`/`do` carry no `s` to drop, and "you owes" is the kind of mistake that
 * makes a bot look broken.
 */
export function verb(voice: Voice, userId: string, third: string, second: string): string {
  return voice.you === userId ? second : third;
}

/**
 * A person reference fit to open a sentence.
 *
 * Only `you` is ever affected: a mention renders as a display name Discord has
 * already capitalised however its owner wanted it, and forcing a case onto that
 * would rewrite somebody's name.
 */
export function capitalise(reference: string): string {
  return reference === 'you' ? 'You' : reference;
}
