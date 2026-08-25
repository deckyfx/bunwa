/**
 * Serving the console.
 *
 * The mechanism behind two image tags from one binary: `bunwa:api` has no
 * dashboard assets, so the same binary serves nothing at /app. What is worth
 * testing is that absence is handled, that a deep link loads the app rather
 * than 404ing, and that nothing outside the asset root can be reached.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative as relativePath } from "node:path";

import { createStaticHandler } from "../static";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-static-"));
  resetConfig();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  restoreEnv();
});

/** A built console on disk. */
function installConsole(): string {
  const root = join(dir, "dist");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>console</title>");
  writeFileSync(join(root, "index-abc123.js"), "console.log('app')");
  return root;
}

const get = (path: string) => new Request(`http://localhost${path}`);

describe("the api image serves no console", () => {
  test("a missing asset root produces no handler at all", () => {
    // Not an empty handler that 404s — null, so the server never routes /app
    // and the binary behaves as though the console does not exist. That is what
    // makes one binary work in both images.
    expect(createStaticHandler(join(dir, "nothing-here"))).toBeNull();
  });

  test("an asset root without an index is treated as absent", () => {
    const root = join(dir, "empty");
    mkdirSync(root, { recursive: true });
    expect(createStaticHandler(root)).toBeNull();
  });
});

describe("the full image serves it", () => {
  test("/app returns the page", async () => {
    const handler = createStaticHandler(installConsole())!;
    const res = await handler(get("/app"));
    expect(res?.status).toBe(200);
    expect(await res!.text()).toContain("console");
  });

  test("a hashed asset is immutable, the page is not", async () => {
    // index.html must never be cached hard: a deploy would leave browsers
    // holding a page pointing at assets that no longer exist.
    const handler = createStaticHandler(installConsole())!;
    expect((await handler(get("/app/index-abc123.js")))!.headers.get("cache-control")).toContain("immutable");
    expect((await handler(get("/app")))!.headers.get("cache-control")).toBe("no-cache");
  });

  test("a deep link loads the app rather than 404ing", async () => {
    // The console owns its routes; /app/devices is not a missing file.
    const handler = createStaticHandler(installConsole())!;
    const res = await handler(get("/app/devices/vd-1"));
    expect(res?.status).toBe(200);
    expect(await res!.text()).toContain("console");
  });

  test("a request outside /app is not ours", async () => {
    const handler = createStaticHandler(installConsole())!;
    expect(await handler(get("/v1/devices"))).toBeNull();
  });
});

describe("the /app boundary is a path segment, not a prefix", () => {
  test("paths that merely start with the letters are not ours", async () => {
    // startsWith("/app") also claims these, and answering them with the
    // console's index.html hides whatever the API would have said — including
    // a legitimate 404.
    const handler = createStaticHandler(installConsole())!;
    for (const path of ["/application", "/app-old", "/apps", "/appfoo/bar"]) {
      expect(await handler(get(path)), `${path} was claimed by the console`).toBeNull();
    }
  });

  test("the app root and anything beneath it are ours", async () => {
    const handler = createStaticHandler(installConsole())!;
    expect(await handler(get("/app"))).not.toBeNull();
    expect(await handler(get("/app/"))).not.toBeNull();
    expect(await handler(get("/app/devices"))).not.toBeNull();
  });
});

describe("the asset root is canonicalised", () => {
  test("a relative root still serves", async () => {
    // With a relative root the resolved candidate came back absolute while the
    // root stayed relative, so the boundary check compared the two and refused
    // everything. Every existing test passes an absolute mkdtemp path, so none
    // of them could see it.
    const absolute = installConsole();
    const relative = relativePath(process.cwd(), absolute);

    const handler = createStaticHandler(relative);
    expect(handler, "a relative root produced no handler at all").not.toBeNull();
    const res = await handler!(get("/app"));
    expect(res?.status).toBe(200);
    expect(await res!.text()).toContain("console");
  });
});

describe("nothing outside the asset root is reachable", () => {
  test("traversal is refused rather than served", async () => {
    // Asserts the property, not a particular line. Removing the boundary check
    // in static.ts does not fail this, because normalize() already prevents
    // escape — which is worth knowing rather than assuming the check is what
    // holds. The value here is as a regression net: if path handling is ever
    // rewritten, this fails.
    const root = installConsole();
    writeFileSync(join(dir, "secret.txt"), "NOT-FOR-SERVING");

    for (const path of [
      "/app/../secret.txt",
      "/app/../../etc/hostname",
      "/app/%2e%2e/secret.txt",
      "/app/..%2fsecret.txt",
    ]) {
      const res = await createStaticHandler(root)!(get(path));
      const body = res === null ? "" : await res.text();
      expect(body, `${path} escaped the asset root`).not.toContain("NOT-FOR-SERVING");
    }
  });
});
