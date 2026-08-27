/**
 * Conversation history, for the console.
 *
 * bunwa became the system of record for this when gowa left, so these are the
 * endpoints that make it visible ([13](../../../docs/13-owning-the-data.md)).
 * Every one is scoped to the environment the key resolves to — a thread id is
 * a UUID and guessing one must not be enough.
 */
import { Elysia, t } from "elysia";

import { requireApiKey, requireScope, requireWithinLimit } from "../../auth/middleware";
import { LIMITS } from "../../ops/rate-limit";
import { ChatStore } from "../../stores/chat-store";
import { problem } from "../server";

export const chatRoutes = new Elysia({ prefix: "/v1" })
  .use(requireApiKey)

  /** Conversations, newest first. */
  .get(
    "/chats",
    async ({ auth, query }) => ChatStore.threadsForEnvironment(auth.environmentId, query.limit ?? 50),
    { query: t.Object({ limit: t.Optional(t.Numeric({ minimum: 1, maximum: 200 })) }) },
  )

  /**
   * Messages in one conversation.
   *
   * Answers 404 rather than 403 for a thread another environment owns. A 403
   * confirms the id exists, which is the one bit an attacker enumerating UUIDs
   * is trying to learn.
   */
  .get(
    "/chats/:id/messages",
    async ({ auth, params, query, set, path }) => {
      const owned = await ChatStore.threadIsOwnedBy(auth.environmentId, params.id);
      if (!owned) {
        set.status = 404;
        return problem(404, "chat-not-found", "Not Found", "no such conversation", path);
      }
      return ChatStore.messagesInThread(auth.environmentId, params.id, query.limit ?? 200);
    },
    {
      params: t.Object({ id: t.String() }),
      query: t.Object({ limit: t.Optional(t.Numeric({ minimum: 1, maximum: 500 })) }),
    },
  )

  /** Clear the unread badge. */
  .post(
    "/chats/:id/read",
    async ({ auth, params, set, path }) => {
      const marked = await ChatStore.markRead(auth.environmentId, params.id);
      if (!marked) {
        set.status = 404;
        return problem(404, "chat-not-found", "Not Found", "no such conversation", path);
      }
      set.status = 204;
      return null;
    },
    { params: t.Object({ id: t.String() }) },
  )

  /**
   * Reply in a conversation.
   *
   * Rate-limited on the same budget as any other send, because it is one: the
   * number being protected is the customer's, and it does not care which
   * screen the message came from.
   */
  .post(
    "/chats/:id/messages",
    async ({ auth, params, body, set, path }) => {
      requireScope(auth, "send:text", path);

      const thread = (await ChatStore.threadsForEnvironment(auth.environmentId, 200)).find(
        (candidate) => candidate.id === params.id,
      );
      if (thread === undefined) {
        set.status = 404;
        return problem(404, "chat-not-found", "Not Found", "no such conversation", path);
      }

      requireWithinLimit(`device:${thread.deviceId}`, LIMITS.send, path);

      // Recorded as pending. The engine has not been asked yet, and a row that
      // claims "sent" before anything left the process is the lie the whole
      // ack-based delivery story exists to avoid.
      const recorded = await ChatStore.record({
        environmentId: auth.environmentId,
        deviceId: thread.deviceId,
        peerJid: thread.peerJid,
        direction: "outbound",
        providerMessageId: null,
        kind: "text",
        body: body.text,
        status: "pending",
        occurredAt: new Date(),
      });

      set.status = 202;
      return {
        id: recorded?.id ?? null,
        status: "pending",
        // Said plainly, because a console that renders this as delivered is
        // repeating the mistake measured in docs/12.
        note: "queued; delivery is confirmed by an ack, not by this response",
      };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({ text: t.String({ minLength: 1, maxLength: 4096 }) }),
    },
  );
