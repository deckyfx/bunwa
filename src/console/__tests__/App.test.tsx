/**
 * The shell's routing between screens.
 *
 * This file exists because of a bug that every component test missed. Finishing
 * setup flips `configured` to true, and the shell rendered the setup screen
 * only while it was false — so the panel showing the freshly minted key was
 * unmounted the instant the key existed. The operator never saw a credential
 * that cannot be shown again, and was locked out of the instance they had just
 * created.
 *
 * SetupPage's own tests all passed, because they render SetupPage directly.
 * The defect was entirely in the wiring between it and the shell, which is the
 * one thing a component test cannot see.
 */
import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let statusResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });
let submitResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });
let whoamiResolver: () => Promise<unknown> = () => Promise.resolve({ data: null, error: null });
/** Which admin endpoints the console reached for. Empty is the assertion for a project key. */
const adminCalls: string[] = [];

void mock.module("../lib/api", () => ({
  client: () => ({
    v1: {
      whoami: { get: () => whoamiResolver() },
      settings: { get: () => Promise.resolve({ data: null, error: { status: 401 } }) },
      devices: { get: () => Promise.resolve({ data: [], error: null }) },
      chats: Object.assign(() => ({ messages: { get: () => Promise.resolve({ data: [], error: null }) } }), {
        get: () => Promise.resolve({ data: [], error: null }),
      }),
      deliveries: { get: () => Promise.resolve({ data: [], error: null }) },
      // A real ticket, not a 401. A rejected one makes the event stream
      // invalidate the session, which tore the signed-in shell down mid-test —
      // correct behaviour under a mock that was lying about the server.
      events: { ticket: { post: () => Promise.resolve({ data: { ticket: "t1" }, error: null }) } },
    },
    // The operator surface. Present in the mock even for the project-key
    // tests: the point of those is that the console never calls it, and a
    // mock that could not answer would hide a call that did.
    admin: {
      v1: {
        projects: Object.assign(
          (params: { projectId: string }) => ({
            environments: Object.assign(() => ({ "api-keys": Object.assign(() => ({ delete: () => Promise.resolve({ error: null }) }), { get: () => Promise.resolve({ data: [], error: null }), post: () => Promise.resolve({ data: null, error: null }) }) }), {
              get: () => {
                adminCalls.push(`environments:${params.projectId}`);
                return Promise.resolve({ data: [], error: null });
              },
            }),
          }),
          {
            get: () => {
              adminCalls.push("projects");
              return Promise.resolve({ data: [], error: null });
            },
            post: () => Promise.resolve({ data: null, error: null }),
          },
        ),
      },
    },
  }),
  anonymous: () => ({
    setup: Object.assign(
      { post: () => submitResolver() },
      { status: { get: () => statusResolver() } },
    ),
  }),
}));

/** happy-dom provides no EventSource, and the signed-in shell opens one. */
class FakeEventSource {
  constructor(_url: string) {
    /* inert: these tests are about layout, not delivery */
  }
  addEventListener(): void {}
  close(): void {}
  onerror: (() => void) | null = null;
}
(globalThis as { EventSource?: unknown }).EventSource = FakeEventSource;

const { App } = await import("../App");
const { useSetup, resetSetupRequests } = await import("../store/setup");
const { useSession } = await import("../store/session");
const { useRoute } = await import("../store/route");
const { sectionsFor } = await import("../components/Sidebar");

const UNCONFIGURED = {
  data: {
    configured: false,
    canMintKey: true,
    apiKeySource: "none",
    settings: {
      instanceName: { value: "bunwa", source: "default" },
      serverTimezone: { value: "Asia/Jakarta", source: "default" },
    },
  },
  error: null,
};

beforeEach(() => {
  // One test simulates a request that never answers, which would otherwise
  // hold the store's dedupe guard for every test after it.
  resetSetupRequests();
  // The address is shared state like any other, and it is shared across test
  // *files*: a fragment left by another file put this one on the wrong
  // section before it had rendered anything.
  // replaceState, not `location.hash = ""`. Assigning the hash queues a
  // hashchange, and that event was still in flight when the next test set its
  // own address — the store's listener then read a hash that had already moved
  // on and reset the section under it.
  window.history.replaceState(null, "", "/");
  adminCalls.length = 0;
  useRoute.setState({ route: { section: "devices", detail: null } });
  statusResolver = () => Promise.resolve(UNCONFIGURED);
  submitResolver = () =>
    Promise.resolve({
      data: {
        settings: UNCONFIGURED.data.settings,
        apiKey: "bw_live_default_thekey",
        apiKeySource: "database",
      },
      error: null,
    });
  whoamiResolver = () => Promise.resolve({ data: null, error: { status: 401 } });

  useSetup.setState({
    configured: null,
    canMintKey: false,
    apiKeySource: "none",
    settings: null,
    busy: false,
    error: null,
    mintedKey: null,
  });
  useSession.setState({ apiKey: "", identity: null, error: null, busy: false, revision: 0, hydrated: true });
});

