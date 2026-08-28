/**
 * Shared API types that would otherwise cause an import cycle.
 *
 * `ConsolePage` lives here rather than in server.ts because the console plugin
 * needs it and server.ts mounts the plugin.
 */

/** A Bun HTML import: a build instruction, not a value. */
export type ConsolePage = import("bun").HTMLBundle;

/**
 * Which shape of the server is running.
 *
 * Not something to detect by sniffing: it is decided by which entry point ran
 * — `src/index.ts` imports the console page, `src/index-headless.ts` does not
 * — and the honest way to expose it is to carry the fact rather than infer it.
 * Anything that inferred it later (looking for a route, probing /app) would be
 * guessing at something already known for certain at construction.
 */
export type ServerMode = "console" | "headless";
