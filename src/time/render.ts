/**
 * Rendering an instant in a named timezone.
 *
 * Pure and dependency-free on purpose: the console imports this, and anything
 * it imports is bundled into the browser. The server-side wrappers that supply
 * the configured zone live in `format.ts`, which reads configuration and must
 * therefore never reach the client.
 *
 * Storage is untouched by all of this. Rows keep UTC epoch milliseconds, the
 * only representation that survives a timezone change; this governs
 * presentation, and presentation only.
 */

/**
 * Formatters are expensive to build, so they are cached.
 *
 * Keyed by zone rather than held as one, because tests reload configuration
 * between cases and a formatter captured at module load would keep formatting
 * in whichever zone happened to be set first.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(zone: string): Intl.DateTimeFormat {
  const existing = formatters.get(zone);
  if (existing !== undefined) return existing;

  const created = new Intl.DateTimeFormat("en-GB", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  formatters.set(zone, created);
  return created;
}

/**
 * `2026-08-27 21:15:04` in the given zone.
 *
 * Sortable and unambiguous. Deliberately not locale-shaped: `27/08/2026` reads
 * as a different date to half the world, and this string ends up both in log
 * files people grep and on a screen someone reads over a phone call.
 */
export function renderDateTime(at: Date, zone: string): string {
  const parts = formatterFor(zone).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "00";

  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** `21:15:04` — where the date is usually today. */
export const renderTime = (at: Date, zone: string): string => renderDateTime(at, zone).slice(11);

/** `2026-08-27` — for a filename or a day boundary. */
export const renderDate = (at: Date, zone: string): string => renderDateTime(at, zone).slice(0, 10);

/**
 * The offset as `+07:00`.
 *
 * Computed from the zone at that instant rather than assumed constant: a
 * deployment somewhere that observes daylight saving would otherwise be an
 * hour out for half the year, and be right in testing.
 */
export function renderOffset(at: Date, zone: string): string {
  const zoned = new Date(at.toLocaleString("en-US", { timeZone: zone }));
  const utc = new Date(at.toLocaleString("en-US", { timeZone: "UTC" }));
  const minutes = Math.round((zoned.getTime() - utc.getTime()) / 60_000);

  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** An ISO 8601 string in the given zone, offset included. */
export const renderIso = (at: Date, zone: string): string =>
  `${renderDateTime(at, zone).replace(" ", "T")}${renderOffset(at, zone)}`;

/** Reset the cache. Tests change the zone between cases. */
export function resetTimeFormatters(): void {
  formatters.clear();
}
