/**
 * The conversations page, for the one property that cannot live in the store.
 *
 * The store's `refresh` can be tested directly; that the page *calls* it on
 * every event cannot. The defect this pins was exactly that gap — `refresh`
 * would have worked, and the effect only reloaded the thread list, so the
 * conversation on screen stayed stale while its row updated beside it.
 *
 * The rest of this page's behaviour is covered in chats.test.ts, where the
 * races live. This file exists for the wiring.
 */
import { describe, expect, test, afterEach, beforeEach, mock } from "bun:test";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";

let messagesResolver: () => Promise<unknown> = () => Promise.resolve({ data: [], error: null });
let threadsResolver: () => Promise<unknown> = () => Promise.resolve({ data: [], error: null });

void mock.module("../lib/api", () => ({
  client: () => ({
    v1: {
      chats: Object.assign(
        () => ({
          messages: { get: () => messagesResolver(), post: () => Promise.resolve({ error: null }) },
          read: { post: () => Promise.resolve({ data: null, error: null }) },
        }),
        { get: () => threadsResolver() },
      ),
    },
  }),
  anonymous: () => ({}),
}));

const { ChatsPage } = await import("../pages/ChatsPage");
const { useChats } = await import("../store/chats");
const { useSession } = await import("../store/session");
const { useRoute } = await import("../store/route");

const thread = {
  id: "t1",
  deviceId: "d1",
  alias: "otp",
  peerJid: "628111@s.whatsapp.net",
  displayName: "Ana",
  lastMessageAt: null,
  unreadCount: 0,
};

const message = (id: string, body: string) => ({
  id,
  direction: "inbound" as const,
  kind: "text",
  body,
  mediaId: null,
  status: null,
  occurredAt: new Date(0),
});

// Explicit rather than relying on Testing Library's auto-cleanup, which
// registers itself once against whichever file imports it first. That made
// this file's isolation a property of the alphabet: adding a second rendering
// test file elsewhere took the cleanup away, and both renders in this file
// stayed in the document until a query matched two nodes and threw.
afterEach(cleanup);

beforeEach(() => {
  // The address decides which conversation is open, so it has to be reset like
  // any other shared state — a leftover fragment would open a conversation the
  // next test never asked for.
  window.location.hash = "";
  useRoute.setState({ route: { section: "chats", detail: null } });
  useSession.setState({ apiKey: "key-a", identity: null, error: null, busy: false, revision: 0 });
  useChats.setState({
    threads: null,
    selectedId: null,
    messages: null,
    draft: "",
    sending: false,
    error: null,
  });
  threadsResolver = () => Promise.resolve({ data: [thread], error: null });
  messagesResolver = () => Promise.resolve({ data: [message("m1", "first")], error: null });
});

describe("live updates", () => {
  test("an event repaints the open conversation, not only the thread list", async () => {
    render(<ChatsPage />);
    await screen.findByText("Ana");

    // act, because these updates originate in the store rather than in an
    // event React dispatched — without it React warns that the render it
    // produced was never flushed under test.
    // Through the address, because that is what a click does now: the page
    // opens whatever the route says rather than selecting directly.
    await act(async () => {
      useRoute.getState().navigate("chats", "t1");
    });
    await screen.findByText("first");

    // A message arrives in the conversation being read. The event stream bumps
    // the revision; nothing else tells the page anything changed.
    messagesResolver = () =>
      Promise.resolve({ data: [message("m1", "first"), message("m2", "second")], error: null });
    await act(async () => {
      useSession.getState().bumpRevision();
    });

    await waitFor(() => {
      expect(screen.getByText("second")).toBeDefined();
    });
  });

  test("an event with nothing open does not ask for messages", async () => {
    let asked = false;
    messagesResolver = () => {
      asked = true;
      return Promise.resolve({ data: [], error: null });
    };

    render(<ChatsPage />);
    await screen.findByText("Ana");
    await act(async () => {
      useSession.getState().bumpRevision();
    });
    await waitFor(() => {
      expect(screen.getByText("Pick a conversation.")).toBeDefined();
    });

    expect(asked).toBe(false);
  });
});

describe("the address opens a conversation", () => {
  test("a deep link restores it without a click", async () => {
    // The whole point: a reload, a bookmark and a pasted link land on the same
    // conversation. Before this the page always came back on the thread list.
    useRoute.setState({ route: { section: "chats", detail: "t1" } });

    render(<ChatsPage />);

    expect(await screen.findByText("first")).toBeDefined();
  });

  test("an address naming a conversation this environment does not have is ignored", async () => {
    // The address is attacker-editable. Selecting an unknown id would ask the
    // server for messages in a conversation that may belong to someone else,
    // and the 404 would be the console's own doing.
    useRoute.setState({ route: { section: "chats", detail: "not-a-thread" } });

    render(<ChatsPage />);
    await screen.findByText("Ana");

    expect(screen.getByText("Pick a conversation.")).toBeDefined();
  });

  test("clearing the detail closes the conversation", async () => {
    // Back, from a conversation to the list.
    useRoute.setState({ route: { section: "chats", detail: "t1" } });
    render(<ChatsPage />);
    await screen.findByText("first");

    await act(async () => {
      useRoute.setState({ route: { section: "chats", detail: null } });
    });

    await waitFor(() => {
      expect(screen.getByText("Pick a conversation.")).toBeDefined();
    });
  });

  test("clicking a thread changes the address rather than only the screen", async () => {
    // Two paths doing the same work is how a back button ends up changing the
    // URL while the screen stays put.
    render(<ChatsPage />);
    const row = await screen.findByText("Ana");

    await act(async () => {
      row.closest("button")?.click();
    });

    expect(useRoute.getState().route).toEqual({ section: "chats", detail: "t1" });
  });
});
