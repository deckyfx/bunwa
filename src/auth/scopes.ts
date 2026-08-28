/**
 * What a key is allowed to do.
 *
 * Scopes were free-form strings checked at five call sites with no list
 * anywhere, so nothing could answer "what may a key be granted?" — which is
 * the question both the setup flow and the admin API have to answer to mint
 * one. Listing them here does not change enforcement; it gives the grant side
 * the same vocabulary the check side already uses.
 */
export const ALL_SCOPES = [
  "send:text",
  "send:media",
  "receive:messages",
  "manage:devices",
  "manage:webhook",
  "manage:rules",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

/** Whether a string is a scope this build enforces. */
export const isScope = (value: string): value is Scope => (ALL_SCOPES as readonly string[]).includes(value);
