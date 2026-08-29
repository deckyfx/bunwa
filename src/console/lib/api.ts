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

/**
 * The element type of a list route's response.
 *
 * Three stores had their own identical copy of this, which is three chances
 * for them to drift apart while all still compiling. It belongs beside the
 * client whose shape it describes.
 *
 * Eden types `data` as a union of the body and the error shape, so the array
 * half is extracted before its element is read. Both steps are load-bearing:
 * dropping the `Extract` and matching `NonNullable<D>` against
 * `ReadonlyArray<infer Row>` directly looks tidier and silently yields
 * `unknown`, because the union as a whole does not extend an array and a
 * non-naked type in that position does not distribute. Tried, and every
 * derived row type became `unknown` while still compiling — which is the
 * failure this helper exists to prevent.
 */
export type RowOf<T> = T extends { data: infer D }
  ? Extract<NonNullable<D>, readonly unknown[]>[number]
  : never;

/**
 * The request body a route accepts, taken from the route itself.
 *
 * The counterpart to `RowOf` for the other direction. A hand-written request
 * shape compiles happily while the server has moved on — which is how `Whoami`
 * and `VirtualDevice` were both wrong against a live API — and a body is the
 * half nothing else checks: a response that changed shape at least renders
 * "undefined", a request that changed shape is a 422 the console cannot
 * explain.
 */
export type BodyOf<F> = F extends (body: infer B, ...rest: never[]) => unknown ? NonNullable<B> : never;
