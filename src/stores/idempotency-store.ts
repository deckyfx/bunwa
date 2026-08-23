/**
 * Idempotent request replay.
 *
 * For OTP this is the difference between one code and two. A send that times
 * out at the HTTP layer may already have reached WhatsApp, so a retry must
 * return the original answer rather than send again.
 *
 * The key is **reserved before the side effect**, not recorded after it.
 * Recording afterwards left two windows in which a retry produced a second
 * message: a crash between the send and the write, and two concurrent requests
 * both finding no key. The unique primary key is the arbiter — exactly one
 * caller inserts, and everyone else is told to wait or to replay.
 */
import { and, eq, isNull, lt } from "drizzle-orm";

import { db, type Database } from "../db";
import { idempotencyKeys, type JsonValue } from "../db/schema";
import { ConflictError } from "./errors";

/** How long a key is honoured. Beyond this a retry is treated as a new request. */
export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface StoredResponse {
  statusCode: number;
  response: Record<string, JsonValue>;
}

/** What a reservation attempt found. */
export type Reservation =
  /** Nothing there; this caller owns the key and must proceed. */
  | { state: "reserved" }
  /** An identical request already finished; replay its answer. */
  | { state: "replay"; stored: StoredResponse }
  /** An identical request is in flight right now. */
  | { state: "in_flight" };

export class IdempotencyStore {
  /**
   * A stable fingerprint of the request this key was first used for.
   *
   * Keys are sorted recursively before hashing: JSON.stringify preserves
   * insertion order, so the same payload serialised with its fields in a
   * different order — routine across languages and HTTP clients — would
   * otherwise hash differently and turn a legitimate retry into a 409.
   */
  static hashRequest(body: unknown): string {
    return new Bun.CryptoHasher("sha256").update(stableStringify(body)).digest("hex");
  }

  /** Claim a key before performing the side effect it guards. */
  static async reserve(
    environmentId: string,
    key: string,
    requestHash: string,
    database: Database = db(),
    now: Date = new Date(),
  ): Promise<Reservation> {
    const existing = await this.lookup(environmentId, key, requestHash, database, now);
    if (existing !== null) return { state: "replay", stored: existing };

    const inserted = await database
      .insert(idempotencyKeys)
      .values({ environmentId, key, requestHash })
      .onConflictDoNothing()
      .returning();

    if (inserted.length > 0) return { state: "reserved" };

    // The insert lost to an existing row. That row is either a live
    // reservation, a completed response, or a stale one past its TTL that
    // lookup() reports as absent — which would leave the caller told a request
    // is in flight for ever, until an unrelated sweep happened to run.
    const [existingRow] = await database
      .select()
      .from(idempotencyKeys)
      .where(and(eq(idempotencyKeys.environmentId, environmentId), eq(idempotencyKeys.key, key)))
      .limit(1);

    if (existingRow !== undefined && existingRow.createdAt.getTime() + IDEMPOTENCY_TTL_MS <= now.getTime()) {
      // Expired: take it over rather than waiting for the sweep.
      await database
        .update(idempotencyKeys)
        .set({ requestHash, response: null, statusCode: null, createdAt: now })
        .where(and(eq(idempotencyKeys.environmentId, environmentId), eq(idempotencyKeys.key, key)));
      return { state: "reserved" };
    }

    const raced = await this.lookup(environmentId, key, requestHash, database, now);
    return raced !== null ? { state: "replay", stored: raced } : { state: "in_flight" };
  }

  /**
   * Look up a *completed* response.
   *
   * A reservation with no response yet returns null: it is not an answer, and
   * replaying it would hand the caller an empty body.
   *
   * @throws ConflictError if the key was used for a different request
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
    if (found.response === null || found.statusCode === null) return null;
    return { statusCode: found.statusCode, response: found.response };
  }

  /** Complete a reservation with the response future retries should replay. */
  static async complete(
    environmentId: string,
    key: string,
    stored: StoredResponse,
    database: Database = db(),
  ): Promise<void> {
    await database
      .update(idempotencyKeys)
      .set({ statusCode: stored.statusCode, response: stored.response })
      .where(and(eq(idempotencyKeys.environmentId, environmentId), eq(idempotencyKeys.key, key)));
  }

  /**
   * Release a reservation whose side effect never happened.
   *
   * Without this, a send that failed before reaching the engine would leave the
   * key claimed and the caller's retry — the correct thing to do — would be
   * told a request is in flight for ever. Only unfinished rows are removed, so
   * a completed response can never be deleted by a late failure path.
   */
  static async release(environmentId: string, key: string, database: Database = db()): Promise<void> {
    await database
      .delete(idempotencyKeys)
      .where(
        and(
          eq(idempotencyKeys.environmentId, environmentId),
          eq(idempotencyKeys.key, key),
          isNull(idempotencyKeys.response),
        ),
      );
  }

  /** Drop expired keys. Called on a timer; nothing depends on it being prompt. */
  static async sweep(database: Database = db(), now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
    const removed = await database.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, cutoff)).returning();
    return removed.length;
  }
}

/** Deterministic JSON: object keys sorted at every depth. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
  return `{${entries.join(",")}}`;
}
