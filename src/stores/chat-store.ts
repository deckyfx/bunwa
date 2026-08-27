/**
 * Conversation history.
 *
 * bunwa became the system of record for this when gowa left
 * ([13](../../docs/13-owning-the-data.md)), which brings obligations the
 * control plane did not have: retention, deletion on request, and the fact
 * that one tenant reading another's messages is now a possible bug rather
 * than an impossible one. Every read here is scoped through the device, and
 * a device belongs to exactly one project.
 */
import { and, desc, eq, lt, sql } from "drizzle-orm";

import { db, type Database } from "../db";
import { chatMessages, chatThreads, virtualDevices } from "../db/schema";
import { withTransaction } from "../db/transaction";

export interface RecordedMessage {
  /**
   * The project's environment, not derivable from the device.
   *
   * Two projects may bind the same phone number, so a thread scoped through
   * the device is visible to both. Measured before this parameter existed: a
   * second project with an active binding read the first one's messages.
   */
  environmentId: string;
  deviceId: string;
  peerJid: string;
  direction: "inbound" | "outbound";
  providerMessageId: string | null;
  kind: "text" | "image" | "video" | "audio" | "document" | "unsupported";
  body: string | null;
  mediaId?: string | null;
  status?: "pending" | "sent" | "delivered" | "read" | "failed" | null;
  occurredAt: Date;
  displayName?: string | null;
}

