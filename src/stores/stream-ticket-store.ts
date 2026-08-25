/**
 * Short-lived tickets that let a browser open the SSE stream.
 *
 * See [ADR-0008](../../docs/adr/0008-sse-stream-tickets.md). EventSource cannot
 * send headers, so the stream cannot use `x-api-key` like everything else. A
 * ticket is minted with the key, spent once, and expires in seconds.
 */
import { and, eq, gt, isNull, lte } from "drizzle-orm";

import { db, type Database } from "../db";
import { apiKeys, streamTickets } from "../db/schema";
import { ValidationError } from "./errors";

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
  // The pair is verified, not trusted. Two independent foreign keys let a row
  // pair any key with any environment, and a store that accepts the pair is one
  // route bug away from minting a stream credential for someone else's tenant.
  // The test file demonstrated exactly that and read as though it were fine.
  //
  // Scoped by environment, which is also what the path instruction for stores
  // requires, and it confirms the key is live at the same time: a revoked or
  // expired key must not be able to open a stream that outlives it.
  const [key] = await database
    .select({ id: apiKeys.id })
    .from(apiKeys)
    .where(
      and(
        eq(apiKeys.id, apiKeyId),
        eq(apiKeys.environmentId, environmentId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .limit(1);

  if (key === undefined) {
    throw new ValidationError("api key does not belong to that environment", "apiKeyId");
  }

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
 *
 * Takes no environmentId, deliberately, and a review has asked for one. At
 * GET /v1/events/stream there is no authenticated caller: the ticket *is* the
 * credential, and the environment is what it resolves to. A caller-supplied
 * environmentId there would let the caller assert the tenancy this function
 * exists to establish, which is weaker than having no parameter at all. The
 * binding is made where it can be trusted — mintTicket, behind x-api-key.
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
  // Deliberately every tenant, like the rate-limit sweep: this is housekeeping
  // run by the process, not a request, and there is no environment to scope it
  // to. Scoping it would mean iterating tenants to do one indexed delete.
  //
  // `lte`, not `lt`. spendTicket requires expiresAt > now, so a ticket at
  // exactly its expiry is already unusable — leaving it behind means the table
  // retains rows nobody can spend, which is the thing this exists to prevent.
  const removed = await database
    .delete(streamTickets)
    .where(lte(streamTickets.expiresAt, now))
    .returning({ tokenHash: streamTickets.tokenHash });
  return removed.length;
}

/**
 * Unspent tickets for one environment.
 *
 * Scoped, and through Drizzle rather than the raw handle. It was neither: a
 * cross-tenant `SELECT COUNT(*)` in a store is the shape that becomes a leak
 * the moment someone returns it from a route, and "it is only used by tests"
 * is not a property the next caller inherits.
 */
export async function ticketCount(environmentId: string, database: Database = db()): Promise<number> {
  const rows = await database
    .select({ tokenHash: streamTickets.tokenHash })
    .from(streamTickets)
    .where(eq(streamTickets.environmentId, environmentId));
  return rows.length;
}
