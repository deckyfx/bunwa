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
import { adminRoutes } from "./routes/admin";
import { projectRoutes } from "./routes/project";
import { AuthError } from "../auth/middleware";
import { ConflictError, NotFoundError, ValidationError } from "../stores/errors";
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

/** Build the application. Exported unstarted so tests can drive it directly. */
export function createApp() {
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

    .use(projectRoutes)

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

    // Mounted only when explicitly enabled. The admin surface has no
    // authentication yet, so it must not be reachable by default — an
    // unauthenticated key-minting endpoint is not something to leave to a
    // reverse proxy's configuration.
    .use(config().adminApiEnabled ? adminRoutes : new Elysia());
}

/** Wrap the app so every request runs inside a logging context. */
export function createServer() {
  const app = createApp();
  const cfg = config();

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
