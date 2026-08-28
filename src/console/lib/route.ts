/**
 * Where the console is, expressed in the address bar.
 *
 * A fragment rather than a path, and that is the whole reason this works with
 * no server support: `/app#devices` is a request for `/app` — the part after
 * the `#` is never sent. A reload, a bookmark and a pasted link all land back
 * on the same screen without the server needing a route per section, and
 * without a deep link 404ing on a build that has not been redeployed.
 *
 * The section names here are the ones a person reads, not the ones the code
 * uses internally: the chat screen is `chats` in the source and
 * `conversations` in the URL, because an address is read aloud and typed by
 * hand and should say what it means.
 */
import { SECTIONS as SIDEBAR_SECTIONS, type SectionId } from "../components/Sidebar";

export interface Route {
  section: SectionId;
  /** The thing being looked at within the section, if any. */
  detail: string | null;
}

/** URL name ↔ internal id. Only where the two differ. */
const TO_URL: Partial<Record<SectionId, string>> = { chats: "conversations" };
const FROM_URL: Record<string, SectionId> = { conversations: "chats" };

/**
 * Every section that has an address.
 *
 * Derived from the sidebar's list rather than repeated here. Repeating it is
 * what went wrong: `projects` was added to the sidebar and not to this array,
 * so `#projects` parsed as unknown, fell back to the default, and the section
 * bounced straight back to devices the moment the hashchange landed. The
 * screen existed and could not be addressed.
 */
const SECTIONS: SectionId[] = SIDEBAR_SECTIONS.map((section) => section.id);

/** Where an address with nothing useful in it goes. */
export const DEFAULT_ROUTE: Route = { section: "devices", detail: null };

/**
 * Read a route out of a fragment.
 *
 * Anything unrecognised falls back to the default rather than throwing or
 * rendering nothing: a hand-edited or stale address should land somewhere
 * usable, not on a blank page.
 */
/**
 * Decode, or keep the raw text.
 *
 * `decodeURIComponent` throws `URIError` on an incomplete escape, so a hash
 * like `#devices/%E0%A4%A` made `parseRoute` throw — which the docstring above
 * says it does not do. The store's caller happened to catch it and land on the
 * default, so the stated rule held by accident there and nowhere else.
 */
function decodeOrRaw(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Turn a location fragment into a route the console can render.
 *
 * Total by construction: anything unrecognised, malformed or half-escaped
 * lands on `DEFAULT_ROUTE` rather than throwing or rendering nothing. A hash is
 * the one input a user can type directly into the address bar, and a
 * hand-edited or stale one should still arrive somewhere usable — which is
 * also why the decode below cannot be allowed to throw.
 */
export function parseRoute(hash: string): Route {
  const raw = hash.replace(/^#/, "");
  if (raw === "") return DEFAULT_ROUTE;

  const [head = "", ...rest] = raw.split("/");
  const name = decodeOrRaw(head).toLowerCase();

  const section = FROM_URL[name] ?? (SECTIONS.includes(name as SectionId) ? (name as SectionId) : null);
  if (section === null) return DEFAULT_ROUTE;

  const detail = rest.length === 0 ? null : decodeOrRaw(rest.join("/"));
  return { section, detail: detail === "" ? null : detail };
}

/** Build the fragment for a route. Always includes the `#`. */
export function formatRoute(route: Route): string {
  const name = TO_URL[route.section] ?? route.section;
  // Encoded, because a detail can be anything the server issued and a bare
  // one would break the fragment at the first slash or space it contained.
  return route.detail === null ? `#${name}` : `#${name}/${encodeURIComponent(route.detail)}`;
}

/** Whether two routes are the same, so navigation can avoid a needless entry. */
export const sameRoute = (a: Route, b: Route): boolean => a.section === b.section && a.detail === b.detail;
