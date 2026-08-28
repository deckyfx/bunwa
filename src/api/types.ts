/**
 * Shared API types that would otherwise cause an import cycle.
 *
 * `ConsolePage` lives here rather than in server.ts because the console plugin
 * needs it and server.ts mounts the plugin.
 */

/** A Bun HTML import: a build instruction, not a value. */
export type ConsolePage = import("bun").HTMLBundle;
