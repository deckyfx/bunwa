/**
 * The live event stream, and the ticket that opens it.
 *
 * Two endpoints because `EventSource` cannot send headers, so the stream
 * cannot be authenticated the way every other route is
 * ([ADR-0008](../../../docs/adr/0008-sse-stream-tickets.md)). A ticket is
 * minted behind `x-api-key`, spent once by the stream, and worthless within a
 * minute.
 */
import { Elysia, sse, t } from "elysia";

import { problem } from "../server";

import { requireApiKey } from "../../auth/middleware";
import { subscribe } from "../../events/bus";
import { mintTicket, spendTicket } from "../../stores/stream-ticket-store";

/**
 * How long an idle stream may say nothing.
 *
 * Under the 60 seconds most proxies and load balancers use before closing an
 * idle connection, with room to spare for a slow hop.
 */
const HEARTBEAT_MS = 25_000;

export const eventRoutes = new Elysia({ prefix: "/v1" })
  .group("/events", (group) =>
    group
      /**
       * Mint a ticket for the stream.
       *
       * Behind the normal key check, because this is the only place the
       * environment can be established from something the caller proved rather
       * than something they asserted.
       */
      .use(requireApiKey)
      .post("/ticket", async ({ auth }) => {
        const minted = await mintTicket(auth.environmentId, auth.apiKeyId);
        return {
          ticket: minted.ticket,
          expiresAt: minted.expiresAt.toISOString(),
        };
      }),
  )
  /**
   * The stream itself.
   *
   * Outside the `requireApiKey` group deliberately: there is no key here, and
   * mounting it inside would reject every EventSource before the ticket was
   * ever read.
   *
   * A review has claimed that `requireApiKey`'s `as: "scoped"` leaks to this
   * route through the parent instance and rejects keyless requests anyway. It
   * does not. Proven twice: the integration test opens this route with a
   * ticket and no x-api-key and receives 200 with `event: stream.open`, and the
   * same thing was confirmed with curl against a running server. If that ever
   * stops being true the test fails, which is the right place to find out.
   */
  /**
   * The stream, with the ticket spent before the generator starts.
   *
   * `guard` + `resolve` rather than a check inside the handler: a generator
   * cannot set a status and return a problem document, and Elysia only streams
   * a handler that *is* a generator — an async handler returning an iterator
   * comes back 200 with an empty body, which looks connected and delivers
   * nothing.
   */
  .guard(
    { query: t.Object({ ticket: t.String({ minLength: 1 }) }) },
    (guarded) =>
      guarded
        .resolve(async ({ query, status, path }) => {
          const claims = await spendTicket(query.ticket);
          if (claims === null) {
            // One answer for expired, spent and unknown alike. Distinguishing
            // them tells an attacker which guesses were close.
            // Built by the shared helper rather than by hand, so this
            // matches every other error the API emits. The literal here had
            // drifted already: no `instance`, which is the field that tells a
            // caller *which* request failed, and it is the one error most
            // likely to be read in isolation because the stream is opened by
            // an EventSource with no surrounding request to correlate it to.
            return status(401, problem(401, "invalid-ticket", "Unauthorized", "the ticket is not valid", path));
          }
          // Subscribed here, not in the generator.
          //
          // A generator body does not run until the first pull, so subscribing
          // inside it left a window between the response being returned and
          // the client reading it — events published in that window went to a
          // bus with no subscriber and were lost. Real, not just a test
          // artefact: it is small over a socket and wide whenever the consumer
          // is slow to start reading.
          return { claims, subscription: subscribe(claims.environmentId) };
        })
        .get("/events/stream", async function* ({ claims, subscription }) {
          try {
            // Said explicitly, so a console can show "live" from something the
            // server sent rather than from the absence of an error.
            yield sse({ event: "stream.open", data: { environmentId: claims.environmentId } });

            // Driven by hand rather than `for await`, so an idle stream can
            // still say something.
            //
            // A quiet subscription yielded nothing at all, and an intermediary
            // that times an idle connection out closes it — the console then
            // treats a healthy server as a dropped stream, mints a fresh
            // ticket and reconnects, on a loop, for as long as nothing
            // happens. Which is most of the time on a small deployment.
            //
            // The pending `next()` is held across ticks rather than re-asked
            // for. Racing a fresh `next()` against the timer each time would
            // abandon the previous one, and an event delivered to an abandoned
            // reader is an event nobody receives.
            const events = subscription.events[Symbol.asyncIterator]();
            let pending = events.next();
            for (;;) {
              const settled = await Promise.race([
                pending.then((result) => ({ kind: "event" as const, result })),
                Bun.sleep(HEARTBEAT_MS).then(() => ({ kind: "tick" as const })),
              ]);

              if (settled.kind === "tick") {
                // A named event rather than a bare comment: it reaches only a
                // listener that asked for it, so a console that ignores it is
                // unaffected while the bytes still keep the connection open.
                yield sse({ event: "stream.ping", data: {} });
                continue;
              }

              if (settled.result.done === true) break;
              yield sse({
                event: settled.result.value.type,
                id: settled.result.value.id,
                data: settled.result.value,
              });
              pending = events.next();
            }

            // Why it ended. A console that overflowed has missed events and
            // must refetch rather than assume it is current.
            if (subscription.reason() === "overflow") {
              yield sse({
                event: "stream.overflow",
                data: { reason: "too far behind; refetch and reconnect" },
              });
            }
          } finally {
            // Runs on abort, on return, and when the server ends the response,
            // so the bus stops filling a queue for a reader that has gone.
            subscription.close();
          }
        }),
  );
