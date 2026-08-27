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

  // Only the newest load may commit, for the same reason as elsewhere in this
  // console: events arrive in bursts, so several loads can be in flight and
  // the last to resolve is not necessarily the last requested.
  const generation = useRef(0);

  const loadThreads = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const listed = await api.chats(apiKey);
      if (generation.current !== mine) return;
      setThreads(listed);
    } catch (err) {
      if (generation.current !== mine) return;
      setError(err instanceof ApiError ? err.message : "could not load conversations");
    }
  }, [apiKey]);

  const loadMessages = useCallback(
    async (threadId: string) => {
      const mine = ++generation.current;
      try {
        const listed = await api.chatMessages(apiKey, threadId);
        if (generation.current !== mine) return;
        setMessages(listed);
      } catch (err) {
        if (generation.current !== mine) return;
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
    setSelected(thread.id);
    setMessages(null);
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

    setSending(true);
    setError(null);
    try {
      await api.reply(apiKey, selected, draft);
      setDraft("");
      await loadMessages(selected);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not send");
    } finally {
      setSending(false);
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
