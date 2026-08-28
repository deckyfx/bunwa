/**
 * Conversations, and the one that is open.
 *
 * The screen this replaces held threads, messages, selection, drafts and two
 * request-generation counters in component state. Three separate races came
 * out of that arrangement, each fixed individually: a reply landing after the
 * thread changed, two loaders sharing one counter and cancelling each other,
 * and a component that unmounted mid-request.
 *
 * A store does not remove the races — a slow response still lands late — but
 * it gives them one place to be handled rather than one per component, and
 * the guard is the same shape every time: compare against what is current now.
 */
import { create } from "zustand";

import { client } from "../lib/api";
import { useSession } from "./session";

/**
 * Derived from the server, not declared here.
 *
 * Writing these by hand is what this whole change exists to stop. The previous
 * versions were wrong three times: `Whoami` had nested objects the server does
 * not send, `VirtualDevice` had an `id` and a `lastSeenAt` that do not exist,
 * and this file's first draft typed `occurredAt` as a string when the server
 * returns a Date. Eden knew all three immediately.
 */
type Api = ReturnType<typeof client>;

/**
 * The success payload of an Eden call.
 *
 * `data` is a union of the body and the error shape, so the array element has
 * to be picked out of the half that is a list. Extract rather than exclude:
 * naming what we want is steadier than enumerating what we do not.
 */
type Rows<T> = T extends { data: infer D } ? Extract<NonNullable<D>, readonly unknown[]> : never;

export type ChatThread = Rows<Awaited<ReturnType<Api["v1"]["chats"]["get"]>>>[number];
export type ChatMessage = Rows<
  Awaited<ReturnType<ReturnType<Api["v1"]["chats"]>["messages"]["get"]>>
>[number];

interface ChatState {
  threads: ChatThread[] | null;
  selectedId: string | null;
  messages: ChatMessage[] | null;
  draft: string;
  sending: boolean;
  error: string | null;

  loadThreads: () => Promise<void>;
  select: (threadId: string) => Promise<void>;
  setDraft: (text: string) => void;
  send: () => Promise<void>;
}

/**
 * Which selection request is the current one.
 *
 * The two guards below — same thread, same key — are not enough on their own.
 * Selecting A, then B, then A again leaves two requests for A outstanding, and
 * both satisfy every check when they land, so whichever resolves last wins
 * regardless of which was asked for last. The older one then paints a message
 * list the newer request has already replaced.
 *
 * Module scope rather than store state: nothing renders it, and putting it in
 * the store would make every in-flight request a re-render.
 */
let selectionGeneration = 0;

export const useChats = create<ChatState>((set, get) => ({
  threads: null,
  selectedId: null,
  messages: null,
  draft: "",
  sending: false,
  error: null,

  loadThreads: async () => {
    const { apiKey } = useSession.getState();
    if (apiKey === "") return;

    const { data, error } = await client(apiKey).v1.chats.get();

    // Still the same session? A key change between request and response would
    // otherwise paint the previous tenant's conversations.
    if (useSession.getState().apiKey !== apiKey) return;

    if (error !== null || !Array.isArray(data)) {
      set({ error: "could not load conversations" });
      return;
    }
    set({ threads: data, error: null });
  },

  select: async (threadId: string) => {
    const mine = ++selectionGeneration;
    const { apiKey } = useSession.getState();
    // Same early return as loadThreads. Without a credential the request is
    // refused, and the refusal became "could not load this conversation" — an
    // error about the conversation, on a screen whose actual state is that
    // nobody is signed in. Signed out is not a failed load.
    if (apiKey === "") return;

    set({ selectedId: threadId, messages: null, error: null });

    const { data, error } = await client(apiKey).v1.chats({ id: threadId }).messages.get();

    // The newest request for this thread, not merely one for the thread that
    // happens to be open.
    if (selectionGeneration !== mine) return;
    // The thread the operator is looking at now, not the one they clicked.
    if (get().selectedId !== threadId) return;
    if (useSession.getState().apiKey !== apiKey) return;

    // Array.isArray as well as the error check.
    //
    // The chat routes answer a missing thread with `set.status = 404` and the
    // problem document as an ordinary return value, so Eden types it as part
    // of `data` rather than as `error`. That is the route's convention to fix
    // — Elysia's `status()` would put it where it belongs — and until then the
    // client narrows rather than trusting a union it cannot distinguish.
    if (error !== null || !Array.isArray(data)) {
      set({ error: "could not load this conversation" });
      return;
    }

    set({ messages: data });

    // Clear the badge optimistically, then tell the server. The badge is the
    // least important thing on screen and should not wait for a round trip.
    const thread = get().threads?.find((candidate) => candidate.id === threadId);
    if (thread !== undefined && thread.unreadCount > 0) {
      set({
        threads:
          get().threads?.map((t) => (t.id === threadId ? { ...t, unreadCount: 0 } : t)) ?? null,
      });
      await client(apiKey).v1.chats({ id: threadId }).read.post();
    }
  },

  setDraft: (text: string) => {
    set({ draft: text });
  },

  send: async () => {
    const { selectedId, draft } = get();
    const { apiKey } = useSession.getState();
    // apiKey too, for the reason select() has it: a send with no credential
    // reported "could not send" as though the message had been rejected.
    if (apiKey === "" || selectedId === null || draft.trim() === "") return;

    set({ sending: true, error: null });
    const { error } = await client(apiKey).v1.chats({ id: selectedId }).messages.post({
      text: draft,
    });

    // Everything below is skipped if the operator moved on. Sending into one
    // conversation and repainting another is the specific hazard this guards.
    if (get().selectedId !== selectedId) {
      set({ sending: false });
      return;
    }

    if (error !== null) {
      set({ sending: false, error: "could not send" });
      return;
    }

    set({ draft: "", sending: false });
    await get().select(selectedId);
  },
}));