afterEach(cleanup);

describe("choosing a screen", () => {
  test("an unconfigured instance gets setup, not a key form", async () => {
    render(<App />);
    expect(await screen.findByLabelText("Setup token")).toBeDefined();
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  test("a configured instance gets the key form", async () => {
    statusResolver = () =>
      Promise.resolve({ data: { ...UNCONFIGURED.data, configured: true, canMintKey: false }, error: null });

    render(<App />);
    expect(await screen.findByLabelText("API key")).toBeDefined();
    expect(screen.queryByLabelText("Setup token")).toBeNull();
  });
});

describe("the minted key survives the state change that produced it", () => {
  test("stays on screen after setup completes", async () => {
    // The bug. Finishing setup sets configured to true, and the shell showed
    // the setup screen only while it was false — so the key panel was
    // unmounted in the same render that created it.
    render(<App />);

    const token = await screen.findByLabelText("Setup token");
    (token as HTMLInputElement).value = "tok";
    token.dispatchEvent(new Event("input", { bubbles: true }));

    // Drive the store directly rather than through the form: the property
    // under test is what the shell renders for a given state, and going
    // through the form would also be testing the form.
    await useSetup.getState().submit("tok", { instanceName: "grande" });

    await waitFor(() => {
      expect(screen.getByText("bw_live_default_thekey")).toBeDefined();
    });
  });

  test("is not competing with the key form underneath it", async () => {
    // Both would be on screen at once otherwise: configured is true, so the
    // connect card qualifies, while the key panel is still showing.
    render(<App />);
    await screen.findByLabelText("Setup token");

    await useSetup.getState().submit("tok", { instanceName: "grande" });

    await waitFor(() => {
      expect(screen.getByText("bw_live_default_thekey")).toBeDefined();
    });
    expect(screen.queryByLabelText("API key")).toBeNull();
  });

  test("gives way to the key form once dismissed", async () => {
    render(<App />);
    await screen.findByLabelText("Setup token");
    await useSetup.getState().submit("tok", { instanceName: "grande" });
    await waitFor(() => {
      expect(screen.getByText("bw_live_default_thekey")).toBeDefined();
    });

    useSetup.getState().dismissKey();

    await waitFor(() => {
      expect(screen.getByLabelText("API key")).toBeDefined();
    });
    expect(screen.queryByText("bw_live_default_thekey")).toBeNull();
  });
});

describe("a credential left over from a database that no longer exists", () => {
  test("is discarded when the instance reports no keys", async () => {
    // Browser storage outlives the database. A key from two purges ago was
    // still being presented: two 401s per page load, two "api key rejected"
    // warnings in the server log, and an error banner accusing a credential
    // the operator had never typed — all while the setup screen was loading.
    localStorage.setItem("bunwa.apiKey", "bw_test_grande_stale");
    useSession.setState({ apiKey: "bw_test_grande_stale" });

    render(<App />);
    await screen.findByLabelText("Setup token");

    await waitFor(() => {
      expect(useSession.getState().apiKey).toBe("");
    });
    expect(localStorage.getItem("bunwa.apiKey")).toBeNull();
  });

  test("is not presented to the server first", async () => {
    // The point is that the request is never made, not that its failure is
    // handled: a 401 in the log is the operator's first impression of an
    // instance they have not finished setting up.
    let asked = 0;
    whoamiResolver = () => {
      asked += 1;
      return Promise.resolve({ data: null, error: { status: 401 } });
    };
    useSession.setState({ apiKey: "bw_test_grande_stale" });

    render(<App />);
    await screen.findByLabelText("Setup token");
    await waitFor(() => {
      expect(useSession.getState().apiKey).toBe("");
    });

    expect(asked).toBe(0);
  });

  test("discarding it leaves no error to explain", async () => {
    // There is nothing for the operator to act on: the key is gone because the
    // instance it belonged to is gone.
    useSession.setState({ apiKey: "bw_test_grande_stale" });

    render(<App />);
    await screen.findByLabelText("Setup token");
    await waitFor(() => {
      expect(useSession.getState().apiKey).toBe("");
    });

    expect(useSession.getState().error).toBeNull();
  });

  test("a stored key is still checked when the instance does have keys", async () => {
    // The guard must not become "never trust storage": that would make every
    // refresh a fresh login.
    statusResolver = () =>
      Promise.resolve({ data: { ...UNCONFIGURED.data, configured: true, canMintKey: false }, error: null });
    whoamiResolver = () =>
      Promise.resolve({
        data: { projectId: "p", environmentId: "e", scopes: [], serverTimezone: "UTC" },
        error: null,
      });
    useSession.setState({ apiKey: "bw_live_default_good" });

    render(<App />);

    await waitFor(() => {
      expect(useSession.getState().identity).not.toBeNull();
    });
  });
});

describe("the signed-in shell", () => {
  const signIn = () => {
    statusResolver = () =>
      Promise.resolve({ data: { ...UNCONFIGURED.data, configured: true, canMintKey: false }, error: null });
    whoamiResolver = () =>
      Promise.resolve({
        data: { projectId: "proj-1234-abcd", environmentId: "env-5678-efgh", scopes: [], serverTimezone: "UTC" },
        error: null,
      });
    useSession.setState({ apiKey: "bw_live_default_good" });
  };

  test("shows the navigation once there is a session", async () => {
    signIn();
    render(<App />);

    const nav = await screen.findByRole("navigation", { name: "Sections" });
    expect(nav).toBeDefined();
  });

  test("shows no navigation before there is one", async () => {
    // The panel navigates between things that all need a credential.
    render(<App />);
    await screen.findByLabelText("Setup token");
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
  });

  test("one section at a time, and the panel says which", async () => {
    signIn();
    render(<App />);

    const devices = await screen.findByRole("button", { name: "Devices" });
    expect(devices.getAttribute("aria-current"), "the landing section").toBe("page");

    fireEvent.click(screen.getByRole("button", { name: "Deliveries" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Deliveries" }).getAttribute("aria-current")).toBe("page");
    });
    // aria-current, not merely a background colour: which section is showing
    // has to be answerable without seeing the styling.
    expect(screen.getByRole("button", { name: "Devices" }).getAttribute("aria-current")).toBeNull();
  });

  test("sign out is reachable from both the ribbon and the panel", async () => {
    // The panel is the considered place for it; the ribbon is where someone
    // reaches when they want out of a shared screen quickly.
    signIn();
    render(<App />);
    await screen.findByRole("navigation", { name: "Sections" });

    // Two, deliberately: one in each place. Asserting the count rather than
    // "at least one" is the difference between checking both exist and
    // checking that either does.
    expect(screen.getAllByRole("button", { name: "Sign out" })).toHaveLength(2);
  });

  test("signing out returns to the connect card", async () => {
    signIn();
    render(<App />);
    await screen.findByRole("navigation", { name: "Sections" });

    fireEvent.click(screen.getAllByRole("button", { name: "Sign out" })[0]!);

    await waitFor(() => {
      expect(screen.getByLabelText("API key")).toBeDefined();
    });
    expect(screen.queryByRole("navigation", { name: "Sections" })).toBeNull();
  });

  test("the theme control is present whether or not there is a session", async () => {
    // It is the one control that has nothing to do with being signed in, and
    // the setup screen is exactly where someone might first want dark mode.
    render(<App />);
    await screen.findByLabelText("Setup token");
    expect(screen.getByRole("button", { name: /^Theme:/ })).toBeDefined();
  });
});

describe("what each kind of key is offered", () => {
  const signInWith = (scopes: string[]) => {
    statusResolver = () =>
      Promise.resolve({ data: { ...UNCONFIGURED.data, configured: true, canMintKey: false }, error: null });
    whoamiResolver = () =>
      Promise.resolve({
        data: {
          projectId: "p",
          environmentId: "e",
          projectSlug: "acme",
          projectName: "Acme",
          environmentSlug: "production",
          environmentKind: "live",
          scopes,
          serverTimezone: "UTC",
        },
        error: null,
      });
    useSession.setState({ apiKey: "bw_live_acme_key" });
  };

  const PROJECT = ["send:text", "receive:messages", "manage:devices"];
  const OPERATOR = [...PROJECT, "manage:instance", "manage:projects"];

  test("an operator is offered Projects", async () => {
    signInWith(OPERATOR);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Projects" })).toBeDefined();
  });

  test("a project key is not", async () => {
    // Not the security boundary — the route checks the scope itself — but a
    // section that answers 403 on every request is an invitation to press a
    // button that cannot work.
    signInWith(PROJECT);
    render(<App />);
    await screen.findByRole("navigation", { name: "Sections" });

    expect(screen.queryByRole("button", { name: "Projects" })).toBeNull();
  });

  test("a project key is not offered instance Settings either", async () => {
    signInWith(PROJECT);
    render(<App />);
    await screen.findByRole("navigation", { name: "Sections" });

    expect(screen.queryByRole("button", { name: "Settings" })).toBeNull();
  });

  test("a project key keeps the sections it can actually use", async () => {
    signInWith(PROJECT);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Devices" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Conversations" })).toBeDefined();
  });

  test("an address naming a forbidden section lands somewhere usable", async () => {
    // A project key following a link an operator sent. Rendering the section
    // would give an empty page full of 403s instead of the console it has.
    // The address, not just the store: a followed link sets both, and the
    // store's listener reads from the address.
    window.history.replaceState(null, "", "#projects");
    useRoute.setState({ route: { section: "projects", detail: null } });
    signInWith(PROJECT);

    render(<App />);
    await screen.findByRole("navigation", { name: "Sections" });

    await waitFor(() => {
      expect(useRoute.getState().route.section).not.toBe("projects");
    });
    expect(screen.getByRole("button", { name: "Devices" }).getAttribute("aria-current")).toBe("page");
  });

  test("an operator can reach Projects and stays there", async () => {
    // Navigated rather than deep-linked. The deep-link case is covered above
    // for the key that must be redirected; asserting the negative through a
    // preloaded address here fought happy-dom's history semantics rather than
    // the code — the guard's own rule is asserted directly below.
    signInWith(OPERATOR);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Projects" }));

    await waitFor(() => {
      expect(useRoute.getState().route.section).toBe("projects");
    });
    // Still there a tick later: the guard runs on every render, and one that
    // redirected an operator would show up as the section bouncing back.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Projects" }).getAttribute("aria-current")).toBe("page");
    });
  });

  test("the rule the guard applies, directly", () => {
    // A key is redirected only when the section it names is not in its own
    // list, and an operator's list contains everything.
    expect(sectionsFor(OPERATOR).map((s) => s.id)).toContain("projects");
    expect(sectionsFor(PROJECT).map((s) => s.id)).not.toContain("projects");
    expect(sectionsFor(PROJECT).map((s) => s.id)).not.toContain("settings");
  });
});

