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
import {
  renderDate,
  renderDateTime,
  renderIso,
  renderOffset,
  renderTime,
  resetTimeFormatters as clearFormatters,
} from "./render";

/**
 * Reset both the formatter cache and the effective zone.
 *
 * The override is module state, so a test that sets it would otherwise leak a
 * zone into every file that runs after it.
 */
export function resetTimeFormatters(): void {
  clearFormatters();
  effectiveZone = null;
}

/**
 * The effective zone, held in memory rather than read per call.
 *
 * A setting an operator can change has to be resolved against the database,
 * and the log path cannot afford a query per line — nor the import cycle it
 * would create, since the settings store logs. Boot resolves it once and the
 * settings endpoint updates it, so the cost is paid where the change happens.
 */
let effectiveZone: string | null = null;

/**
 * Point rendering at a zone. Null falls back to the environment.
 *
 * Called by boot with whatever `SettingsStore` resolves, and again whenever
 * the setting is written; precedence between environment and database is that
 * store's job, not this module's.
 */
export function setServerTimezone(zone: string | null): void {
  effectiveZone = zone;
}

/** The zone every rendered timestamp uses. */
export function serverTimezone(): string {
  return effectiveZone ?? config().serverTimezone;
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
