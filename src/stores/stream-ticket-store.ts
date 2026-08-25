/**
 * Short-lived tickets that let a browser open the SSE stream.
 *
 * See [ADR-0008](../../docs/adr/0008-sse-stream-tickets.md). EventSource cannot
 * send headers, so the stream cannot use `x-api-key` like everything else. A
 * ticket is minted with the key, spent once, and expires in seconds.
 */
import { and, eq, gt, lt, sql } from "drizzle-orm";

import { db, type Database } from "../db";
import { streamTickets } from "../db/schema";

/**
 * How long a ticket is good for.
 *
 * Long enough to survive minting and connecting on a slow link, short enough
 * that one in an access log is stale before anyone reads the log.
 */
export const TICKET_TTL_MS = 60_000;

export interface MintedTicket {
  /** Given to the client. Never stored. */
  ticket: string;
  expiresAt: Date;
}

/** What a spent ticket resolves to. */
export interface TicketClaims {
  environmentId: string;
  apiKeyId: string;
}

/** SHA-256, hex. The same reasoning as api_keys: never store the usable form. */
function hashOf(ticket: string): string {
  return new Bun.CryptoHasher("sha256").update(ticket).digest("hex");
}

/**
 * Issue a ticket for one environment.
 *
 * The plaintext is returned once and never written down, so a database dump
 * yields hashes rather than working credentials — a ticket lives for a minute
 * but a backup lives for months.
 */
export async function mintTicket(
  environmentId: string,
  apiKeyId: string,
  now: Date = new Date(),
  database: Database = db(),
): Promise<MintedTicket> {
  const ticket = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
  const expiresAt = new Date(now.getTime() + TICKET_TTL_MS);

  await database.insert(streamTickets).values({
    tokenHash: hashOf(ticket),
    environmentId,
    apiKeyId,
    expiresAt,
  });

  return { ticket, expiresAt };
}

/**
 * Spend a ticket, returning what it authorises — or null.
 *
 * A conditional delete whose result *is* the answer, rather than a read
 * followed by a delete. Two connections presenting the same ticket race in the
 * read-then-write form and both succeed, which makes "single use" a description
 * of intent rather than of behaviour. Here the database decides: exactly one
 * DELETE removes the row, so exactly one caller receives claims.
 *
 * Expiry is part of the same predicate for the same reason — checking it
 * separately leaves a window where a ticket expires between the check and the
 * delete.
 */
export async function spendTicket(
  ticket: string,
  now: Date = new Date(),
  database: Database = db(),
): Promise<TicketClaims | null> {
  const [row] = await database
    .delete(streamTickets)
    .where(and(eq(streamTickets.tokenHash, hashOf(ticket)), gt(streamTickets.expiresAt, now)))
    .returning({
      environmentId: streamTickets.environmentId,
      apiKeyId: streamTickets.apiKeyId,
    });

  return row ?? null;
}

/**
 * Remove tickets nobody can spend any more.
 *
 * Spent tickets delete themselves; these are the ones minted and never used,
 * which is the common case for a console the user closed. Without this the
 * table grows by one row per page load for ever.
 */
export async function sweepTickets(now: Date = new Date(), database: Database = db()): Promise<number> {
  const removed = await database
    .delete(streamTickets)
    .where(lt(streamTickets.expiresAt, now))
    .returning({ tokenHash: streamTickets.tokenHash });
  return removed.length;
}

/** How many unspent tickets exist. For tests, and for /metrics if it earns a line. */
export async function ticketCount(database: Database = db()): Promise<number> {
  const [row] = await database.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM stream_tickets`);
  return Number(row?.n ?? 0);
}
