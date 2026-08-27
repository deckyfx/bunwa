/**
 * The live event stream.
 *
 * `EventSource` cannot send headers, so the stream is opened with a
 * single-use ticket minted behind the API key (ADR-0008). This hook owns that
 * dance and reports nothing but a connection state — everything it learns goes
 * into the stores, because a component that re-renders on every event would
 * repaint the whole console for a message in a conversation nobody is reading.
 */
import { useEffect, useRef, useState } from "react";

import { client } from "../lib/api";
import { useSession } from "../store/session";

export type StreamState = "idle" | "connecting" | "live" | "stale";

/** Types the console reacts to. */
const LISTENED = [
  "device.connected",
  "device.disconnected",
  "device.logged_out",
  "message.received",
  "message.undelivered",
] as const;

export function useEventStream(): StreamState {
  const apiKey = useSession((s) => s.apiKey);
  const bumpRevision = useSession((s) => s.bumpRevision);
  const [state, setState] = useState<StreamState>("idle");

  // Only the newest attempt may report. A key change while a ticket request is
  // in flight would otherwise let the abandoned attempt describe the live one.
  const generation = useRef(0);

  useEffect(() => {
    if (apiKey === "") {
      setState("idle");
      return;
    }

    const mine = ++generation.current;
    const current = () => generation.current === mine;
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      if (!current()) return;
      setState("connecting");

      const { data, error } = await client(apiKey).v1.events.ticket.post();
      if (!current()) return;

      if (error !== null || data === null || !("ticket" in data)) {
        // Retry rather than give up: a ticket request fails for the same
        // transient reasons any request does, and a console that stops
        // listening looks identical to one where nothing is happening.
        setState("stale");
        retry = setTimeout(() => void connect(), 5_000);
        return;
      }

      source = new EventSource(`/v1/events/stream?ticket=${encodeURIComponent(data.ticket)}`);

      source.addEventListener("stream.open", () => {
        if (current()) setState("live");
      });

      for (const type of LISTENED) {
        source.addEventListener(type, () => {
          // The stores refetch; the event body is not trusted as state. A
          // console that patched itself from events would drift from the
          // server the first time one was missed.
          if (current()) bumpRevision();
        });
      }

      source.addEventListener("stream.overflow", () => {
        // The server gave up on us. Everything since is missing, so reconnect
        // and let the stores refetch rather than carry on with a gap.
        source?.close();
        if (!current()) return;
        setState("stale");
        retry = setTimeout(() => void connect(), 1_000);
      });

      source.onerror = () => {
        source?.close();
        if (!current()) return;
        setState("stale");
        retry = setTimeout(() => void connect(), 5_000);
      };
    };

    void connect();

    return () => {
      // Invalidate before tearing down: an in-flight ticket request resolving
      // after this would otherwise open a stream nobody closes.
      generation.current += 1;
      if (retry !== null) clearTimeout(retry);
      source?.close();
    };
  }, [apiKey, bumpRevision]);

  return state;
}
