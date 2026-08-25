/**
 * The live event stream, and the ticket that opens it.
 *
 * Two endpoints because `EventSource` cannot send headers, so the stream
 * cannot be authenticated the way every other route is
 * ([ADR-0008](../../../docs/adr/0008-sse-stream-tickets.md)). A ticket is
 * minted behind `x-api-key`, spent once by the stream, and worthless within a
 * minute.
 */
import { Elysia, t } from "elysia";

import { requireApiKey } from "../../auth/middleware";
import { subscribe } from "../../events/bus";
import { mintTicket, spendTicket } from "../../stores/stream-ticket-store";
import { log } from "../../observability/logger";
import { problem } from "../server";

/**
 * How often to send a comment line when nothing is happening.
 *
 * A proxy that sees no bytes closes an idle connection, and the browser then
 * reconnects — which costs a ticket each time and makes the console look like
 * it is flapping. A comment is not an event, so no consumer sees it.
 */
const HEARTBEAT_MS = 15_000;

/** One SSE frame. `\n\n` terminates it; anything less and the client waits. */
function frame(event: string, data: unknown, id?: string): string {
  const lines = [
    id === undefined ? null : `id: ${id}`,
    `event: ${event}`,
    `data: ${JSON.stringify(data)}`,
  ].filter((l) => l !== null);
  return `${lines.join("\n")}\n\n`;
}

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
   */
  .get(
    "/events/stream",
    async ({ query, set, path, request }) => {
      const claims = await spendTicket(query.ticket);
      if (claims === null) {
        set.status = 401;
        // Deliberately one message for expired, spent and unknown alike.
        // Distinguishing them tells an attacker which guesses were close.
        return problem(401, "invalid-ticket", "Unauthorized", "the ticket is not valid", path);
      }

      const subscription = subscribe(claims.environmentId);

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const encoder = new TextEncoder();
          const send = (chunk: string) => {
            try {
              controller.enqueue(encoder.encode(chunk));
              return true;
            } catch {
              // The client is gone. Not an error worth logging per event.
              return false;
            }
          };

          // Told immediately, so a console can show "live" from something the
          // server said rather than from the absence of an error.
          send(frame("stream.open", { environmentId: claims.environmentId }));

          const heartbeat = setInterval(() => {
            if (!send(": keepalive\n\n")) {
              clearInterval(heartbeat);
              subscription.close();
            }
          }, HEARTBEAT_MS);

          // Closing the tab aborts the request; without this the subscription
          // survives the connection and the bus keeps a dead reader.
          request.signal.addEventListener("abort", () => {
            clearInterval(heartbeat);
            subscription.close();
          });

          try {
            for await (const envelope of subscription.events) {
              if (!send(frame(envelope.type, envelope, envelope.id))) break;
            }

            // Says why it ended. A console that overflowed has missed events
            // and must refetch rather than assume it is still current.
            if (subscription.reason() === "overflow") {
              send(frame("stream.overflow", { reason: "too far behind; refetch and reconnect" }));
            }
          } catch (err) {
            log.error("event stream failed", err, { environmentId: claims.environmentId });
          } finally {
            clearInterval(heartbeat);
            subscription.close();
            try {
              controller.close();
            } catch {
              // Already closed by the client disconnecting.
            }
          }
        },
        cancel() {
          subscription.close();
        },
      });

      return new Response(stream, {
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          // Nginx buffers text/event-stream by default, which holds events
          // until the buffer fills and makes a live stream arrive in bursts.
          "x-accel-buffering": "no",
        },
      });
    },
    { query: t.Object({ ticket: t.String({ minLength: 1 }) }) },
  );
