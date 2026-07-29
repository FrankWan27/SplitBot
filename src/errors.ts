/**
 * Thrown when the user asked for something impossible and the message explains
 * how to fix it. The interaction handler shows these verbatim; every other error
 * is treated as a bug and hidden behind a generic message.
 */
export class UserError extends Error {}
