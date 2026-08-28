/**
 * The console, as an Elysia plugin.
 *
 * The pattern from BUN_ELYSIA_SERVER.md: import the HTML and hand it to a
 * route. Elysia's own `.listen()` sets up Bun.serve with `routes`, which is
 * what bundles the page, injects the client script and wires hot reload.
 *
 * The page was briefly served from a hand-rolled `Bun.serve({ fetch })`
 * wrapper instead. That bypasses the bundling entirely: Elysia serialised the
 * import as JSON and /app answered 200 with the body `{}` — a route that looks
 * healthy in every log and check while serving nothing.
 */
import { Elysia } from "elysia";

import type { ConsolePage } from "./types";

/**
 * Mount the console at /app.
 *
 * The wildcard is for client-side routing: the console owns everything under
 * /app, and a deep link must reach the same page rather than a 404.
 */
export const consolePlugin = (page: ConsolePage) =>
  new Elysia({ name: "console" }).get("/app", page).get("/app/*", page);

/**
 * What /app answers in a build without the console.
 *
 * Declared rather than omitted, so an operator running the headless image
 * learns that from the route instead of from a bare 404 that could mean
 * anything.
 */
export const noConsolePlugin = new Elysia({ name: "console:absent" })
  .get("/app", () => headlessNotice())
  .get("/app/*", () => headlessNotice());

const headlessNotice = () =>
  new Response("this build does not include the console; run `bun run dev` or the console image", {
    status: 404,
    headers: { "content-type": "text/plain" },
  });
