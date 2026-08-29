/**
 * The session store.
 *
 * Every property here was a bug a reviewer found in the components this
 * replaced. They are kept because the races did not go away — a slow response
 * still lands late — the handling merely moved somewhere it can be written
 * once.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

// `import type` survives mock.module: the mock replaces the runtime module,
// the types still come from the real one. That is what makes the fixtures
// below check against the actual route.
import type { client } from "../lib/api";

type Api = ReturnType<typeof client>;

/**
 * What `GET /v1/whoami` actually resolves to, derived rather than described.
 *
 * These fixtures were typed `unknown`, which meant a route could change shape
 * and every test here would keep passing while the store read fields the
 * server had stopped sending — the exact drift Eden was adopted to make
 * impossible, reintroduced in the tests that are supposed to prove the store
 * handles the real thing.
 *
 * Only the payload is derived. Eden's envelope also carries `status`,
 * `headers` and the raw `response`, none of which the store touches — it
 * destructures `{ data, error }` and nothing else — so reconstructing all of
 * it in every fixture would be ceremony that pins nothing. The half that
 * drifts is the half that is pinned.
 */
type Whoami = NonNullable<Awaited<ReturnType<Api["v1"]["whoami"]["get"]>>["data"]>;
type WhoamiResponse = { data: Whoami | null; error: { status?: number } | null };

/**
 * A complete whoami payload, with only what a test cares about spelled out.
 *
 * A factory rather than literals at each site because the route returns eight
 * fields and the tests care about two. Typing these properly immediately found
 * that the literals had been missing five of them — projectSlug, projectName,
 * environmentSlug, environmentKind and serverTimezone — since the day those
 * were added, which is the drift the derived type exists to surface.
 */
const whoami = (over: Partial<Whoami> = {}): Whoami => ({
  level: "tenant" as const,
  projectId: "p1",
  projectSlug: "grande",
  projectName: "Grande",
  environmentId: "e1",
  environmentSlug: "production",
  environmentKind: "production",
  scopes: [],
  serverTimezone: "UTC",
  ...over,
});

/**
 * The Eden client is replaced at the module level.
 *
 * ES exports are readonly, so reassigning `apiModule.client` throws. mock.module
 * swaps the module in the registry before the store imports it, which is the
 * only way to intercept a call the store makes directly.
 */
let whoamiResolver: () => Promise<WhoamiResponse> = () =>
  Promise.resolve({ data: null, error: { status: 401 } });

void mock.module("../lib/api", () => ({
  client: () => ({ v1: { whoami: { get: () => whoamiResolver() } } }),
  anonymous: () => ({}),
}));

const { useSession } = await import("../store/session");

const RESET = { apiKey: "", identity: null, error: null, busy: false, revision: 0 };

const stubWhoami = (resolver: () => Promise<WhoamiResponse>) => {
  whoamiResolver = resolver;
};

beforeEach(() => {
  useSession.setState(RESET);
  try {
    localStorage.clear();
  } catch {
    /* storage may be unavailable; the store copes and so does this */
  }
});

describe("connecting", () => {
  test("a good key produces an identity", async () => {
    stubWhoami(() =>
      Promise.resolve({ data: whoami(), error: null }),
    );

    await useSession.getState().connect("bw_test_key");

    const identity = useSession.getState().identity;
    expect(identity?.level).toBe("tenant");
    if (identity?.level !== "tenant") throw new Error("expected a tenant identity");
    expect(identity.projectId).toBe("p1");
    expect(useSession.getState().error).toBeNull();
  });

  test("a rejected key leaves no identity behind", async () => {
    stubWhoami(() => Promise.resolve({ data: null, error: { status: 401 } }));

    await useSession.getState().connect("bad");

    expect(useSession.getState().identity).toBeNull();
    expect(useSession.getState().error).toContain("refused that key");
  });

  test("an unreachable server is not blamed on the key", async () => {
    // Every failure used to say the key was not accepted, including the ones
    // where the server never answered — so a crashed server sent the operator
    // off to check a credential that was fine.
    stubWhoami(() => Promise.resolve({ data: null, error: { status: undefined } }));

    await useSession.getState().connect("bw_live_default_whatever");

    expect(useSession.getState().error).toContain("could not reach the server");
  });

  test("a server error says so rather than accusing the key", async () => {
    stubWhoami(() => Promise.resolve({ data: null, error: { status: 500 } }));

    await useSession.getState().connect("bw_live_default_whatever");

    expect(useSession.getState().error).toContain("500");
    expect(useSession.getState().error).not.toContain("refused that key");
  });

  test("a rejection points at where the reason actually is", async () => {
    // The server cannot say why — revoked, unknown and expired are
    // deliberately indistinguishable to a caller — so the message has to send
    // the operator to the log, which is allowed to know.
    stubWhoami(() => Promise.resolve({ data: null, error: { status: 401 } }));

    await useSession.getState().connect("bad");

    expect(useSession.getState().error).toContain("api key rejected");
  });

  test("an empty key clears everything it authorised", async () => {
    stubWhoami(() =>
      Promise.resolve({ data: whoami(), error: null }),
    );
    await useSession.getState().connect("bw_test_key");
    expect(useSession.getState().identity).not.toBeNull();

    await useSession.getState().connect("");

    // Leaving the identity would show one tenant's context with no credential
    // behind it.
    expect(useSession.getState().identity).toBeNull();
    expect(useSession.getState().apiKey).toBe("");
  });
});

describe("a response that arrives after the key changed", () => {
  test("cannot restore the previous project", async () => {
    // The component version of this needed a generation counter, a ref and an
    // unmount cleanup, each added after a separate review. One check here.
    let releaseFirst: ((v: WhoamiResponse) => void) | undefined;
    let call = 0;

    stubWhoami(() => {
      call += 1;
      if (call === 1) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve({
        data: whoami({ projectId: "SECOND", environmentId: "e2" }),
        error: null,
      });
    });

    const first = useSession.getState().connect("key-a");
    await useSession.getState().connect("key-b");

    releaseFirst?.({ data: whoami({ projectId: "FIRST" }), error: null });
    await first;

    const current = useSession.getState().identity;
    if (current?.level !== "tenant") throw new Error("expected a tenant identity");
    expect(current.projectId, "a superseded response overwrote the current session").toBe("SECOND");
  });
});

describe("the revision counter", () => {
  test("bumps so screens know to refetch", () => {
    const before = useSession.getState().revision;
    useSession.getState().bumpRevision();
    expect(useSession.getState().revision).toBe(before + 1);
  });
});
