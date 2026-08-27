/**
 * The import rule, enforced.
 *
 * ADR-0009 says one file may import from `@whiskeysockets/baileys`. A rule
 * that only exists in prose is one hurried commit from being false, and this
 * project has repeatedly paid for guards that were written down and never
 * checked — three sweeps with no call site, a rate limit with no caller, a
 * circuit breaker that was never wired.
 *
 * Checked against the source rather than at runtime: an import that is present
 * but unused still couples us, and would not show up in any behavioural test.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const PORT = "src/engine/baileys/socket.ts";
const LIBRARY = "@whiskeysockets/baileys";

/** Every way a file could reach the library. */
const IMPORT_FORMS = [
  new RegExp(String.raw`from\s*["']` + LIBRARY),
  new RegExp(String.raw`require\s*\(\s*["']` + LIBRARY),
  new RegExp(String.raw`import\s*\(\s*["']` + LIBRARY),
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("only the port module knows about Baileys", () => {
  test("no other file imports the library", () => {
    const offenders = sourceFiles("src")
      .filter((f) => f !== PORT)
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        // Matches the import, not a mention: the ADR and several comments name
        // the package deliberately, and failing on those would train everyone
        // to stop writing the reason down.
        //
        // Three forms, because any of them bypasses the guard equally well and
        // the first version caught only the first: a static import, a
        // require(), and a dynamic import(). Both quote styles, and whitespace
        // where a formatter might put it.
        return IMPORT_FORMS.some((pattern) => pattern.test(text));
      });

    expect(offenders, `these files import ${LIBRARY} directly`).toEqual([]);
  });

  test("the port module does import it, so the test cannot pass vacuously", () => {
    // Without this, deleting the port would make the rule trivially satisfied
    // and the suite would report success for an engine that no longer exists.
    expect(readFileSync(PORT, "utf8")).toContain(`from "${LIBRARY}"`);
  });

  test("the dashboard does not reach the library either", () => {
    // A separate subproject with its own dependencies, so its imports resolve
    // independently and would not be caught by the sweep above.
    const offenders = sourceFiles("dashboard/src").filter((f) => {
      const text = readFileSync(f, "utf8");
      return IMPORT_FORMS.some((pattern) => pattern.test(text));
    });
    expect(offenders).toEqual([]);
  });
});
