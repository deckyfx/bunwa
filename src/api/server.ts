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
import { consolePlugin, noConsolePlugin } from "./console-plugin";
import type { ConsolePage, ServerMode } from "./types";
import { projectRoutes } from "./routes/project";
import { setupRoutes } from "./routes/setup";
import { EngineRegistry } from "../engine/registry";
import { AuthError } from "../auth/middleware";
import { ConflictError, NotFoundError, UnavailableError, ValidationError } from "../stores/errors";
import { enterContext, log, sanitiseCorrelationId } from "../observability/logger";
import { currentLogFile } from "../observability/sinks";

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
 * Build the application, without the console. Exported unstarted so tests can
 * drive it directly.
 *
 * The engine registry is optional: most routes never touch an engine, and
 * requiring one would make every HTTP test stand up a fake.
 *
 * The console page is not a parameter here. `createConsoleApp` adds it, so
 * nothing in this path imports the page and a headless build never pulls React
 * in to serve a route it does not mount.
 */
export function createApp(registry?: EngineRegistry, mode: ServerMode = "headless") {
  const app = new Elysia()
    /*
     * The running shape, on the context.
     *
     * `decorate` rather than `state`: this is fixed for the life of the
     * process, and `store` is for things that change. A handler reads it as
     * `({ serverMode })` and needs no import, which matters for the handlers
     * whose correct answer differs between the two builds — a 404 that says
     * "this build has no console" is only right in one of them.
     */
    .decorate("serverMode", mode)

    /*
     * Elysia's own lifecycle, rather than a log line after `listen()` returns.
     *
     * `onStart` fires with the server that is actually bound, so the address
     * logged is the one in use rather than the one requested — they differ
     * whenever the port is 0, or the host resolves to something other than
     * what was configured. The previous version read `server.server?.url`
     * after the fact and printed `undefined` if anything about the bind was
     * unusual, which is exactly when the line matters.
     *
     * It also means the line cannot be forgotten by a second entry point: it
     * belongs to the app, not to whoever started it.
     */
    .onStart(({ server }) => {
      log.info("bunwa started", {
        mode,
        console: mode === "console" ? "/app" : "(not served)",
        url: server?.url.href ?? `http://${config().host}:${String(config().port)}/`,
        ...config().describe(),
        logFile: currentLogFile(),
      });
    })

    .onStop(() => {
      // Paired with onStart deliberately. Shutdown was logged from boot's
      // signal handler, so a stop that happened any other way — a failed
      // bind, a test tearing the app down — left no record that the server
      // had gone.
      log.info("bunwa stopped", { mode });
    })

    // Correlation id first, so every later hook and handler logs under it.
    .derive({ as: "global" }, ({ request, set }) => {
      const supplied = sanitiseCorrelationId(request.headers.get("x-correlation-id"));
      const correlationId = supplied ?? crypto.randomUUID();
      set.headers["x-correlation-id"] = correlationId;

      // enterWith rather than the callback form of withContext: there is no
      // wrapper function to hang it on now that Elysia owns the server, and
      // the id has to reach every log line the handler produces. Without it
      // the header carried an id the logs never mentioned.
      enterContext({ correlationId });

      // Start time for the request log below. Held on the store rather than a
      // module variable: two requests overlap constantly, and a shared one
      // would time whichever finished last.
      return { correlationId, began: performance.now() };
    })

    // One line per request, restored as a hook.
    //
    // It lived in a hand-rolled Bun.serve fetch wrapper, and moving to
    // Elysia's own listen() removed the wrapper and the logging with it —
    // the server ran, served correctly, and said nothing about any request.
    //
    // Health probes at debug: an orchestrator hits them every few seconds and
    // they would otherwise be the only thing anyone ever reads.
    .onAfterResponse({ as: "global" }, ({ request, set, path, began }) => {
      const level = path === "/health" || path === "/readyz" ? "debug" : "info";
      log[level]("request", {
        method: request.method,
        path,
        status: typeof set.status === "number" ? set.status : 200,
        // `began` comes from `derive`, which does not run for an unmatched
        // route — the same gap the 404 correlation id below exists for. The
        // subtraction was therefore NaN on every 404, and `Math.round(NaN)` is
        // NaN, so the one request class most worth timing logged a duration no
        // dashboard could read. Null says "not measured", which is true.
        durationMs: typeof began === "number" ? Math.round(performance.now() - began) : null,
      });
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

      // Entered here as well as in `derive`, for the same reason the id is
      // recovered above: `derive` never ran for an unmatched route, so nothing
      // had put this id into the logging context. The header and the body
      // carried it and every log line this handler produced was written under
      // a different id — or none — which is precisely the trace the fallback
      // above exists to preserve. Re-entering with an id already in context is
      // a no-op, so the matched-route path is unaffected.
      enterContext({ correlationId: id });
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
    .get("/health", ({ serverMode }) => ({
      status: "ok" as const,
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      // Reported because "is the console being served?" is otherwise answered
      // by probing /app and interpreting a 404, and an operator debugging a
      // blank page needs to know which image is running before anything else.
      mode: serverMode,
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
    //
    // Setup comes first because it is the one surface that answers before a
    // credential exists; everything below it requires one.
    .use(setupRoutes)
    .use(projectRoutes)
    .use(eventRoutes)
    .use(chatRoutes)
    // The console, in the same Elysia app. One origin, so the browser's Eden
    // client is typed against the very app that answers it and there is no
    // proxy to keep in step — the console was briefly a second Elysia on
    // another port, and the two drifted within a day.
    .use(noConsolePlugin)
    // Mounted unconditionally, with an empty registry when none was supplied.
    //
    // The ternary here made `App` the union of "these routes exist" and "they
    // do not", so Eden could not see them at all and the console's typed
    // client lost every device and message call. An empty registry already
    // answers correctly — chooseAny throws EngineError and the route returns
    // 503, which is a truer answer than the 404 an absent route gave.
    .use(deviceRoutes(registry ?? new EngineRegistry()))
    .use(messageRoutes(registry ?? new EngineRegistry()))
    .use(ruleRoutes)


    // Mounted unconditionally; the plugin enforces the flag itself. A
    // conditional mount made the app type a union of "these routes exist" and
    // "they do not", which is how Eden lost every device and message call
    // once already — and had lost `admin` entirely for the console.
    .use(adminRoutes);

  return app;
}

/**
 * Build the app and start listening.
 *
 * Picks the console or headless shape from whether a page was supplied, which
 * is the whole of the difference between the two entry points.
 *
 * It used to wrap the app so every request ran inside a logging context, and
 * the comment outlived the wrapper: the `derive` hook above enters the context
 * now. A comment describing a mechanism that has moved sends the next reader
 * looking for it here.
 */
export function createServer(registry?: EngineRegistry, consolePage?: ConsolePage) {
  const cfg = config();
  const app = consolePage === undefined ? createApp(registry) : createConsoleApp(registry, consolePage);

  return app.listen({ port: cfg.port, hostname: cfg.host });
}

/**
 * The API without the console.
 *
 * What `bun run start:headless` serves. /app answers a 404 that says which
 * build this is, rather than being absent.
 *
 * Derived from `createApp` rather than declared, so it cannot drift from what
 * the server really serves. Eden Treaty turns it into a fully-typed client
 * with no code generation and no schema to keep in sync — a route that changes
 * signature becomes a compile error in the console rather than a 400 found by
 * a user, which is the reason [03](../../docs/03-architecture.md) chose Elysia
 * at all, and it only holds if the type is actually exported.
 */
export type HeadlessApp = ReturnType<typeof createApp>;

/**
 * The API with the console mounted.
 *
 * What `bun run start` serves, and what the browser's Eden client is typed
 * against — the console only ever talks to a server that is serving it.
 *
 * Two concrete types rather than a union. `treaty<HeadlessApp | ConsoleApp>`
 * would narrow to what both have in common, which loses routes instead of
 * describing them: a union is the wrong tool for "one of these two shapes,
 * and the caller knows which".
 */
export type ConsoleApp = ReturnType<typeof createConsoleApp>;

/**
 * The app a build with the console uses.
 *
 * Separate function rather than an argument, because a conditional mount makes
 * the return type a union of "mounted" and "not mounted" — which is exactly
 * how the device and message routes became invisible to Eden and the console's
 * typed client silently lost every device call.
 */
export function createConsoleApp(registry: EngineRegistry | undefined, consolePage: ConsolePage) {
  return createApp(registry, "console").use(consolePlugin(consolePage));
}

/** The shape the console imports. Kept as `App` so callers need not choose. */
export type App = ConsoleApp;
