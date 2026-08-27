/**
 * The font files global.css names by hand.
 *
 * global.css writes its own @font-face rules against specific Fontsource files
 * rather than importing the package's CSS, because Bun inlines every url() in
 * a stylesheet and that turns thirteen unicode subsets into 313 KB gzipped of
 * render-blocking CSS. Naming the latin file directly is 96 KB.
 *
 * The cost of that choice is a hardcoded path into someone else's package. If
 * an upgrade renames or moves a file, the bundle still builds, the page still
 * renders, and the console quietly falls back to the system stack — a change
 * nobody would notice for months. This turns that into a failing test.
 */
import { describe, expect, test } from "bun:test";

const css = await Bun.file(new URL("../global.css", import.meta.url)).text();

/** Every `url(...)` global.css points at, as written. */
const referenced = [...css.matchAll(/url\("([^"]+)"\)/g)].map((m) => m[1] ?? "");

describe("the fonts global.css names", () => {
  test("it names some", () => {
    // Guards the guard: a regex that silently matches nothing would make every
    // assertion below vacuously true.
    expect(referenced.length).toBeGreaterThan(0);
  });

  test("every referenced file exists in node_modules", async () => {
    for (const specifier of referenced) {
      const resolved = Bun.resolveSync(specifier, import.meta.dir);
      expect(await Bun.file(resolved).exists(), `${specifier} does not exist`).toBe(true);
    }
  });

  test("each one is a woff2, not a redirect or an error page", async () => {
    for (const specifier of referenced) {
      const bytes = new Uint8Array(
        await Bun.file(Bun.resolveSync(specifier, import.meta.dir)).arrayBuffer(),
      );
      // wOF2 — the magic number. A file that exists but is not a font would
      // fail exactly as silently as a missing one.
      expect(String.fromCharCode(...bytes.slice(0, 4)), `${specifier} is not woff2`).toBe("wOF2");
    }
  });

  test("the family is actually applied to the document, not just declared", () => {
    // The trap this exists for: `--font-sans` only backs the `font-sans`
    // utility. Tailwind's preflight sets the document root from
    // `--default-font-family`, a different variable — so declaring
    // `--font-sans` alone downloads the font and then renders the page in the
    // system stack, with nothing reporting a problem and the fallback looking
    // perfectly fine. Deleting either line below reintroduces that silently.
    expect(css, "--default-font-family is unset; html would use the system stack").toContain(
      "--default-font-family: var(--font-sans)",
    );
    expect(css, "--default-mono-font-family is unset").toContain(
      "--default-mono-font-family: var(--font-mono)",
    );
  });

  test("only the latin subsets are named", () => {
    // The whole point of writing these rules by hand. An @import of the
    // package CSS, or a path to another subset, puts the other twelve back in
    // the bundle as base64 and costs 217 KB gzipped.
    for (const specifier of referenced) {
      expect(specifier, `${specifier} is not the latin subset`).toContain("-latin-");
    }
  });
});
