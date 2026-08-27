/**
 * The conversations screen.
 *
 * Focused on the two things that would mislead an operator: a reply rendered
 * as delivered when it is only queued, and a badge that clears without the
 * server being told.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import { Chats } from "../Chats";
import { api, type ChatMessage, type ChatThread } from "../api";

const REAL = { chats: api.chats, chatMessages: api.chatMessages, markChatRead: api.markChatRead, reply: api.reply };

afterEach(() => {
  cleanup();
  Object.assign(api, REAL);
});

const thread: ChatThread = {
  id: "t1",
  deviceId: "d1",
  alias: "otp-sender",
  peerJid: "628999@s.whatsapp.net",
  displayName: "Ana",
  lastMessageAt: new Date(1_000).toISOString(),
  unreadCount: 2,
};

const inbound: ChatMessage = {
  id: "m1",
  direction: "inbound",
  kind: "text",
  body: "is my code coming?",
  mediaId: null,
  status: null,
  occurredAt: new Date(1_000).toISOString(),
};

describe("conversations", () => {
  test("lists threads with their unread count", async () => {
    (api as { chats: typeof api.chats }).chats = async () => [thread];
    (api as { chatMessages: typeof api.chatMessages }).chatMessages = async () => [];

    render(<Chats apiKey="k" revision={0} />);
    await waitFor(() => expect(screen.getByText("Ana")).toBeDefined());
    expect(screen.getByLabelText("2 unread")).toBeDefined();
  });

  test("opening a thread tells the server it was read", async () => {
    let markedFor: string | null = null;
    (api as { chats: typeof api.chats }).chats = async () => [thread];
    (api as { chatMessages: typeof api.chatMessages }).chatMessages = async () => [inbound];
    (api as { markChatRead: typeof api.markChatRead }).markChatRead = async (_k, id) => {
      markedFor = id;
      return null;
    };

    render(<Chats apiKey="k" revision={0} />);
    await waitFor(() => expect(screen.getByText("Ana")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Ana/ }));

    await waitFor(() => expect(markedFor).toBe("t1"));
    // The badge clears optimistically, but the server was still told — a
    // badge that only clears locally comes back on the next load.
    expect(screen.queryByLabelText("2 unread")).toBeNull();
  });

  test("an outbound message shows its status rather than implying delivery", async () => {
    // The measured failure this guards: acceptance meant nothing for 203
    // seconds (docs/12). A console that renders queued as sent repeats it.
    (api as { chats: typeof api.chats }).chats = async () => [{ ...thread, unreadCount: 0 }];
    (api as { chatMessages: typeof api.chatMessages }).chatMessages = async () => [
      inbound,
      { ...inbound, id: "m2", direction: "outbound", body: "on its way", status: "pending" },
    ];

    render(<Chats apiKey="k" revision={0} />);
    await waitFor(() => expect(screen.getByText("Ana")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Ana/ }));

    await waitFor(() => expect(screen.getByText("on its way")).toBeDefined());
    expect(screen.getByText("— pending")).toBeDefined();
  });

  test("sending clears the box and reloads the thread", async () => {
    let sent: string | null = null;
    let loads = 0;
    (api as { chats: typeof api.chats }).chats = async () => [{ ...thread, unreadCount: 0 }];
    (api as { chatMessages: typeof api.chatMessages }).chatMessages = async () => {
      loads += 1;
      return [inbound];
    };
    (api as { reply: typeof api.reply }).reply = async (_k, _t, text) => {
      sent = text;
      return { id: "m9", status: "pending" };
    };

    render(<Chats apiKey="k" revision={0} />);
    await waitFor(() => expect(screen.getByText("Ana")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Ana/ }));
    await waitFor(() => expect(loads).toBeGreaterThan(0));

    const before = loads;
    fireEvent.change(screen.getByLabelText("Reply"), { target: { value: "yes, sending now" } });
    fireEvent.click(screen.getByRole("button", { name: "send" }));

    await waitFor(() => expect(sent).toBe("yes, sending now"));
    await waitFor(() => expect(loads).toBeGreaterThan(before));
    expect((screen.getByLabelText("Reply") as HTMLInputElement).value).toBe("");
  });

  test("an empty reply cannot be sent", async () => {
    (api as { chats: typeof api.chats }).chats = async () => [{ ...thread, unreadCount: 0 }];
    (api as { chatMessages: typeof api.chatMessages }).chatMessages = async () => [inbound];

    render(<Chats apiKey="k" revision={0} />);
    await waitFor(() => expect(screen.getByText("Ana")).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: /Ana/ }));
    await waitFor(() => expect(screen.getByLabelText("Reply")).toBeDefined());

    expect((screen.getByRole("button", { name: "send" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
