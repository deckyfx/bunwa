/**
 * Startup, shared by both entry points.
 *
 * Exports rather than runs: importing it used to start a server as a side
 * effect. src/index.ts and src/index-headless.ts each call main() with or
 * without the console page.
 *
 * Named boot.ts rather than index.ts because index.ts is what `bun run` and
 * the Dockerfile CMD reach for. Leaving the exporting module at that path
 * meant `bun run src/index.ts` exited 0 immediately and served nothing — the
 * container started, reported success and answered nothing.
 */
import { config, ConfigError, type Config } from "./config/env";
import { createServer } from "./api/server";
import type { ConsolePage } from "./api/types";
import { MigrationManager } from "./db/migration-manager";
import { resetBus } from "./events/bus";
import { startWorker } from "./delivery/worker";
import { EngineRegistry } from "./engine/registry";
import { BaileysAdapter } from "./engine/baileys/adapter";
import { startEngineConsumer } from "./engine/consumer";
import { startHousekeeping } from "./ops/housekeeping";
import { log } from "./observability/logger";
import { currentLogFile } from "./observability/sinks";
import { ensureBootstrap } from "./ops/bootstrap";
import { issueSetupToken } from "./api/routes/setup";
import { SettingsStore } from "./stores/settings-store";

/** How long to let in-flight requests finish before closing connections. */
const SHUTDOWN_DRAIN_MS = 10_000;

/**
 * Start the process: validate config, migrate, register the engine, serve, and
 * then wait for a signal.
 *
 * Takes the console page as an argument rather than importing it, so the
 * headless entry point never pulls React in to serve a route it does not
 * mount — and so neither entry point owns a copy of this sequence. Both are
 * two lines over this function.
 */
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
  // The file this line landed in is named in the line itself, so someone
  // handed a log excerpt can find the rest of it.
  log.info("bunwa started", { ...cfg.describe(), logFile: currentLogFile(), url: server.server?.url.toString() });

  // After the started line, so an operator reading a fresh log sees the
  // instance come up and then what it wants from them, in that order.
  const instance = await ensureBootstrap();
  if (instance.configured) {
    log.info("instance is configured", {
      apiKeySource: instance.apiKeySource,
      instanceName: SettingsStore.instanceName(),
    });
  } else {
    // Printed rather than logged through the structured path as well, because
    // this is the one line the operator must actually read, and it is easy to
    // lose among request lines on a busy start.
    const token = issueSetupToken();
    log.warn("this instance has no API key yet; open the console to finish setup");
    process.stdout.write(`\n  setup token: ${token}\n  open ${server.server?.url.toString() ?? "the console"} to finish setup\n\n`);
  }

  /** Drain in-flight requests before exiting, so a deploy drops nothing. */
  // Idempotent: two signals in quick succession must not run this twice and
  // race each other to process.exit.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutting down", { signal });

    // Every step below is best-effort, and the exit is not.
    //
    // Three of them already had their own catch — the engine one says why:
    // "a rejected close with shutdown already marked in progress would leave
    // it hung with no way for a later signal to recover it." The first step
    // did not. If `server.stop()` rejected, this function rejected, the
    // rejection was swallowed by the `void` at the call site, and
    // process.exit(0) was never reached — with `shuttingDown` already true, so
    // every later SIGINT returned immediately and the process could not be
    // killed. The same unkillable process this file was written to fix,
    // through the one door left open.
    //
    // A finally rather than a fourth catch: the guarantee is "this function
    // exits the process", and that should not depend on remembering to wrap
    // each new step someone adds above it.
    try {
      await drain();
    } finally {
      process.exit(0);
    }
  };

  /** Everything that has to be given a chance to finish before the exit. */
  const drain = async (): Promise<void> => {
    // Order matters. Stop accepting requests first: closing engines while
    // traffic is still arriving fails those requests for no reason. Then drain
    // the delivery pass in flight — anything unfinished stays queued and
    // resumes next start, but a half-written attempt does not — and only then
    // release the engines.
    //
    // Bounded: server.stop(false) waits indefinitely for in-flight requests, so
    // one stuck handler would block every later step and the process would
    // never exit. After the deadline, close connections and move on.
    //
    // The event bus goes first, and this is the difference between exiting in a
    // second and waiting out the deadline.
    //
    // An open SSE stream is an in-flight request that never finishes on its
    // own: the handler is parked on the bus, and server.stop(false) waits for
    // it. Closing the bus ends every subscription, so each stream's loop
    // finishes, clears its heartbeat interval and completes its response.
    // Without it a single console tab made every shutdown take ten seconds and
    // look like a hang — Ctrl-C did nothing visible, so it read as one.
    resetBus();

    // `stopped` rather than relying on the race alone. Promise.race settles on
    // the first branch but does not cancel the other, so the sleep still
    // resolves later — and without this flag a shutdown whose remaining steps
    // outlast the deadline logged "drain deadline reached" and forced the
    // connections closed on a server that had already stopped cleanly. A
    // warning that fires after a successful drain is worse than no warning: it
    // is the log line an operator would reach for to explain a hang that did
    // not happen.
    //
    // Both branches are discarded to void because createServer returns one of
    // two app types — with the console or without — and the race has no reason
    // to reconcile them.
    let stopped = false;
    await Promise.race<void>([
      server.stop(false).then(() => {
        stopped = true;
      }),
      Bun.sleep(SHUTDOWN_DRAIN_MS).then(async () => {
        if (stopped) return;
        log.warn("drain deadline reached; closing remaining connections", { afterMs: SHUTDOWN_DRAIN_MS });
        await server.stop(true);
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
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

export { main };
