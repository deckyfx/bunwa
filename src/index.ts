/**
 * bunwa entry point.
 *
 * Configuration is validated before anything else starts, so a misconfigured
 * deployment fails immediately with a precise message rather than accepting
 * traffic it cannot serve.
 */
import { config, ConfigError, type Config } from "./config/env";
import { createServer } from "./api/server";
import type { ConsolePage } from "./api/types";
import { MigrationManager } from "./db/migration-manager";
import { startWorker } from "./delivery/worker";
import { EngineRegistry } from "./engine/registry";
import { BaileysAdapter } from "./engine/baileys/adapter";
import { startEngineConsumer } from "./engine/consumer";
import { startHousekeeping } from "./ops/housekeeping";
import { log } from "./observability/logger";

/** How long to let in-flight requests finish before closing connections. */
const SHUTDOWN_DRAIN_MS = 10_000;

async function main(consolePage?: ConsolePage): Promise<void> {
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

  // Baileys is the engine. gowa was engine #1 through stages 0-4 and is gone:
  // ADR-0002 kept it as a failover, and that stopped being worth its weight
  // once the pivot was committed — two engines is insurance only while both
  // are maintained, and nothing was maintaining the adapter.
  //
  // Capacity is bounded because one process holding every device is the blast
  // radius ADR-0003 exists to avoid. That reasoning changed shape rather than
  // going away: these sockets share this process, so the bound is on sockets
  // rather than on containers.
  const registry = new EngineRegistry();

  if (cfg.baileysEnabled) {
    // The only engine now. Still behind a flag rather than unconditional: it
    // has never paired a real device, and a deployment should choose that
    // rather than be upgraded into it.
    registry.register({
      id: "baileys-1",
      kind: "baileys",
      capacity: cfg.enginePoolCapacity,
      engine: new BaileysAdapter(),
    });
    log.info("baileys engine registered", { capacity: cfg.enginePoolCapacity });
  }

  if (registry.list().length === 0) {
    // Said once, loudly. A server with no engine answers /health and every
    // read, then fails only when someone tries to pair — which reads as a
    // pairing bug rather than a deployment that was never given an engine.
    log.warn("no engine is configured; pairing will be refused (set BAILEYS_ENABLED and CREDENTIAL_ENCRYPTION_KEY)");
  }

  // Engine events reach the control plane only through this. Without it a
  // paired device's binding would stay pending for ever and no lifecycle event
  // would ever reach a tenant.
  const stopConsumers = registry.list().map((pool) => startEngineConsumer(pool.engine));

  const server = createServer(registry, consolePage);
  // In-process for now; moving it out is the same trigger as moving off SQLite.
  // Sweeps that nothing else owns: expired idempotency keys, closed rate-limit
  // windows, and — the one that matters — sends accepted but never
  // acknowledged, which is how a silent delivery failure becomes an event
  // rather than a customer complaint.
  const stopHousekeeping = startHousekeeping();

  const stopWorker = startWorker({ allowInsecure: cfg.allowInsecureWebhookTargets });
  log.info("bunwa started", { ...cfg.describe(), url: server.server?.url.toString() });

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
    //
    // Bounded: server.stop(false) waits indefinitely for in-flight requests, so
    // one stuck handler would block every later step and the process would
    // never exit. After the deadline, close connections and move on.
    await Promise.race([
      server.stop(false),
      Bun.sleep(SHUTDOWN_DRAIN_MS).then(() => {
        log.warn("drain deadline reached; closing remaining connections", { afterMs: SHUTDOWN_DRAIN_MS });
        return server.stop(true);
      }),
    ]);

    // allSettled, not all: one consumer failing to stop must not skip the
    // worker, the engines and the exit, leaving the process alive with
    // everything open and no way for a later signal to retry.
    for (const result of await Promise.allSettled(stopConsumers.map((stop) => stop()))) {
      if (result.status === "rejected") log.warn("engine consumer failed to stop", { error: String(result.reason) });
    }
    await stopHousekeeping().catch((err: unknown) => {
      log.warn("housekeeping failed to stop", { error: err instanceof Error ? err.message : String(err) });
    });
    await stopWorker().catch((err: unknown) => {
      log.warn("delivery worker failed to stop", { error: err instanceof Error ? err.message : String(err) });
    });
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

export { main };
