/**
 * Idempotent request replay.
 *
 * For OTP this is the difference between one code and two. A send that times
 * out at the HTTP layer may already have reached WhatsApp, so a client's retry
 * must return the original answer rather than send again — and "did it go
 * through?" must stop being a judgement call the caller has to make.
 */
import { and, eq, lt } from "drizzle-orm";

import { db, type Database } from "../db";
import { idempotencyKeys } from "../db/schema";
import { ConflictError } from "./errors";

/** How long a key is honoured. Beyond this a retry is treated as a new request. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredResponse {
  statusCode: number;
  response: Record<string, unknown>;
}

export class IdempotencyStore {
  /** A stable fingerprint of the request this key was first used for. */
  static hashRequest(body: unknown): string {
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(body ?? null)).digest("hex");
  }

  /**
   * Look up a previous response for this key.
   *
   * @throws ConflictError if the key was used for a different request — a
   * caller reusing a key with a new body is a bug, and replaying the old
   * response would report the wrong message as sent.
   */
  static async lookup(
    environmentId: string,
    key: string,
    requestHash: string,
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<StoredResponse | null> {
    const [found] = await database
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.environmentId, environmentId), eq(idempotencyKeys.key, key)))
      .limit(1);
    if (found === undefined) return null;

    if (found.createdAt.getTime() + IDEMPOTENCY_TTL_MS <= now.getTime()) return null;

    if (found.requestHash !== requestHash) {
      throw new ConflictError(`idempotency key "${key}" was already used for a different request`, "Idempotency-Key");
    }
    return { statusCode: found.statusCode, response: found.response };
  }

  /**
   * Record a response against a key.
   *
   * onConflictDoNothing rather than an upsert: if two concurrent requests race,
   * the first to finish wins and the second replays it. Overwriting would mean
   * the caller's retry could get a different answer than the one already given.
   */
  static async record(
    environmentId: string,
    key: string,
    requestHash: string,
    stored: StoredResponse,
    database: Database = db(),
  ): Promise<void> {
    await database
      .insert(idempotencyKeys)
      .values({ environmentId, key, requestHash, statusCode: stored.statusCode, response: stored.response })
      .onConflictDoNothing();
  }

  /** Drop expired keys. Called on a timer; nothing depends on it being prompt. */
  static async sweep(database: Database = db(), now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
    const removed = await database.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, cutoff)).returning();
    return removed.length;
  }
}
