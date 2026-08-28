/**
 * The chats store.
 *
 * Two properties here were reviewer findings against the component this
 * replaced: replying into one conversation must not repaint another, and a
 * duplicate send must not be possible. Both were fixed with per-component
 * guards; the store keeps the behaviour with one.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

let threadsResolver: () => Promise<unknown> = () => Promise.resolve({ data: [], error: null });
let messagesResolver: (id: string) => Promise<unknown> = () =>
  Promise.resolve({ data: [], error: null });
let sendResolver: () => Promise<unknown> = () => Promise.resolve({ data: {}, error: null });
const readCalls: string[] = [];

void mock.module("../lib/api", () => ({
  client: () => ({
    v1: {
      chats: Object.assign(
        (params: { id: string }) => ({
          messages: {
            get: () => messagesResolver(params.id),
            post: () => sendResolver(),
          },
          read: {
            post: () => {
              readCalls.push(params.id);
              return Promise.resolve({ data: null, error: null });
            },
          },
        }),
        { get: () => threadsResolver() },
      ),
    },
  }),
  anonymous: () => ({}),
}));

const { useChats } = await import("../store/chats");
const { useSession } = await import("../store/session");

const thread = (id: string, unread = 0) => ({
  id,
  deviceId: "d1",
  alias: "otp",
  peerJid: `628${id}@s.whatsapp.net`,
  displayName: id === "t1" ? "Ana" : "Bo",
  lastMessageAt: null,
  unreadCount: unread,
});

const message = (id: string, body: string) => ({
  id,
  direction: "inbound" as const,
  kind: "text",
  body,
  mediaId: null,
  status: null,
  occurredAt: new Date(0),
});

beforeEach(() => {
  useSession.setState({ apiKey: "key-a", identity: null, error: null, busy: false, revision: 0 });
  useChats.setState({
    threads: null,
    selectedId: null,
    messages: null,
    draft: "",
    sending: false,
    error: null,
  });
  readCalls.length = 0;
});

describe("loading", () => {
  test("threads arrive with their unread counts", async () => {
    threadsResolver = () => Promise.resolve({ data: [thread("t1", 2)], error: null });
    await useChats.getState().loadThreads();
    expect(useChats.getState().threads?.[0]?.unreadCount).toBe(2);
  });

  test("a response after the key changed is dropped", async () => {
    // Painting the previous tenant's conversations is the failure this stops.
    let release: ((v: unknown) => void) | undefined;
    threadsResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const inFlight = useChats.getState().loadThreads();
    useSession.setState({ apiKey: "key-b" });
    release?.({ data: [thread("t1")], error: null });
    await inFlight;

    expect(useChats.getState().threads, "a stale response painted the wrong tenant").toBeNull();
  });
});

describe("opening a conversation", () => {
  test("loads its messages and clears the badge", async () => {
    threadsResolver = () => Promise.resolve({ data: [thread("t1", 3)], error: null });
    messagesResolver = () => Promise.resolve({ data: [message("m1", "hello")], error: null });

    await useChats.getState().loadThreads();
    await useChats.getState().select("t1");

    expect(useChats.getState().messages?.[0]?.body).toBe("hello");
    expect(useChats.getState().threads?.[0]?.unreadCount).toBe(0);
    // Cleared locally *and* on the server: a badge that only clears locally
    // comes back on the next load.
    expect(readCalls).toContain("t1");
  });

  test("messages for a thread the operator left are discarded", async () => {
    threadsResolver = () => Promise.resolve({ data: [thread("t1"), thread("t2")], error: null });
    await useChats.getState().loadThreads();

    let release: ((v: unknown) => void) | undefined;
    messagesResolver = (id) =>
      id === "t1"
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve({ data: [message("m2", "BO")], error: null });

    const first = useChats.getState().select("t1");
    await useChats.getState().select("t2");
    release?.({ data: [message("m1", "ANA")], error: null });
    await first;

    expect(useChats.getState().messages?.[0]?.body, "the old thread repainted the panel").toBe("BO");
  });
});

describe("refreshing the open conversation", () => {
  test("reloads the messages of the thread already on screen", async () => {
    // The bug this pins: the revision effect reloaded the thread list only, so
    // a message arriving in the conversation someone was reading bumped its
    // row and left the messages beside it stale until a re-select.
    threadsResolver = () => Promise.resolve({ data: [thread("t1")], error: null });
    messagesResolver = () => Promise.resolve({ data: [message("m1", "first")], error: null });
    await useChats.getState().loadThreads();
    await useChats.getState().select("t1");

    messagesResolver = () =>
      Promise.resolve({ data: [message("m1", "first"), message("m2", "second")], error: null });
    await useChats.getState().refresh();

    expect(useChats.getState().messages?.length, "the open conversation stayed stale").toBe(2);
  });

  test("does not blank the panel while it reloads", async () => {
    // A background reload repainting the conversation empty on every event is
    // a worse lie than a moment of stale text, so refresh must not clear.
    threadsResolver = () => Promise.resolve({ data: [thread("t1")], error: null });
    messagesResolver = () => Promise.resolve({ data: [message("m1", "hello")], error: null });
    await useChats.getState().loadThreads();
    await useChats.getState().select("t1");

    let release: ((v: unknown) => void) | undefined;
    messagesResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const inFlight = useChats.getState().refresh();
    expect(useChats.getState().messages?.[0]?.body, "refresh blanked the panel").toBe("hello");
    release?.({ data: [message("m1", "hello")], error: null });
    await inFlight;
  });

  test("does nothing when no conversation is open", async () => {
    // The revision effect calls it unconditionally, so this is the mount case.
    let called = false;
    messagesResolver = () => {
      called = true;
      return Promise.resolve({ data: [], error: null });
    };
    await useChats.getState().refresh();
    expect(called).toBe(false);
  });

  test("a response after the key changed is dropped", async () => {
    threadsResolver = () => Promise.resolve({ data: [thread("t1")], error: null });
    messagesResolver = () => Promise.resolve({ data: [message("m1", "ANA")], error: null });
    await useChats.getState().loadThreads();
    await useChats.getState().select("t1");

    let release: ((v: unknown) => void) | undefined;
    messagesResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    const inFlight = useChats.getState().refresh();
    useSession.setState({ apiKey: "key-b" });
    release?.({ data: [message("m9", "OTHER TENANT")], error: null });
    await inFlight;

    // Blank, not "ANA". This used to assert that key A's messages survived the
    // switch, which only checked that the *incoming* response was dropped and
    // quietly accepted the larger problem: key A's conversation still on
    // screen under key B's credential. The store is cleared on a key change
    // now, so the assertion is that nothing from either key is showing.
    expect(useChats.getState().messages, "the previous tenant's messages survived a key change").toBeNull();
  });

  test("the whole store is blanked when the key changes", async () => {
    // Not just the open conversation: the thread list, the draft and any error
    // belong to the credential that loaded them. Between accepting a new key
    // and its own requests landing, the screen renders — and it must not
    // render the previous tenant's.
    threadsResolver = () => Promise.resolve({ data: [thread("t1")], error: null });
    messagesResolver = () => Promise.resolve({ data: [message("m1", "ANA")], error: null });
    await useChats.getState().loadThreads();
    await useChats.getState().select("t1");
    useChats.setState({ draft: "half-typed reply" });

    expect(useChats.getState().threads).not.toBeNull();

    useSession.setState({ apiKey: "key-b" });

    const after = useChats.getState();
    expect(after.threads, "threads survived a key change").toBeNull();
    expect(after.messages, "messages survived a key change").toBeNull();
    expect(after.selectedId, "the selection survived a key change").toBeNull();
    expect(after.draft, "the draft survived a key change").toBe("");
  });
});

describe("replying", () => {
  test("clears the draft and refreshes the thread", async () => {
    threadsResolver = () => Promise.resolve({ data: [thread("t1")], error: null });
    messagesResolver = () => Promise.resolve({ data: [message("m1", "hi")], error: null });
    await useChats.getState().loadThreads();
    await useChats.getState().select("t1");

    useChats.getState().setDraft("replying");
    await useChats.getState().send();

    expect(useChats.getState().draft).toBe("");
  });

  test("a reply finishing after a thread switch does not repaint", async () => {
    // The exact hazard a reviewer found: send closes over the thread it was
    // called for, and the reload afterwards could win against the switch.
    threadsResolver = () => Promise.resolve({ data: [thread("t1"), thread("t2")], error: null });
    messagesResolver = (id) =>
      Promise.resolve({ data: [message(`m-${id}`, id === "t1" ? "ANA" : "BO")], error: null });
    await useChats.getState().loadThreads();
    await useChats.getState().select("t1");

    let release: ((v: unknown) => void) | undefined;
    sendResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });

    useChats.getState().setDraft("to ana");
    const sending = useChats.getState().send();
    await useChats.getState().select("t2");
    release?.({ data: {}, error: null });
    await sending;

    expect(useChats.getState().selectedId).toBe("t2");
    expect(useChats.getState().messages?.[0]?.body, "the reply repainted the old thread").toBe("BO");
  });

  test("an empty draft sends nothing", async () => {
    let called = false;
    sendResolver = () => {
      called = true;
      return Promise.resolve({ data: {}, error: null });
    };
    useChats.setState({ selectedId: "t1", draft: "   " });
    await useChats.getState().send();
    expect(called).toBe(false);
  });
});