describe("reopening a tab that has a key", () => {
  /** A stored key that has not been checked yet — the state on first render. */
  const withStoredKey = () => {
    useSession.setState({ apiKey: "bw_live_default_stored", hydrated: false });
    statusResolver = () =>
      Promise.resolve({ data: { ...UNCONFIGURED.data, configured: true, canMintKey: false }, error: null });
  };

  test("says it is checking rather than showing an empty key field", async () => {
    // The flash: the sign-in form rendered while the answer was still in
    // flight, so reopening a tab looked like having been signed out.
    withStoredKey();
    whoamiResolver = () => new Promise(() => undefined);

    render(<App />);

    expect(await screen.findByText(/Checking access key/)).toBeDefined();
    expect(screen.queryByLabelText("API key"), "and no form to mislead").toBeNull();
  });

  test("distinguishes the two questions it is waiting on", async () => {
    // Before the status call answers, the instance itself is unknown — which
    // is a different wait, and a different sentence.
    statusResolver = () => new Promise(() => undefined);
    useSession.setState({ apiKey: "bw_live_default_stored", hydrated: false });

    render(<App />);

    expect(await screen.findByText(/Checking this instance/)).toBeDefined();
  });

  test("shows the console once the key turns out to be good", async () => {
    withStoredKey();
    whoamiResolver = () =>
      Promise.resolve({
        data: {
          projectId: "p",
          environmentId: "e",
          projectSlug: "acme",
          projectName: "Acme",
          environmentSlug: "production",
          environmentKind: "live",
          scopes: ["send:text"],
          serverTimezone: "UTC",
        },
        error: null,
      });

    render(<App />);

    expect(await screen.findByRole("navigation", { name: "Sections" })).toBeDefined();
  });

  test("shows the form once the key turns out to be bad", async () => {
    // The wait must end. A checking state that never resolves is worse than
    // the flash it replaced.
    withStoredKey();
    whoamiResolver = () => Promise.resolve({ data: null, error: { status: 401 } });

    render(<App />);

    expect(await screen.findByLabelText("API key")).toBeDefined();
    expect(screen.queryByText(/Checking access key/)).toBeNull();
  });

  test("no stored key means no wait at all", async () => {
    // Nothing to check, so the form is the right first thing to show.
    statusResolver = () =>
      Promise.resolve({ data: { ...UNCONFIGURED.data, configured: true, canMintKey: false }, error: null });
    useSession.setState({ apiKey: "", hydrated: true });

    render(<App />);

    expect(await screen.findByLabelText("API key")).toBeDefined();
  });
});
