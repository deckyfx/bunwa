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
import { BaileysAdapter } from "./engine/baileys/adapter";
import { GowaAdapter } from "./engine/gowa/adapter";
import { startEngineConsumer } from "./engine/consumer";
import { startHousekeeping } from "./ops/housekeeping";
import { log } from "./observability/logger";

/** How long to let in-flight requests finish before closing connections. */
const SHUTDOWN_DRAIN_MS = 10_000;

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

  // Registration order is preference order: the pairing route asks the registry
  // for capacity without naming an engine, so what a deployment registers, and
  // in what sequence, is the whole of the choice. gowa first while it is the
  // proven one; ADR-0002 keeps it registered even after Baileys works, because
  // two engines is the failover.
  //
  // Capacity is bounded because a process holding every device is the blast
  // radius ADR-0003 exists to avoid.
  const registry = new EngineRegistry();
  if (cfg.gowaBaseUrl !== null) {
    registry.register({
      id: "gowa-1",
      kind: "gowa",
      capacity: cfg.enginePoolCapacity,
      engine: new GowaAdapter({ baseUrl: cfg.gowaBaseUrl }),
    });
  }

  if (cfg.baileysEnabled) {
    // Registered after gowa, so gowa is preferred while it is the proven one —
    // registration order is preference order. ADR-0002 keeps both: two working
    // engines is the failover, and it costs one directory.
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
    log.warn("no engine is configured; pairing will be refused (set GOWA_BASE_URL, or BAILEYS_ENABLED with CREDENTIAL_ENCRYPTION_KEY)");
  }

  // Engine events reach the control plane only through this. Without it a
  // paired device's binding would stay pending for ever and no lifecycle event
  // would ever reach a tenant.
  const stopConsumers = registry.list().map((pool) => startEngineConsumer(pool.engine));

  const server = createServer(registry);
  // In-process for now; moving it out is the same trigger as moving off SQLite.
  // Sweeps that nothing else owns: expired idempotency keys, closed rate-limit
  // windows, and — the one that matters — sends accepted but never
  // acknowledged, which is how a silent delivery failure becomes an event
  // rather than a customer complaint.
  const stopHousekeeping = startHousekeeping();

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

await main();
