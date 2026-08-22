/**
 * bunwa entry point.
 *
 * Configuration is validated before anything else starts, so a misconfigured
 * deployment fails immediately with a precise message rather than accepting
 * traffic it cannot serve.
 */
import { config, ConfigError } from "./config/env";
import { createServer } from "./api/server";
import { log } from "./observability/logger";

function main(): void {
  let cfg;
  try {
    cfg = config();
  } catch (err) {
    if (err instanceof ConfigError) {
      // Before logging is configured, so this goes straight to stderr.
      console.error(`configuration error: ${err.message}`);
      process.exit(78); // EX_CONFIG
    }
    throw err;
  }

  const server = createServer();
  log.info("bunwa started", { ...cfg.describe(), url: server.url.toString() });

  /** Drain in-flight requests before exiting, so a deploy drops nothing. */
  const shutdown = (signal: string): void => {
    log.info("shutting down", { signal });
    void server.stop(false).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main();
