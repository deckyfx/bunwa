/**
 * The typed client for the control plane.
 *
 * Eden Treaty against the server's own `App` type, so a route that changes
 * signature is a compile error here rather than a 400 someone finds in a
 * browser. docs/07 calls this "the reason to have chosen Elysia", and the
 * console did not use it until now: the previous client was a hand-rolled
 * fetch wrapper with hand-written types, and both `Whoami` and `VirtualDevice`
 * were wrong — the page rendered "undefined / undefined" against a live API.
 *
 * `window.location.origin` rather than a configured base URL. The console is
 * served by the same Elysia app that answers these calls, so same-origin is
 * both correct and the only arrangement that survives a reverse proxy, a
 * changed port, or HTTPS without anyone editing a constant.
 */
import { treaty } from "@elysiajs/eden";

import type { App } from "../../api/server";

/**
 * Build a client carrying a key.
 *
 * Per call rather than a module singleton: the key belongs to the browser
 * session, and a client that captured one at import time would keep serving
 * the previous tenant's data after someone switched keys.
 */
export const client = (apiKey: string) =>
  treaty<App>(typeof window === "undefined" ? "http://localhost:3000" : window.location.origin, {
    headers: { "x-api-key": apiKey },
  });

/** A client with no credential, for the endpoints that need none. */
export const anonymous = () =>
  treaty<App>(typeof window === "undefined" ? "http://localhost:3000" : window.location.origin);
