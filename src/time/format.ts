/**
 * Rendering dates in the server's configured timezone.
 *
 * Every displayed timestamp goes through here. Not a style rule: a log line, a
 * console row and an answer to "when did this send?" that disagree by seven
 * hours are worse than all three being in UTC, because the reader cannot tell
 * which one to trust.
 *
 * This module reads configuration, so it is server-side only. Browser code
 * imports `render.ts` and supplies the zone the server told it.
 */
import { config } from "../config/env";
import { renderDate, renderDateTime, renderIso, renderOffset, renderTime } from "./render";

export { resetTimeFormatters } from "./render";

/** The configured zone. Read per call so a reload is picked up. */
export function serverTimezone(): string {
  return config().serverTimezone;
}

/** `2026-08-27 21:15:04` in the server's timezone. */
export const formatDateTime = (at: Date = new Date()): string => renderDateTime(at, serverTimezone());

/** `21:15:04` — for a console line, where the date is usually today. */
export const formatTime = (at: Date = new Date()): string => renderTime(at, serverTimezone());

/** `2026-08-27` — for a filename or a day boundary. */
export const formatDate = (at: Date = new Date()): string => renderDate(at, serverTimezone());

/** The offset as `+07:00`, for an ISO string that carries its zone. */
export const timezoneOffset = (at: Date = new Date()): string => renderOffset(at, serverTimezone());

/**
 * An ISO 8601 string in the server's zone, offset included.
 *
 * For anything a person reads that must still parse: it is unambiguous, and it
 * keeps the configured zone visible rather than silently normalising to UTC.
 */
export const formatIso = (at: Date = new Date()): string => renderIso(at, serverTimezone());

/**
 * An instant on the wire, as UTC `...Z`.
 *
 * API responses and webhook payloads keep UTC deliberately. They are parsed by
 * other people's code, whose expectations were set by the existing contract,
 * and `Z` denotes exactly the same instant as an offset form would. The zone
 * is a presentation choice; changing what a machine receives to follow it
 * would be a breaking change that buys nothing.
 */
export const formatWire = (at: Date): string => at.toISOString();
