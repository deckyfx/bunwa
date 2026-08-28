/**
 * The console's one live connection.
 *
 * docs/07 is explicit: one SSE connection per console, multiplexed by event
 * type, and never polling alongside it — pick one per data source or spend the
 * afternoon debugging ghosts.
 *
 * The connection state is returned rather than hidden because the same document
 * says so, and it is right: a silently dead EventSource showing stale data as
 * though it were live is worse than an error banner. The console can only be
 * honest about being live if it is told.
 */
import { useEffect, useRef, useState } from "react";

export type StreamState = "idle" | "connecting" | "live" | "stale";

interface Options {
  apiKey: string;
  /** Called for every envelope, whatever its type. */
  onEvent: (type: string, data: unknown) => void;
}

/**
 * Hold one SSE connection for the console, and report its state.
 *
 * One connection per console rather than one per widget: every screen needs
 * the same events, and a stream each would mint a ticket each and multiply the
 * server's fan-out by the number of panels on screen. The caller is handed
 * every event and decides what to refetch — the event says *that* something
 * changed and the API stays the authority on what it changed to.
 *
 * The returned state is rendered rather than kept internal because a silently
 * dead EventSource showing stale data as if live is worse than an error.
 */
export function useEventStream({ apiKey, onEvent }: Options): StreamState {
  const [state, setState] = useState<StreamState>("idle");

  // Held in a ref so a changing callback does not tear down the connection.
  // Without this, every parent render would mint a ticket and reconnect.
  const handler = useRef(onEvent);

  // Assigned in an effect, not during render. React may render a component and
  // throw the result away — Strict Mode does it on every mount — and writing
  // the ref during render lets a discarded render install its callback over
  // the live one. The commit phase is the only point at which this render is
  // known to be the one that counts.
  useEffect(() => {
    handler.current = onEvent;
  }, [onEvent]);

  useEffect(() => {
    if (apiKey === "") {
      setState("idle");
      return;
    }

    let source: EventSource | null = null;
    let cancelled = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    // Every state write goes through here.
    //
    // A superseded attempt must not describe the connection that replaced it.
    // The reported case was the catch below marking a live replacement stream
    // "stale" when an abandoned ticket request finally rejected; the same is
    // true of every other write in this effect, so the guard lives in one
    // place rather than being remembered at six call sites.
    const publishState = (next: StreamState) => {
      if (cancelled) return;
      setState(next);
    };

    async function connect(): Promise<void> {
      publishState("connecting");
      try {
        // A ticket per connection, because each is single-use. This is the
        // handshake ADR-0008 describes: EventSource cannot send the key, so
        // the key mints something short-lived that can travel in a URL.
        const res = await fetch("/v1/events/ticket", {
          method: "POST",
          headers: { "x-api-key": apiKey },
        });
        if (!res.ok) throw new Error(`ticket refused: ${res.status}`);
        const { ticket } = (await res.json()) as { ticket: string };
        if (cancelled) return;

        source = new EventSource(`/v1/events/stream?ticket=${encodeURIComponent(ticket)}`);

        source.addEventListener("stream.open", () => publishState("live"));

        // Overflow means this console fell behind and missed events. Marked
        // stale rather than left looking current, because the screen is now
        // wrong in a way it cannot detect from the events it did receive.
        source.addEventListener("stream.overflow", () => {
          // Stale *and* reconnecting. close() stops onerror from ever firing,
          // so without scheduling a retry here the console sat stale until the
          // page was reloaded — and overflow is easy to reach: the bus drops a
          // subscriber after twenty pending envelopes, which a backgrounded tab
          // manages on its own. The server frame says "refetch and reconnect";
          // only the refetch was implemented.
          //
          // Longer than the onerror delay on purpose: overflow means this
          // client could not keep up, and reconnecting instantly invites the
          // same outcome.
          publishState("stale");
          // The caller is told, not just the badge. Overflow means envelopes
          // were dropped, so every snapshot on screen may be wrong in a way no
          // later event will correct — the reconnect alone brings the stream
          // back and leaves the stale data sitting there.
          handler.current("stream.overflow", null);
          source?.close();
          if (!cancelled) retry = setTimeout(() => void connect(), 5_000);
        });

        source.onmessage = (e) => handler.current("message", safeParse(e.data));

        // EventSource dispatches by event name, and the server names each
        // frame after its envelope type. A single catch-all listener is not
        // possible, so the types the console cares about are named here.
        for (const type of LISTENED) {
          source.addEventListener(type, (e) =>
            handler.current(type, safeParse((e as MessageEvent<string>).data)),
          );
        }

        source.onerror = () => {
          // EventSource reconnects on its own, but its ticket is spent, so the
          // retry would be refused forever. Close it and mint a fresh one.
          publishState("connecting");
          source?.close();
          if (!cancelled) retry = setTimeout(() => void connect(), 2_000);
        };
      } catch {
        publishState("stale");
        if (!cancelled) retry = setTimeout(() => void connect(), 5_000);
      }
    }

    void connect();

    return () => {
      cancelled = true;
      if (retry !== undefined) clearTimeout(retry);
      source?.close();
      setState("idle");
    };
  }, [apiKey]);

  return state;
}

/**
 * The envelope types the console reacts to today.
 *
 * device.qr and device.pair_code are deliberately absent, and must stay absent.
 * The engine consumer returns before fan-out for both: a QR is a credential
 * anyone who sees it can scan to take over the account, so publishing it to
 * every active binding would hand it to every other project sharing that
 * phone. They go synchronously to the caller that started pairing, and to
 * nobody else.
 *
 * Listening for them was harmless but dishonest — it implied the console could
 * pick up a refreshed QR from the stream, which it cannot. A QR that expires is
 * re-requested by claiming again, not waited for.
 */
const LISTENED = [
  "device.connected",
  "device.disconnected",
  "device.logged_out",
  // The two the conversation and delivery screens exist to show. Without them
  // an inbound message and a delivery ack arrived on the stream and reached
  // nothing: the screens updated only when some *other* event happened to fire,
  // which reads as a lag nobody can reproduce.
  "message.received",
  "message.ack",
  "message.undelivered",
] as const;

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    // A frame that is not JSON is still worth surfacing as something arrived.
    return raw;
  }
}
