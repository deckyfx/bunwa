/**
 * The projects store, for the property that makes a minted key safe.
 *
 * A minted key is the only thing this console holds that is somebody else's
 * secret, and it is shown in a dialog the operator is meant to copy from. Both
 * tests here are about it arriving late — after the selection moved, or after
 * a different person signed in.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

// `import type` survives mock.module: the mock replaces the runtime module
// while the types still come from the real one, so these stand-ins are checked
// against the routes they stand in for.
import type { Environment, KeySummary, Project } from "../store/projects";

/**
 * Only the halves the store reads.
 *
 * These were `unknown`, which is the same gap that had already been closed in
 * the deliveries test and which I reopened by writing new fixtures the old
 * way. An untyped resolver lets a route change shape while every assertion
 * here keeps passing — the drift Eden was adopted to make impossible, switched
 * off in the tests meant to prove the store survives a real server. The
 * envelope's `status`, `headers` and raw `response` are omitted because the
 * store destructures `{ data, error }` and nothing else.
 */
type Reply<T> = { data: T | null; error: { status?: number } | null };

let mintResolver: () => Promise<Reply<{ key: string; label: string }>> = () =>
  Promise.resolve({ data: { key: "bw_live_x", label: "k" }, error: null });
let listResolver: () => Promise<Reply<Project[]>> = () => Promise.resolve({ data: [], error: null });
let envResolver: () => Promise<Reply<Environment[]>> = () => Promise.resolve({ data: [], error: null });
let keysResolver: () => Promise<Reply<KeySummary[]>> = () => Promise.resolve({ data: [], error: null });

void mock.module("../lib/api", () => ({
  client: () => ({
    admin: {
      v1: {
        projects: Object.assign(
          () => ({
            environments: Object.assign(
              () => ({
                "api-keys": Object.assign(
                  () => ({ delete: () => Promise.resolve({ error: null }) }),
                  {
                    get: () => keysResolver(),
                    post: () => mintResolver(),
                  },
                ),
              }),
              { get: () => envResolver() },
            ),
          }),
          { get: () => listResolver() },
        ),
      },
    },
  }),
  anonymous: () => ({}),
}));

const { useProjects } = await import("../store/projects");
const { useSession } = await import("../store/session");

const RESET = {
  projects: null,
  openId: "p1",
  environments: null,
  keys: null,
  keysFor: "e1",
  busy: false,
  error: null,
  mintedKey: null,
};

beforeEach(() => {
  useSession.setState({ apiKey: "key-a", identity: null, error: null, busy: false, revision: 0 });
  useProjects.setState(RESET);
  listResolver = () => Promise.resolve({ data: [], error: null });
  envResolver = () => Promise.resolve({ data: [], error: null });
  keysResolver = () => Promise.resolve({ data: [], error: null });
});

describe("a key minted while the operator moves on", () => {
  test("is not shown under a different project", async () => {
    let release: ((v: Reply<{ key: string; label: string }>) => void) | undefined;
    mintResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const minting = useProjects.getState().createKey("p1", "e1", "otp", []);
    // The operator opens a different project before the mint lands.
    useProjects.setState({ openId: "p2", keysFor: "e2" });
    release?.({ data: { key: "bw_live_secret", label: "otp" }, error: null });
    await minting;

    expect(
      useProjects.getState().mintedKey,
      "one project's credential was offered under another project",
    ).toBeNull();
    expect(useProjects.getState().busy, "the form was left disabled").toBe(false);
  });

  test("is not shown to whoever signs in next", async () => {
    // The sharper case: not a different project, a different person.
    let release: ((v: Reply<{ key: string; label: string }>) => void) | undefined;
    mintResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const minting = useProjects.getState().createKey("p1", "e1", "otp", []);
    useSession.setState({ apiKey: "key-b" });

    // The next operator opens the same project, so the selection matches again
    // and only the session binding can tell these apart. Without this the test
    // passes on blankOnKeyChange having cleared openId, which is a different
    // guard — verified by removing each in turn.
    useProjects.setState({ openId: "p1", keysFor: "e1" });

    release?.({ data: { key: "bw_live_secret", label: "otp" }, error: null });
    await minting;

    expect(
      useProjects.getState().mintedKey,
      "a credential minted under one session was shown to another",
    ).toBeNull();
  });
});

describe("a listing that lands after the operator signed out", () => {
  test("does not repopulate the store for the next session", async () => {
    // blankOnKeyChange empties the store on the key change; this is the
    // request that was already in flight when it did, arriving afterwards and
    // filling it straight back in.
    let release: ((v: Reply<Project[]>) => void) | undefined;
    listResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const loading = useProjects.getState().load();
    useSession.setState({ apiKey: "key-b" });
    release?.({
      data: [
        {
          id: "p1",
          slug: "grande",
          displayName: "Grande",
          status: "active",
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      error: null,
    });
    await loading;

    expect(
      useProjects.getState().projects,
      "a previous session's projects were painted for the next one",
    ).toBeNull();
  });
});

describe("a selection loaded under one credential", () => {
  test("does not restore itself when the next operator opens the same project", async () => {
    // The case a selection check alone cannot see: the ids match again because
    // the next person navigated to the same place, so only the credential
    // tells the two requests apart.
    let release: ((v: Reply<Environment[]>) => void) | undefined;
    envResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const opening = useProjects.getState().open("p1");
    useSession.setState({ apiKey: "key-b" });
    useProjects.setState({ openId: "p1" });

    // Spelled out because the compiler now insists: `kind` is "live" | "test",
    // not the environment slug, and this fixture had it wrong until the types
    // said so.
    release?.({
      data: [
        {
          id: "e1",
          slug: "production",
          kind: "live",
          status: "active",
          projectId: "p1",
          settings: {},
          createdAt: new Date(0),
          updatedAt: new Date(0),
        },
      ],
      error: null,
    });
    await opening;

    expect(
      useProjects.getState().environments,
      "a previous session's environments were restored for the next one",
    ).toBeNull();
  });
});
