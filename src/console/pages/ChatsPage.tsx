/**
 * Conversations.
 *
 * Exists because bunwa owns the history now — gowa held it before, and stage 4
 * removed gowa (docs/13).
 *
 * Deliberately plain about delivery: a reply is accepted, not sent. Acceptance
 * meant nothing for 203 measured seconds (docs/12), so an outbound message
 * shows its status rather than implying it arrived.
 */
import { useEffect } from "react";

import { MessagesSquare } from "lucide-react";

import { Card } from "../components/Card";
import { useRoute } from "../store/route";
import { StatusPill } from "../components/StatusPill";
import { useChats } from "../store/chats";
import { useServerTimezone, useSession } from "../store/session";
import { renderDateTime, renderIso } from "../../time/render";

/**
 * A message timestamp, in both forms a `<time>` element wants.
 *
 * Rendered in the server's zone so this reads the same as the logs it will be
 * compared against, rather than in whatever zone the reader's browser is in.
 *
 * Tolerant of a string as well as a Date, and of neither being valid: Eden
 * revives the field from JSON, and `renderIso`/`renderDateTime` both throw on a
 * non-finite date — inside a list render, which would take the whole
 * conversation down rather than show one bad row. Verified that they throw
 * rather than assumed.
 */
function occurredAt(value: Date | string, zone: string): { machine: string; human: string } {
  const at = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(at.getTime())) return { machine: "", human: String(value) };
  return { machine: renderIso(at, zone), human: renderDateTime(at, zone) };
}

export function ChatsPage() {
  const revision = useSession((s) => s.revision);
  const zone = useServerTimezone();
  const wanted = useRoute((s) => (s.route.section === "chats" ? s.route.detail : null));
  const navigate = useRoute((s) => s.navigate);
  const {
    threads,
    selectedId,
    messages,
    draft,
    sending,
    error,
    loadThreads,
    select,
    clearSelection,
    refresh,
    setDraft,
    send,
  } = useChats();

  // Both, on every event. The thread list alone left the conversation actually
  // on screen stale: a new message bumped its row and its unread badge while
  // the messages beside them did not move until the operator clicked away and
  // back. `refresh` is a no-op when nothing is selected.
  useEffect(() => {
    void loadThreads();
    void refresh();
  }, [loadThreads, refresh, revision]);

  /*
   * The address decides which conversation is open, not a click.
   *
   * So a reload, a bookmark and the back button all land on the same one. The
   * click handler navigates and this opens what the address then says, rather
   * than the two doing the work separately — which is how a back button ends
   * up changing the URL while the screen stays put.
   *
   * Guarded on the thread being known: the address is read before the list has
   * loaded, and selecting an id the server has not confirmed would ask for
   * messages in a conversation this environment may not own.
   */
  useEffect(() => {
    if (wanted === null) {
      if (selectedId !== null) clearSelection();
      return;
    }
    if (wanted === selectedId) return;
    if (threads === null) return;
    if (!threads.some((thread) => thread.id === wanted)) {
      // Cleared, not just ignored. Returning left the previous conversation on
      // screen under an address naming a different one — and the thread list
      // has loaded by this point, so the id is known to be absent rather than
      // merely not arrived yet.
      clearSelection();
      return;
    }

    void select(wanted);
  }, [wanted, selectedId, threads, select, clearSelection]);

  return (
    <Card id="chats" title="Conversations" icon={MessagesSquare} className="[&>div]:p-0">

      {error !== null && (
        <p role="alert" className="p-4 text-sm text-rose-700 dark:text-rose-400">
          {error}
        </p>
      )}

      {/* A fixed height so the two columns scroll independently. Without it
          the page grows to the length of the longest conversation and the
          thread list disappears above the fold — the one thing you need to
          switch away from a long conversation. */}
      <div className="grid h-[calc(100vh-11rem)] gap-0 sm:grid-cols-[18rem_1fr]">
        <nav
          aria-label="Conversations"
          className="overflow-y-auto border-slate-200 sm:border-r dark:border-slate-800"
        >
          {threads === null ? (
            <p className="p-4 text-sm text-slate-500">loading…</p>
          ) : threads.length === 0 ? (
            <p className="p-4 text-sm text-slate-500">
              No conversations yet. They appear here as messages arrive.
            </p>
          ) : (
            <ul>
              {threads.map((thread) => (
                <li key={thread.id}>
                  <button
                    type="button"
                    // Navigate rather than select. The effect above opens
                    // whatever the address ends up saying, so one path does
                    // the work and the back button behaves.
                    onClick={() => {
                      navigate("chats", thread.id);
                    }}
                    aria-current={selectedId === thread.id}
                    className="flex w-full flex-col items-start gap-0.5 border-b border-slate-100 p-3 text-left hover:bg-slate-50 aria-[current=true]:bg-slate-100 dark:border-slate-900 dark:hover:bg-slate-900 dark:aria-[current=true]:bg-slate-800"
                  >
                    <span className="font-medium">{thread.displayName ?? thread.peerJid}</span>
                    <span className="text-xs text-slate-500">{thread.alias}</span>
                    {thread.unreadCount > 0 && (
                      <span
                        aria-label={`${String(thread.unreadCount)} unread`}
                        className="rounded-full bg-slate-900 px-2 text-xs text-white dark:bg-slate-100 dark:text-slate-900"
                      >
                        {thread.unreadCount}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </nav>

        <div className="overflow-y-auto p-4">
          {selectedId === null ? (
            <p className="text-sm text-slate-500">Pick a conversation.</p>
          ) : messages === null ? (
            <p className="text-sm text-slate-500">loading…</p>
          ) : (
            <>
              <ol aria-label="Messages" className="flex flex-col gap-2">
                {messages.map((message) => (
                  <li
                    key={message.id}
                    data-direction={message.direction}
                    className={
                      message.direction === "inbound"
                        ? "max-w-prose self-start rounded-lg bg-slate-100 px-3 py-2 text-sm dark:bg-slate-800"
                        : "max-w-prose self-end rounded-lg bg-sky-100 px-3 py-2 text-sm dark:bg-sky-950"
                    }
                  >
                    <p>{message.body ?? `[${message.kind}]`}</p>
                    <div className="mt-1 flex items-center gap-2 text-xs text-slate-500">
                      {/* `dateTime` must be machine-readable and the visible
                          text must not be — String(date) gave both the same
                          "Thu Aug 28 2026 06:15:04 GMT+0700", which is not a
                          valid datetime value and is more than a reader needs. */}
                      <time dateTime={occurredAt(message.occurredAt, zone).machine}>
                        {occurredAt(message.occurredAt, zone).human}
                      </time>
                      {/* Outbound only, and honest: pending means the engine
                          has not acknowledged it yet. */}
                      {message.direction === "outbound" && message.status !== null && (
                        <StatusPill state={message.status} />
                      )}
                    </div>
                  </li>
                ))}
              </ol>

              <form
                className="mt-4 flex gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send();
                }}
              >
                <label htmlFor="reply" className="sr-only">
                  Reply
                </label>
                <input
                  id="reply"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                  }}
                  placeholder="Type a message"
                  className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
                />
                <button
                  type="submit"
                  disabled={sending || draft.trim() === ""}
                  className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
                >
                  {sending ? "queueing…" : "send"}
                </button>
              </form>
            </>
          )}
        </div>
      </div>
    </Card>
  );
}
