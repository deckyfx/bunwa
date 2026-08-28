/**
 * When the console is allowed to open the event stream.
 *
 * Written after a live incident: a key restored from localStorage outlived the
 * database it was issued against, and the console asked for a stream ticket
 * every five seconds, forever, logging a rejection each time. Three separate
 * mistakes lined up — nothing validated the restored key, the stream was gated
 * on the key rather than on the server having accepted it, and the retry
 * treated 401 as transient. Each is asserted here.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { render, waitFor } from "@testing-library/react";
import { createElement } from "react";

let whoamiResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });
let ticketResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });
let ticketCalls = 0;

void mock.module("../lib/api", () => ({
  client: () => ({
    v1: {
      whoami: { get: () => whoamiResolver() },
      events: {
        ticket: {
          post: () => {
            ticketCalls += 1;
            return ticketResolver();
          },
        },
      },
    },
  }),
  anonymous: () => ({}),
}));

const { useSession } = await import("../store/session");
const { useEventStream } = await import("../hooks/useEventStream");

/**
 * A stand-in for EventSource, which happy-dom does not provide.
 *
 * Deliberately inert: these tests are about whether the stream is opened at
 * all, so the constructor recording the attempt is the whole contract. A
 * fuller fake would invite assertions about event delivery that this file is
 * not set up to make honestly.
 */
class FakeEventSource {
  static opened: string[] = [];
  constructor(url: string) {
    FakeEventSource.opened.push(url);
  }
  addEventListener(): void {}
  close(): void {}
  onerror: (() => void) | null = null;
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

/** Mount the hook. Its return value is rendered so a state change is visible. */
const Probe = () => createElement("output", null, useEventStream());

const IDENTITY = {
  projectId: "p1",
  environmentId: "e1",
  scopes: ["send:text"],
  serverTimezone: "Asia/Jakarta",
};

const reset = () => {
  ticketCalls = 0;
  FakeEventSource.opened = [];
  useSession.setState({ apiKey: "", identity: null, error: null, busy: false, revision: 0 });
};

beforeEach(reset);

describe("a key restored from storage", () => {
  test("is verified rather than assumed good", async () => {
    // The restored key is the one case where the console holds a credential it
    // has never seen accepted. Treating it as live is what let the stream run
    // against a key the server would always reject.
    whoamiResolver = () => Promise.resolve({ data: IDENTITY, error: null });
    useSession.setState({ apiKey: "bw_stored" });

    await useSession.getState().hydrate();

    expect(useSession.getState().identity).toEqual(IDENTITY);
  });

  test("leaves no identity behind when the server rejects it", async () => {
    // Which is the purged-database case: the key is well-formed and gone.
    whoamiResolver = () => Promise.resolve({ data: null, error: { status: 401, value: null } });
    useSession.setState({ apiKey: "bw_stale" });

    await useSession.getState().hydrate();

    expect(useSession.getState().identity).toBeNull();
    expect(useSession.getState().error).not.toBeNull();
  });

  test("does not re-check a session already established", async () => {
    // hydrate runs from an effect, and an effect can run twice.
    whoamiResolver = () => Promise.resolve({ data: IDENTITY, error: null });
    useSession.setState({ apiKey: "bw_stored", identity: IDENTITY });

    let calls = 0;
    whoamiResolver = () => {
      calls += 1;
      return Promise.resolve({ data: IDENTITY, error: null });
    };
    await useSession.getState().hydrate();

    expect(calls).toBe(0);
  });

  test("nothing to verify when there is no stored key", async () => {
    await useSession.getState().hydrate();
    expect(useSession.getState().error).toBeNull();
  });
});

describe("invalidation", () => {
  test("clears the identity so anything gated on it stops", () => {
    useSession.setState({ apiKey: "bw_live", identity: IDENTITY });

    useSession.getState().invalidate("revoked");

    expect(useSession.getState().identity).toBeNull();
    expect(useSession.getState().error).toBe("revoked");
  });

  test("keeps the key on screen", () => {
    // The usual cause is a revoked key or a replaced database. Retyping it is
    // not the fix, so clearing the field would only hide what went wrong.
    useSession.setState({ apiKey: "bw_live", identity: IDENTITY });

    useSession.getState().invalidate("revoked");

    expect(useSession.getState().apiKey).toBe("bw_live");
  });

  test("does not overwrite a fresher error when there is no session", () => {
    // A late 401 from an abandoned attempt must not stamp over the message the
    // current attempt just set.
    useSession.setState({ apiKey: "bw_live", identity: null, error: "that key was not accepted" });

    useSession.getState().invalidate("revoked");

    expect(useSession.getState().error).toBe("that key was not accepted");
  });
});

describe("the stream itself", () => {
  test("does not open without an accepted identity", async () => {
    // The purged-database case, and the whole incident: a stored key with no
    // session behind it must not produce a single ticket request, let alone
    // one every five seconds.
    useSession.setState({ apiKey: "bw_stale", identity: null });

    const { findByText } = render(createElement(Probe));

    expect(await findByText("idle")).toBeDefined();
    expect(ticketCalls, "no ticket was asked for").toBe(0);
  });

  test("opens once the identity is there", async () => {
    ticketResolver = () => Promise.resolve({ data: { ticket: "t1" }, error: null });
    useSession.setState({ apiKey: "bw_live", identity: IDENTITY });

    render(createElement(Probe));

    await waitFor(() => {
      expect(ticketCalls).toBe(1);
    });
    await waitFor(() => {
      expect(FakeEventSource.opened, "the ticket is carried on the stream URL").toEqual([
        "/v1/events/stream?ticket=t1",
      ]);
    });
  });

  test("a rejected ticket ends the session instead of retrying it", async () => {
    // The retry was five seconds; the assertion is that a second attempt never
    // comes, and that the identity is dropped so the guard above holds it shut.
    ticketResolver = () => Promise.resolve({ data: null, error: { status: 401, value: null } });
    useSession.setState({ apiKey: "bw_live", identity: IDENTITY });

    render(createElement(Probe));

    await waitFor(() => {
      expect(useSession.getState().identity).toBeNull();
    });
    expect(ticketCalls, "exactly one attempt").toBe(1);
    expect(FakeEventSource.opened, "and no stream was opened").toEqual([]);
  });
});
