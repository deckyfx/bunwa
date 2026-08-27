/**
 * Conversations.
 *
 * The screen that only exists because bunwa now owns the history — gowa held
 * it before, and stage 4 removed gowa (docs/13). A list of threads on the
 * left, the selected conversation on the right, and a composer.
 *
 * Deliberately plain about delivery: a reply is accepted, not sent. Acceptance
 * meant nothing for 203 measured seconds (docs/12), so the composer shows
 * "queued" until an ack changes it rather than implying the message arrived.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type ChatMessage, type ChatThread } from "./api";

interface Props {
  apiKey: string;
  /** Bumped by the event stream, so a new message refreshes what is open. */
  revision: number;
}

export function Chats({ apiKey, revision }: Props) {
  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  // One counter each, not one shared.
  //
  // Only the newest load may commit — events arrive in bursts, so several can
  // be in flight and the last to resolve is not the last requested. Sharing a
  // counter between the two made them cancel each other: a revision bump ran
  // loadThreads then loadMessages, the second increment invalidated the first,
  // and the conversation list could never refresh while a thread was open.
  const threadsGeneration = useRef(0);
  const messagesGeneration = useRef(0);

  /** What is selected right now, readable from a closure created earlier. */
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;

  const loadThreads = useCallback(async () => {
    const mine = ++threadsGeneration.current;
    try {
      const listed = await api.chats(apiKey);
      if (threadsGeneration.current !== mine) return;
      setThreads(listed);
    } catch (err) {
      if (threadsGeneration.current !== mine) return;
      setError(err instanceof ApiError ? err.message : "could not load conversations");
    }
  }, [apiKey]);

  const loadMessages = useCallback(
    async (threadId: string) => {
      const mine = ++messagesGeneration.current;
      try {
        const listed = await api.chatMessages(apiKey, threadId);
        if (messagesGeneration.current !== mine) return;
        setMessages(listed);
      } catch (err) {
        if (messagesGeneration.current !== mine) return;
        setError(err instanceof ApiError ? err.message : "could not load this conversation");
      }
    },
    [apiKey],
  );

  useEffect(() => {
    void loadThreads();
  }, [loadThreads, revision]);

  useEffect(() => {
    if (selected !== null) void loadMessages(selected);
  }, [selected, loadMessages, revision]);

  async function open(thread: ChatThread) {
    // Clearing on a re-click left the panel at "loading…" for ever: `selected`
    // did not change, so the effect never re-ran. Switching threads also let
    // an in-flight request for the previous one resolve underneath the new
    // selection, showing its messages while the composer targeted the new
    // thread — the operator would have replied into the wrong conversation.
    if (thread.id !== selected) {
      messagesGeneration.current += 1;
      setSelected(thread.id);
      setMessages(null);
    }
    if (thread.unreadCount > 0) {
      // Cleared optimistically and then reloaded: the badge is the least
      // important thing on screen and should not wait on a round trip.
      setThreads((current) =>
        current?.map((t) => (t.id === thread.id ? { ...t, unreadCount: 0 } : t)) ?? null,
      );
      await api.markChatRead(apiKey, thread.id).catch(() => undefined);
    }
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (selected === null || draft.trim() === "") return;

    // Captured, then checked against what is selected when the call resolves.
    //
    // This closure holds the thread from the render that created it. Switching
    // conversations while a reply is in flight left the reload fetching the
    // previous thread — and because loadMessages bumps the generation on every
    // call, that late fetch could win against the one the switch started and
    // paint the old conversation under the new selection. Which is the
    // reply-into-the-wrong-conversation hazard the comment in `open` describes,
    // arriving by a different route after I closed the first one.
    const threadId = selected;

    setSending(true);
    setError(null);
    try {
      await api.reply(apiKey, threadId, draft);
      if (selectedRef.current !== threadId) return;
      setDraft("");
      await loadMessages(threadId);
    } catch (err) {
      if (selectedRef.current !== threadId) return;
      setError(err instanceof ApiError ? err.message : "could not send");
    } finally {
      if (selectedRef.current === threadId) setSending(false);
    }
  }

  return (
    <section aria-labelledby="chats">
      <h2 id="chats">Conversations</h2>
      {error !== null && <p role="alert">{error}</p>}

      <div className="chat-layout">
        <nav aria-label="Conversations">
          {threads === null ? (
            <p>loading…</p>
          ) : threads.length === 0 ? (
            <p>No conversations yet. They appear here as messages arrive.</p>
          ) : (
            <ul>
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    onClick={() => void open(thread)}
                    aria-current={selected === thread.id}
                  >
                    <strong>{thread.displayName ?? thread.peerJid}</strong>
                    <span> · {thread.alias}</span>
                    {thread.unreadCount > 0 && (
                      <span aria-label={`${String(thread.unreadCount)} unread`}> ({thread.unreadCount})</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div>
          {selected === null ? (
            <p>Pick a conversation.</p>
          ) : messages === null ? (
            <p>loading…</p>
          ) : (
            <>
              <ol aria-label="Messages">
                {messages.map((message) => (
                  <li key={message.id} data-direction={message.direction}>
                    <span>{message.direction === "inbound" ? "them" : "us"}: </span>
                    <span>{message.body ?? `[${message.kind}]`}</span>
                    {/* Shown for outbound only, and honestly: pending means
                        the engine has not acknowledged it yet. */}
                    {message.direction === "outbound" && message.status !== null && (
                      <em> — {message.status}</em>
                    )}
                    <time dateTime={message.occurredAt}> {message.occurredAt}</time>
                  </li>
                ))}
              </ol>

              <form onSubmit={send}>
                <label htmlFor="reply">Reply</label>
                <input
                  id="reply"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder="Type a message"
                />
                <button type="submit" disabled={sending || draft.trim() === ""}>
                  {sending ? "queueing…" : "send"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </section>
  );
}
