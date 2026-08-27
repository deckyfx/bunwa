/**
 * HTTP surface.
 *
 * Stage 1.1 is the skeleton: correlation-id propagation, structured request
 * logging, RFC 9457 error responses, and the two probes an orchestrator needs.
 * Tenancy and messaging routes arrive in 1.3 and 1.5.
 */
import { Elysia } from "elysia";
import { sql } from "drizzle-orm";

import { config } from "../config/env";
import { db } from "../db";
import { PRESSURE_GUIDANCE, busyRetryTotal, samplePressure } from "../ops/pressure";
import { adminRoutes } from "./routes/admin";
import { deviceRoutes } from "./routes/devices";
import { messageRoutes } from "./routes/messages";
import { ruleRoutes } from "./routes/rules";
import { eventRoutes } from "./routes/events";
import { chatRoutes } from "./routes/chat";
import { createStaticHandler } from "./static";
import { projectRoutes } from "./routes/project";
import type { EngineRegistry } from "../engine/registry";
import { AuthError } from "../auth/middleware";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "../stores/errors";
import { log, withContext, sanitiseCorrelationId } from "../observability/logger";

/** Process start, used to report uptime on the liveness probe. */
const startedAt = Date.now();

/** RFC 9457 problem details. Every error response has this shape. */
export interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  correlationId?: string;
}

/**
 * Build a problem document.
 *
 * Centralised so every error leaves by the same shape: a stable `type` URI a
 * client can branch on, and the correlation id that joins the caller's report
 * to the logs. Handlers that construct their own bodies drift, and the drift is
 * only discovered by whoever is integrating at the time.
 */
export function problem(status: number, type: string, title: string, detail?: string, instance?: string, correlationId?: string): Problem {
  return {
    type: `https://bunwa.dev/errors/${type}`,
    title,
    status,
    ...(detail === undefined ? {} : { detail }),
    ...(instance === undefined ? {} : { instance }),
    ...(correlationId === undefined ? {} : { correlationId }),
  };
}

/**
 * Check that the database answers.
 *
 * Deliberately a real round trip rather than a connection-pool status: a pool
 * can hold handles to a database that stopped responding, which is exactly the
 * failure a readiness probe exists to catch.
 */