export const ChatStore = {
  /**
   * Record a message, creating its thread if needed.
   *
   * Idempotent on `providerMessageId`: WhatsApp resends, and a duplicate row
   * shows the customer the same message twice. Returns null when the message
   * was already held, so a caller can tell a resend from a new arrival without
   * a second query.
   *
   * Thread upsert and message insert in one transaction — a thread with no
   * message is a phantom conversation in the console, and a message with no
   * thread cannot be displayed at all.
   */
  async record(input: RecordedMessage, database: Database = db()): Promise<{ id: string; threadId: string } | null> {
    return withTransaction(database, async (tx) => {
      if (input.providerMessageId !== null) {
        const [existing] = await tx
          .select({ id: chatMessages.id, threadId: chatMessages.threadId })
          .from(chatMessages)
          .where(
            and(
              eq(chatMessages.environmentId, input.environmentId),
              eq(chatMessages.deviceId, input.deviceId),
              eq(chatMessages.providerMessageId, input.providerMessageId),
            ),
          )
          .limit(1);
        if (existing !== undefined) return null;
      }

      const [thread] = await tx
        .insert(chatThreads)
        .values({
          environmentId: input.environmentId,
          deviceId: input.deviceId,
          peerJid: input.peerJid,
          displayName: input.displayName ?? null,
          lastMessageAt: input.occurredAt,
          unreadCount: input.direction === "inbound" ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [chatThreads.environmentId, chatThreads.deviceId, chatThreads.peerJid],
          set: {
            lastMessageAt: input.occurredAt,
            // Counted in SQL rather than read-then-written: two inbound
            // messages arriving together would otherwise both read the same
            // value and the count would drift low.
            unreadCount:
              input.direction === "inbound"
                ? sql`${chatThreads.unreadCount} + 1`
                : sql`${chatThreads.unreadCount}`,
            ...(input.displayName === undefined || input.displayName === null
              ? {}
              : { displayName: input.displayName }),
          },
        })
        .returning({ id: chatThreads.id });

      const [message] = await tx
        .insert(chatMessages)
        .values({
          threadId: thread!.id,
          deviceId: input.deviceId,
          environmentId: input.environmentId,
          direction: input.direction,
          providerMessageId: input.providerMessageId,
          kind: input.kind,
          body: input.body,
          mediaId: input.mediaId ?? null,
          status: input.status ?? (input.direction === "outbound" ? "pending" : null),
          occurredAt: input.occurredAt,
        })
        .returning({ id: chatMessages.id });

      return { id: message!.id, threadId: thread!.id };
    });
  },

  /**
   * Threads for one environment, newest first.
   *
   * Joined through virtual_devices so the environment is enforced in SQL
   * rather than by the caller remembering to pass the right device id.
   */
  async threadsForEnvironment(environmentId: string, limit = 50, database: Database = db()) {
    return database
      .select({
        id: chatThreads.id,
        deviceId: chatThreads.deviceId,
        // Nullable because the join is for display only: a binding that has
        // been revoked leaves the history intact and the alias unknown.
        alias: virtualDevices.alias,
        peerJid: chatThreads.peerJid,
        displayName: chatThreads.displayName,
        lastMessageAt: chatThreads.lastMessageAt,
        unreadCount: chatThreads.unreadCount,
      })
      .from(chatThreads)
      // Joined only for the alias shown in the console. The scope comes from
      // the thread's own environment_id, so a second project bound to the same
      // device cannot match.
      .leftJoin(virtualDevices, and(
        eq(virtualDevices.deviceId, chatThreads.deviceId),
        eq(virtualDevices.environmentId, chatThreads.environmentId),
      ))
      .where(eq(chatThreads.environmentId, environmentId))
      .orderBy(desc(chatThreads.lastMessageAt))
      .limit(limit);
  },

  /** Messages in a thread, oldest first, scoped to the environment that owns it. */
  async messagesInThread(environmentId: string, threadId: string, limit = 200, database: Database = db()) {
    return database
      .select({
        id: chatMessages.id,
        direction: chatMessages.direction,
        kind: chatMessages.kind,
        body: chatMessages.body,
        mediaId: chatMessages.mediaId,
        status: chatMessages.status,
        occurredAt: chatMessages.occurredAt,
      })
      .from(chatMessages)
      .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.environmentId, environmentId)))
      .orderBy(chatMessages.occurredAt)
      .limit(limit);
  },

  /** Mark a thread read. Scoped, so one tenant cannot clear another's badge. */
  async markRead(environmentId: string, threadId: string, database: Database = db()): Promise<boolean> {
    const owned = await this.threadIsOwnedBy(environmentId, threadId, database);
    if (!owned) return false;
    await database.update(chatThreads).set({ unreadCount: 0 }).where(eq(chatThreads.id, threadId));
    return true;
  },

  /** Whether an environment owns a thread. The check every mutation needs. */
  async threadIsOwnedBy(environmentId: string, threadId: string, database: Database = db()): Promise<boolean> {
    const [row] = await database
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(and(eq(chatThreads.id, threadId), eq(chatThreads.environmentId, environmentId)))
      .limit(1);
    return row !== undefined;
  },

  /** Update an outbound message's status when an ack arrives. */
  async markStatus(
    environmentId: string,
    deviceId: string,
    providerMessageId: string,
    status: "sent" | "delivered" | "read" | "failed",
    database: Database = db(),
  ): Promise<void> {
    await database
      .update(chatMessages)
      .set({ status })
      .where(
        and(
          eq(chatMessages.environmentId, environmentId),
          eq(chatMessages.deviceId, deviceId),
          eq(chatMessages.providerMessageId, providerMessageId),
        ),
      );
  },

  /**
   * Delete messages older than the cutoff.
   *
   * The reason this exists in the same commit as the table. Chat history is
   * the first unbounded thing in the system, and stage 2 shipped three sweeps
   * with no caller — a fourth would be the same mistake with a far bigger
   * table behind it.
   *
   * Threads are left alone: an empty conversation is still a conversation, and
   * deleting it would make the peer vanish from the console rather than merely
   * lose its history.
   */
  async sweepOlderThan(cutoff: Date, database: Database = db()): Promise<number> {
    const removed = await database
      .delete(chatMessages)
      .where(lt(chatMessages.occurredAt, cutoff))
      .returning({ id: chatMessages.id });
    return removed.length;
  },
};
