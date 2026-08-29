/**
 * Deriving a slug from a name.
 *
 * The slug is not decoration: it is embedded in every API key the project
 * issues (`bw_live_<slug>_<secret>`), so it has to satisfy KEY_SAFE_SLUG or
 * the keys that project mints cannot be parsed by the auth path.
 */
import { describe, expect, test } from "bun:test";

import { KEY_SAFE_SLUG } from "../../auth/api-key";
import { slugFromName } from "../slug";

describe("a name a person would type", () => {
  test("becomes the slug they would have chosen", () => {
    expect(slugFromName("Acme Ltd.")).toBe("acme-ltd");
    expect(slugFromName("  My  Project  ")).toBe("my-project");
    expect(slugFromName("already-a-slug")).toBe("already-a-slug");
  });

  test("keeps accented letters as their plain form", () => {
    // "Café" becoming "caf" would silently drop a letter from the name; "cafe"
    // is what the operator would have typed if asked for a slug.
    expect(slugFromName("Café Grande")).toBe("cafe-grande");
  });

  test("whatever it produces is a slug a key can carry", () => {
    for (const name of ["Acme Ltd.", "Café Grande", "A—B", "  spaced  out  ", "UPPER CASE"]) {
      const slug = slugFromName(name);
      if (slug === null) continue;
      expect(KEY_SAFE_SLUG.test(slug), `"${name}" produced "${slug}", which no key could carry`).toBe(
        true,
      );
    }
  });

  test("a long name is truncated without a trailing hyphen", () => {
    // The cut can land on a separator, and "grande-pos-…-" is not a valid slug.
    const slug = slugFromName("Grande POS Indonesia Nusantara Sejahtera Abadi");
    expect(slug).not.toBeNull();
    expect(slug!.endsWith("-")).toBe(false);
    expect(KEY_SAFE_SLUG.test(slug!)).toBe(true);
  });
});

describe("a name with no usable slug", () => {
  test("returns null rather than inventing one", () => {
    // Null is what lets the caller ask for a slug instead. Returning
    // "project-1" would name something after a counter nobody chose, and
    // throwing would make an optional field fatal.
    expect(slugFromName("→→→")).toBeNull();
    expect(slugFromName("")).toBeNull();
    expect(slugFromName("   ")).toBeNull();
  });

  test("and for a name too short to be one", () => {
    // KEY_SAFE_SLUG wants three characters. "A" is a name; it is not a slug.
    expect(slugFromName("A")).toBeNull();
  });
});