async function databaseReady(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const began = performance.now();
  try {
    db().all(sql`select 1`);
    return { ok: true, latencyMs: Math.round(performance.now() - began) };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Math.round(performance.now() - began),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Build the application. Exported unstarted so tests can drive it directly.
 *
 * The engine registry is optional: most routes never touch an engine, and
 * requiring one would make every HTTP test stand up a fake.
 */
export function createApp(registry?: EngineRegistry) {
  return new Elysia()
    // Correlation id first, so every later hook and handler logs under it.
    .derive({ as: "global" }, ({ request, set }) => {
      const supplied = sanitiseCorrelationId(request.headers.get("x-correlation-id"));
      const correlationId = supplied ?? crypto.randomUUID();
      set.headers["x-correlation-id"] = correlationId;
      return { correlationId };
    })

    .onError({ as: "global" }, ({ code, error, set, path, request, correlationId }) => {
      // `derive` does not run for an unmatched route, so a 404 would otherwise
      // carry no correlation id at all — in the body or the response header —
      // and be the one class of error nobody can trace.
      const id =
        typeof correlationId === "string"
          ? correlationId
          : (sanitiseCorrelationId(request.headers.get("x-correlation-id")) ?? crypto.randomUUID());
      set.headers["x-correlation-id"] = id;
      if (code === "NOT_FOUND") {
        set.status = 404;
        return problem(404, "not-found", "Not found", undefined, path, id);
      }
      if (code === "VALIDATION") {
        set.status = 400;
        return problem(400, "invalid-request", "Request failed validation", String(error), path, id);
      }
      // Store and auth errors carry their own status. Mapped by type rather
      // than by message text, which drifts the moment a message is reworded.
      if (error instanceof AuthError) {
        set.status = error.status;
        // Retry-After on a 429 tells a caller when to come back. Without it a
        // client that is looping simply loops faster against the refusal.
        for (const [name, value] of Object.entries(error.headers ?? {})) set.headers[name] = value;
        return problem(error.status, error.type, error.title, error.detail, path, id);
      }
      if (error instanceof ValidationError) {
        set.status = 422;
        return problem(422, "invalid-request", "Request is not valid", error.message, path, id);
      }
      if (error instanceof ConflictError) {
        set.status = 409;
        return problem(409, "conflict", "Conflict", error.message, path, id);
      }
      if (error instanceof UnavailableError) {
        set.status = 503;
        set.headers["retry-after"] = String(error.retryAfterSeconds);
        return problem(503, "unavailable", "Service Unavailable", error.message, path, id);
      }
      if (error instanceof NotFoundError) {
        // 404 rather than 403 for something that exists but is not yours:
        // distinguishing them leaks the existence of other tenants' data.
        set.status = 404;
        return problem(404, "not-found", "Not found", error.message, path, id);
      }
      log.error("unhandled request error", error, { path });
      set.status = 500;
      // The message is deliberately not echoed: it may carry internal detail.
      // The correlation id is how the caller and the logs are joined instead.
      return problem(500, "internal", "Internal server error", undefined, path, id);
    })

    /**
     * Liveness. Answers only "is this process running?" — no dependency checks,
     * because a liveness probe that fails on a database blip gets the container
     * restarted for a fault a restart cannot fix.
     */
    .get("/health", () => ({
      status: "ok" as const,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    }))

    /**
     * The four numbers that say when this architecture stops coping.
     *
     * Unauthenticated like the probes, and for the same reason: an operator
     * reaching for it during an incident should not need a credential, and it
     * exposes counts rather than content — no tenant names, no numbers, no
     * message bodies. Not on the project API, because it is about the
     * deployment rather than about any tenant.
     */
    .get("/metrics", async () => {
      // Deliberately non-destructive. This endpoint is unauthenticated, and
      // resetting the contention window here let any caller — a second
      // scraper, a health check, anyone — clear the count between samples and
      // keep the reported rate near zero while contention was real. The window
      // rolls on elapsed time inside samplePressure instead.
      const pressure = await samplePressure();
      return { pressure, guidance: PRESSURE_GUIDANCE, busyRetriesTotal: busyRetryTotal() };
    })

    /** Readiness. Answers "can this process serve traffic?", dependencies included. */
    .get("/readyz", async ({ set }) => {
      const database = await databaseReady();
      if (!database.ok) {
        set.status = 503;
        set.headers["retry-after"] = "5";
        log.warn("readiness check failed", { component: "database", error: database.error });
      }
      return {
        status: database.ok ? ("ready" as const) : ("not_ready" as const),
        // The driver's message names the host, port, database and role. It goes
        // to the log above; an unauthenticated probe gets the verdict only.
        checks: { database: { ok: database.ok, latencyMs: database.latencyMs } },
      };
    })

    // Route plugins mount after the probes. An orchestrator's liveness and
    // readiness checks must never be able to end up behind a plugin's auth.
    .use(projectRoutes)
    .use(eventRoutes)
    .use(chatRoutes)
    .use(registry === undefined ? new Elysia() : deviceRoutes(registry))
    .use(registry === undefined ? new Elysia() : messageRoutes(registry))
    .use(ruleRoutes)


    // Mounted only when explicitly enabled. The admin surface has no
    // authentication yet, so it must not be reachable by default — an
    // unauthenticated key-minting endpoint is not something to leave to a
    // reverse proxy's configuration.
    .use(config().adminApiEnabled ? adminRoutes : new Elysia());
}

/** Wrap the app so every request runs inside a logging context. */
export function createServer(registry?: EngineRegistry) {
  const app = createApp(registry);
  const cfg = config();
  // Null in the api image, where the console was never copied in. Resolved
  // once: whether the files exist cannot change while the process runs.
  const serveConsole = createStaticHandler();

  return Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    fetch(request) {
      const correlationId = sanitiseCorrelationId(request.headers.get("x-correlation-id")) ?? crypto.randomUUID();
      const began = performance.now();
      const url = new URL(request.url);

      // The resolved id is written back onto the request before handing it to
      // the app, so `derive()` adopts it instead of minting a second one.
      // Without this the log carried one id and the response header another,
      // which quietly voids the entire point of having a correlation id.
      const headers = new Headers(request.headers);
      headers.set("x-correlation-id", correlationId);
      const identified = new Request(request, { headers });

      // Static assets before the app, and outside it: they are not API routes,
      // they carry no tenancy, and running them through the auth middleware
      // would mean the console could not load the page that asks for a key.
      if (serveConsole !== null && (url.pathname === "/app" || url.pathname.startsWith("/app/"))) {
        return withContext({ correlationId }, async () => {
          const asset = await serveConsole(identified);
          return asset ?? new Response("Not found", { status: 404 });
        });
      }

      return withContext({ correlationId }, async () => {
        const response = await app.handle(identified);
        // Probes are logged at debug so a one-second orchestrator interval does
        // not bury the traffic that matters.
        const level = url.pathname === "/health" || url.pathname === "/readyz" ? "debug" : "info";
        log[level]("request", {
          method: request.method,
          path: url.pathname,
          status: response.status,
          durationMs: Math.round(performance.now() - began),
        });
        return response;
      });
    },
  });
}

/**
 * The server's shape, for the dashboard to import.
 *
 * Eden Treaty turns this into a fully-typed client with no code generation and
 * no schema to keep in sync — a route that changes signature becomes a compile
 * error in the dashboard rather than a 400 discovered by a user. That property
 * is the reason [03](../../docs/03-architecture.md) chose Elysia at all, and it
 * only holds if the type is actually exported, which until now it was not.
 *
 * Derived from createApp rather than declared, so it cannot drift from what the
 * server really serves.
 */
export type App = ReturnType<typeof createApp>;
