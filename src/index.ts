/**
 * bunwa entry point.
 *
 * Configuration is validated before anything else starts, so a misconfigured
 * deployment fails immediately with a precise message rather than accepting
 * traffic it cannot serve.
 */
import { config, ConfigError, type Config } from "./config/env";
import { createServer } from "./api/server";
import { MigrationManager } from "./db/migration-manager";
import { startWorker } from "./delivery/worker";
import { log } from "./observability/logger";

async function main(): Promise<void> {
  let cfg: Config;
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

  // Before accepting traffic: verify the database matches this build, and in
  // development apply what is missing. Production refuses to start instead —
  // an unattended schema change is not something a deploy should decide.
  await MigrationManager.init();

  const server = createServer();
  // In-process for now; moving it out is the same trigger as moving off SQLite.
  const stopWorker = startWorker({ allowInsecure: cfg.allowInsecureWebhookTargets });
  log.info("bunwa started", { ...cfg.describe(), url: server.url.toString() });

  /** Drain in-flight requests before exiting, so a deploy drops nothing. */
  const shutdown = (signal: string): void => {
    log.info("shutting down", { signal });
    // The worker is stopped first so a pass in flight is not interrupted
    // mid-attempt; anything unfinished is still queued and resumes next start.
    stopWorker();
    void server.stop(false).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

await main();
