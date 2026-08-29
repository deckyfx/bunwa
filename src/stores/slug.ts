/**
 * Turning a name a person typed into a slug a key can carry.
 *
 * The slug is not cosmetic: it appears inside every API key that project
 * issues (`bw_live_<slug>_<secret>`), which is why `KEY_SAFE_SLUG` is narrow
 * and why a name has to be reduced to it rather than merely lowercased.
 *
 * Shared so the console's preview and the server's answer cannot disagree.
 * A form that shows one slug and creates another is worse than one that asks
 * for the slug outright.
 */
import { KEY_SAFE_SLUG } from "../auth/api-key";

/**
 * Derive a slug from a display name, or return null if nothing usable remains.
 *
 * Null rather than a thrown error or a made-up value: "Acme Ltd." has an
 * obvious slug and "→→→" has none, and the caller needs to tell those apart to
 * decide whether to ask the operator for one. Inventing `project-1` here would
 * name something after a counter nobody chose.
 */
export function slugFromName(name: string): string | null {
  const slug = name
    .normalize("NFKD")
    // Accents dropped rather than transliterated: "Café" becomes "cafe", which
    // is what someone would have typed anyway.
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    // Anything that is not a letter, digit or hyphen becomes a boundary, so
    // "Acme Ltd." and "Acme-Ltd" arrive at the same place.
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    // A trailing hyphen can reappear after the truncation above.
    .replace(/-+$/g, "");

  return KEY_SAFE_SLUG.test(slug) ? slug : null;
}
