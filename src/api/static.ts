/**
 * Serving the console, when it is there.
 *
 * The mechanism behind two image tags from one binary (docs/07). `bunwa:full`
 * copies the built SPA in; `bunwa:api` does not, and the same binary then
 * serves nothing at `/app` because there is nothing to serve. No build flag, no
 * environment variable, no second entrypoint — the presence of the files is the
 * switch.
 */
import { join, normalize, resolve } from "node:path";

import { log } from "../observability/logger";

/** Where the build puts the console. Overridable so a test can point elsewhere. */
export const DEFAULT_ASSET_ROOT = resolve(import.meta.dir, "..", "..", "dashboard", "dist");

/**
 * A handler for `/app/*`, or null when no console is installed.
 *
 * Resolved once at startup rather than per request: the answer cannot change
 * while the process runs, and stat-ing the disk on every request to learn
 * something already known is the kind of cost that only shows up under load.
 */
export function createStaticHandler(root: string = DEFAULT_ASSET_ROOT): ((request: Request) => Promise<Response | null>) | null {
  const indexPath = join(root, "index.html");
  if (!Bun.file(indexPath).size) {
    log.info("no console assets found; /app is not served", { root });
    return null;
  }

  log.info("serving the console", { root });

  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/app")) return null;

    // Decoded first, then normalised, then checked.
    //
    // `new URL` collapses literal `../` before this ever runs, so an attack
    // written that way never arrives — which meant an earlier version of this
    // function had a boundary check no request could reach, and a test that
    // passed with the check deleted. Percent-encoded traversal (`..%2f`)
    // survives URL parsing intact, so decoding is both more correct — a file
    // named with %20 should resolve — and the thing that makes the boundary
    // check load-bearing rather than decorative.
    let decoded: string;
    try {
      decoded = decodeURIComponent(url.pathname.slice("/app".length));
    } catch {
      // Malformed percent-encoding is not a path we can reason about.
      return new Response("Not found", { status: 404 });
    }

    const relative = normalize(decoded);
    const candidate = resolve(root, `.${relative.startsWith("/") ? relative : `/${relative}`}`);

    // Unreachable today, and kept anyway.
    //
    // normalize() is what actually prevents escape: on an absolute path it
    // drops leading `..` segments, so `/../secret.txt` becomes `/secret.txt`
    // and resolve() lands inside the root regardless. Verified — removing this
    // check changes no test, because nothing can reach it.
    //
    // Not deleted on that reasoning. The same argument was made about a
    // MAX(expires_at) in the rate limiter during stage 2, it was wrong, and
    // removing the guard cost a real bug. The cost here is three lines; the
    // cost of being wrong is serving whatever is above the asset root.
    if (candidate !== root && !candidate.startsWith(root + "/")) {
      log.warn("refused a path outside the asset root", { path: url.pathname });
      return new Response("Not found", { status: 404 });
    }

    const file = Bun.file(candidate);
    if (await file.exists()) {
      return new Response(file, {
        headers: {
          // Hashed filenames are immutable; index.html must never be, or a
          // deploy leaves browsers holding a page that points at assets which
          // no longer exist.
          "cache-control": candidate.endsWith("index.html")
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        },
      });
    }

    // A single-page app owns its routes: /app/devices is the console's, not a
    // missing file. Anything unmatched falls back to index.html so a deep link
    // or a refresh loads the app rather than a 404.
    return new Response(Bun.file(indexPath), {
      headers: { "content-type": "text/html;charset=utf-8", "cache-control": "no-cache" },
    });
  };
}
