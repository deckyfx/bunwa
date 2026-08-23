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
import { EngineRegistry } from "./engine/registry";
import { GowaAdapter } from "./engine/gowa/adapter";
import { startEngineConsumer } from "./engine/consumer";
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

  // One gowa pool for now. Capacity is bounded because a process holding every
  // device is the blast radius ADR-0003 exists to avoid.
  const registry = new EngineRegistry();
  if (cfg.gowaBaseUrl !== null) {
    registry.register({
      id: "gowa-1",
      kind: "gowa",
      capacity: cfg.enginePoolCapacity,
      engine: new GowaAdapter({ baseUrl: cfg.gowaBaseUrl }),
    });
  }

  // Engine events reach the control plane only through this. Without it a
  // paired device's binding would stay pending for ever and no lifecycle event
  // would ever reach a tenant.
  const stopConsumers = registry.list().map((pool) => startEngineConsumer(pool.engine));

  const server = createServer(registry);
  // In-process for now; moving it out is the same trigger as moving off SQLite.
  const stopWorker = startWorker({ allowInsecure: cfg.allowInsecureWebhookTargets });
  log.info("bunwa started", { ...cfg.describe(), url: server.url.toString() });

  /** Drain in-flight requests before exiting, so a deploy drops nothing. */
  // Idempotent: two signals in quick succession must not run this twice and
  // race each other to process.exit.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });
    // Await the delivery pass in flight before the server: anything unfinished
    // stays queued and resumes next start, but a half-written attempt does not.
    // Order matters. Stop accepting requests first: closing engines while
    // traffic is still arriving fails those requests for no reason. Then drain
    // the delivery pass in flight, then release the engines.
    await server.stop(false);
    await Promise.all(stopConsumers.map((stop) => stop()));
    await stopWorker();
    // Engine cleanup must not be able to prevent the process exiting — a
    // rejected close with shutdown already marked in progress would leave it
    // hung with no way for a later signal to recover it.
    await registry.closeAll().catch((err: unknown) => {
      log.warn("engine cleanup failed during shutdown", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

await main();
