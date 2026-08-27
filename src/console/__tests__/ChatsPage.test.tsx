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
import { describe, expect, test, beforeEach, mock } from "bun:test";
import { act, render, screen, waitFor } from "@testing-library/react";

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
    await act(async () => {
      await useChats.getState().select("t1");
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
