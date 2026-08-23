/**
 * Outbound messages.
 *
 * Records what was accepted so an ack can be matched to it later. The
 * distinction the whole table exists for: `accepted` means the engine took the
 * message, `delivered` means WhatsApp acknowledged it. gowa reported a device
 * connected for 203 seconds after a silent drop (docs/12), so the first says
 * far less than it appears to.
 */
import { and, count as drizzleCount, eq, gt, inArray, lt } from "drizzle-orm";

import { db, type Database } from "../db";
import { outboundMessages, type OutboundMessage } from "../db/schema";
import { NotFoundError } from "./errors";

/** How long to wait for an ack before calling a message undelivered. */
export const ACK_TIMEOUT_MS = 60_000;

export class MessageStore {
  static async recordAccepted(
    input: {
      virtualDeviceId: string;
      environmentId: string;
      engineMessageId: string;
      type: OutboundMessage["type"];
      recipient: string;
    },
    database: Database = db(),
  ): Promise<OutboundMessage> {
    const [created] = await database
      .insert(outboundMessages)
      .values({ ...input, acceptedAt: new Date() })
      .returning();
    if (created === undefined) throw new Error("insert returned no row");
    return created;
  }

  /** Match an engine ack to the message it acknowledges. */
  static async recordAck(
    environmentId: string,
    engineMessageId: string,
    status: "delivered" | "read",
    database: Database = db(),
  ): Promise<OutboundMessage | null> {
    // Scoped by the engine id *and* the state it may legally leave.
    //
    // `read` is terminal for our purposes: WhatsApp emits delivered before
    // read, but the bridge gives no ordering guarantee across retries or
    // reconnects, and a late `delivered` overwriting `read` would make a
    // message appear to regress.
    const allowedFrom: Array<OutboundMessage["state"]> =
      status === "read" ? ["accepted", "delivered", "undelivered"] : ["accepted", "undelivered"];

    const [updated] = await database
      .update(outboundMessages)
      .set({ state: status, ackedAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(outboundMessages.engineMessageId, engineMessageId),
          // Engine ids come from outside and are not tenant-scoped, so the
          // environment is required rather than inferred from them.
          eq(outboundMessages.environmentId, environmentId),
          inArray(outboundMessages.state, allowedFrom),
        ),
      )
      .returning();
    return updated ?? null;
  }

  /**
   * Messages accepted but never acknowledged.
   *
   * This is the sweep that turns a silent failure into an event. Without it a
   * send during the 203-second blind window returns success, the OTP never
   * arrives, and nothing anywhere reports a problem.
   */
  static async findUnacked(
    olderThanMs = ACK_TIMEOUT_MS,
    now: Date = new Date(),
    database: Database = db(),
  ): Promise<OutboundMessage[]> {
    return database
      .select()
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.state, "accepted"),
          lt(outboundMessages.acceptedAt, new Date(now.getTime() - olderThanMs)),
        ),
      );
  }

  /**
   * Mark a send undelivered.
   *
   * Takes the environment as well as the id. Writing by primary key alone gave
   * a caller with any message id the ability to mutate another tenant's row,
   * and an engine-supplied identifier is not a tenant-scoped one.
   */
  static async markUndelivered(environmentId: string, id: string, database: Database = db()): Promise<void> {
    await database
      .update(outboundMessages)
      .set({ state: "undelivered", updatedAt: new Date() })
      .where(
        and(
          eq(outboundMessages.id, id),
          eq(outboundMessages.environmentId, environmentId),
          eq(outboundMessages.state, "accepted"),
        ),
      );
  }

  /** Scoped by environment: a message id alone must not reach another tenant's. */
  static async findForEnvironment(
    environmentId: string,
    id: string,
    database: Database = db(),
  ): Promise<OutboundMessage> {
    const [found] = await database
      .select()
      .from(outboundMessages)
      .where(and(eq(outboundMessages.id, id), eq(outboundMessages.environmentId, environmentId)))
      .limit(1);
    if (found === undefined) throw new NotFoundError(`message ${id} not found`);
    return found;
  }

  /** Count messages sent by a binding since a cutoff, for quota enforcement. */
  static async countSince(
    environmentId: string,
    virtualDeviceId: string,
    since: Date,
    database: Database = db(),
  ): Promise<number> {
    // Counted in the database rather than by loading rows: this runs on the
    // send path, and a quota check that materialises every message a binding
    // has ever sent gets slower exactly as it matters more.
    const [row] = await database
      .select({ total: drizzleCount() })
      .from(outboundMessages)
      .where(
        and(
          eq(outboundMessages.virtualDeviceId, virtualDeviceId),
          eq(outboundMessages.environmentId, environmentId),
          gt(outboundMessages.acceptedAt, since),
        ),
      );
    return Number(row?.total ?? 0);
  }
}
