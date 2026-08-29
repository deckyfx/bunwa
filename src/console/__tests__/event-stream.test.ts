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
import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

// `import type` survives mock.module: the mock replaces the runtime module and
// the types still come from the real one, so these fixtures are checked against
// the routes they stand in for.
import type { client } from "../lib/api";

type Api = ReturnType<typeof client>;

/**
 * The two payloads this test stands in for, derived rather than described.
 *
 * Both resolvers were typed `unknown`, so a route could change shape and every
 * assertion here would keep passing while the hook read fields the server had
 * stopped sending. Deriving them means a contract change fails at compile time
 * instead — which is the whole reason the console uses Eden at all, and it was
 * switched off in the tests written to prove the hook survives a real server.
 *
 * Only the payload is derived, not Eden's whole envelope: the hook destructures
 * `{ data, error }` and touches neither `status` nor `headers` nor the raw
 * `response`, so reconstructing those in every fixture would pin nothing.
 */
type Identity = NonNullable<Awaited<ReturnType<Api["v1"]["whoami"]["get"]>>["data"]>;
type Ticket = NonNullable<Awaited<ReturnType<Api["v1"]["events"]["ticket"]["post"]>>["data"]>;

type Reply<T> = { data: T | null; error: { status?: number; value?: unknown } | null };

let whoamiResolver: () => Promise<Reply<Identity>> = () => Promise.resolve({ data: null, error: null });
let ticketResolver: () => Promise<Reply<Ticket>> = () => Promise.resolve({ data: null, error: null });
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
/**
 * The slice of EventSource the hook actually uses.
 *
 * Narrower than the DOM interface on purpose, and typed rather than `unknown`:
 * assigning through `unknown` would accept a stand-in missing `close`, and the
 * test would then prove the hook works against something no browser provides.
 * Anything the hook starts using has to be added here before it compiles.
 */
type StreamConstructor = new (url: string) => {
  addEventListener(): void;
  close(): void;
  onerror: (() => void) | null;
};

// One cast, and it is the bridge rather than the contract. The DOM lib types
// the global as the full EventSource interface, which the stand-in
// deliberately does not implement — happy-dom provides no EventSource at all,
// and building the whole interface to test three methods would be pinning the
// stand-in rather than the hook. `StreamConstructor` above stays exact, so
// what the hook is allowed to touch is still checked; only the assignment to
// the global is forced.
// defineProperty rather than a cast through `unknown`: the assignment is
// checked against StreamConstructor, so a stand-in that stops matching what
// the hook uses fails here instead of at runtime.
const asStream: StreamConstructor = FakeEventSource;
Object.defineProperty(globalThis, "EventSource", {
  value: asStream,
  writable: true,
  configurable: true,
});

/** Mount the hook. Its return value is rendered so a state change is visible. */
const Probe = () => createElement("output", null, useEventStream());

/** Far enough ahead that nothing under test treats a ticket as already stale. */
const EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();

const IDENTITY: Identity = {
  projectId: "p1",
  environmentId: "e1",
  projectSlug: "default",
  projectName: "Default",
  environmentSlug: "production",
  environmentKind: "live",
  scopes: ["send:text"],
  serverTimezone: "Asia/Jakarta",
};

const reset = () => {
  ticketCalls = 0;
  FakeEventSource.opened = [];
  useSession.setState({ apiKey: "", identity: null, error: null, busy: false, revision: 0 });
};

beforeEach(reset);

// bun:test does not register React Testing Library's auto-cleanup, so a
// rendered tree stays in the shared document after its test ends. Two files
// rendering into the same body then see each other's markup, and a query that
// should match one node throws because it matches two.
afterEach(cleanup);

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
    ticketResolver = () => Promise.resolve({ data: { ticket: "t1", expiresAt: EXPIRES_AT }, error: null });
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
