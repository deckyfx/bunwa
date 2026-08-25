/**
 * SSE stream tickets.
 *
 * The properties worth testing are the ones a ticket is claimed to have:
 * single-use in fact rather than in intention, short-lived, scoped to one
 * environment, and never stored in a form anyone could spend.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";


import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { ProjectStore } from "../project-store";
import { EnvironmentStore } from "../environment-store";
import { ApiKeyStore } from "../api-key-store";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import {
  mintTicket,
  spendTicket,
  storedHashes,
  sweepTickets,
  ticketCount,
  TICKET_TTL_MS,
} from "../stream-ticket-store";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let environmentId: string;
let otherEnvironmentId: string;
let projectId: string;
let apiKeyId: string;
let otherApiKeyId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-ticket-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  projectId = project.id;
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: "production" }, database);
  environmentId = environment.id;
  const other = await EnvironmentStore.create({ projectId: project.id, slug: "staging" }, database);
  otherEnvironmentId = other.id;

  const key = await ApiKeyStore.create(
    { projectId: project.id, environmentId, label: "console", scopes: ["send:text"] },
    database,
  );
  apiKeyId = key.apiKey.id;

  const otherKey = await ApiKeyStore.create(
    { projectId: project.id, environmentId: otherEnvironmentId, label: "staging console", scopes: ["send:text"] },
    database,
  );
  otherApiKeyId = otherKey.apiKey.id;
});

afterEach(() => {
  try {
    database.$client.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

describe("a ticket is spendable exactly once", () => {
  test("the first spend succeeds and the second finds nothing", async () => {
    const { ticket } = await mintTicket(environmentId, apiKeyId, new Date(0), database);

    const first = await spendTicket(ticket, new Date(1_000), database);
    expect(first?.environmentId).toBe(environmentId);
    expect(first?.apiKeyId).toBe(apiKeyId);

    expect(await spendTicket(ticket, new Date(2_000), database)).toBeNull();
  });

  test("concurrent spends of one ticket yield exactly one winner", async () => {
    // The property the conditional delete exists for. A read-then-delete
    // implementation passes the test above and fails this one: both callers
    // read a live row, both proceed, and "single use" turns out to describe
    // the intention rather than the behaviour.
    const { ticket } = await mintTicket(environmentId, apiKeyId, new Date(0), database);

    const attempts = await Promise.all(
      Array.from({ length: 8 }, () => spendTicket(ticket, new Date(1_000), database)),
    );

    expect(attempts.filter((a) => a !== null)).toHaveLength(1);
  });

  test("spending removes the row rather than marking it", async () => {
    const { ticket } = await mintTicket(environmentId, apiKeyId, new Date(0), database);
    expect(await ticketCount(environmentId, database)).toBe(1);
    await spendTicket(ticket, new Date(1_000), database);
    expect(await ticketCount(environmentId, database)).toBe(0);
  });
});

describe("a ticket stops working when it should", () => {
  test("an expired ticket is refused", async () => {
    const { ticket } = await mintTicket(environmentId, apiKeyId, new Date(0), database);
    expect(await spendTicket(ticket, new Date(TICKET_TTL_MS + 1), database)).toBeNull();
  });

  test("expiry is checked in the same statement that spends it", async () => {
    // Checked separately, a ticket can expire between the check and the delete.
    // The window is small and the failure is a stream authorised by a ticket
    // that was not valid when it was used, which is the whole thing this
    // mechanism claims not to allow.
    const { ticket } = await mintTicket(environmentId, apiKeyId, new Date(0), database);
    const atTheBoundary = new Date(TICKET_TTL_MS);
    expect(await spendTicket(ticket, atTheBoundary, database)).toBeNull();
  });

  test("an unknown ticket is refused rather than throwing", async () => {
    expect(await spendTicket("not-a-ticket", new Date(0), database)).toBeNull();
  });
});

describe("a ticket authorises one environment", () => {
  test("it resolves to the environment it was minted for, not another", async () => {
    const mine = await mintTicket(environmentId, apiKeyId, new Date(0), database);
    const theirs = await mintTicket(otherEnvironmentId, otherApiKeyId, new Date(0), database);

    expect((await spendTicket(mine.ticket, new Date(1), database))?.environmentId).toBe(environmentId);
    expect((await spendTicket(theirs.ticket, new Date(1), database))?.environmentId).toBe(otherEnvironmentId);
  });

  test("a key cannot mint a ticket for an environment it does not belong to", async () => {
    // The earlier version of the test above did exactly this and passed,
    // demonstrating the hole while reading as coverage: two independent foreign
    // keys let a row pair any key with any environment, so the store would
    // happily issue a stream credential for another tenant.
    await expect(mintTicket(otherEnvironmentId, apiKeyId, new Date(0), database)).rejects.toThrow(
      /does not belong/,
    );
    expect(await ticketCount(otherEnvironmentId, database)).toBe(0);
  });

  test("a revoked key cannot mint a ticket", async () => {
    // A stream opened by a revoked key would outlive the revocation by as long
    // as the connection stays up, which is unbounded.
    await ApiKeyStore.revoke(projectId, environmentId, apiKeyId, database);
    await expect(mintTicket(environmentId, apiKeyId, new Date(0), database)).rejects.toThrow(
      /does not belong/,
    );
  });
});

describe("a ticket is only as live as the key behind it", () => {
  test("an expired key cannot mint", async () => {
    // revokedAt was checked and expiresAt was not — one of the two ways a key
    // stops being usable, which ApiKeyStore.isUsable has always treated as a
    // pair.
    const expiring = await ApiKeyStore.create(
      {
        projectId,
        environmentId,
        label: "expiring",
        scopes: ["send:text"],
        expiresAt: new Date(1_000),
      },
      database,
    );

    await expect(
      mintTicket(environmentId, expiring.apiKey.id, new Date(2_000), database),
    ).rejects.toThrow(/does not belong/);
  });

  test("revoking the key kills a ticket already minted", async () => {
    // The window this closes: mint, revoke, then spend. Without the check at
    // spend time the stream opens anyway and lives as long as the connection
    // does, which is unbounded — the opposite of what revoking a key means.
    const { ticket } = await mintTicket(environmentId, apiKeyId, new Date(0), database);
    await ApiKeyStore.revoke(projectId, environmentId, apiKeyId, database);

    expect(await spendTicket(ticket, new Date(1_000), database)).toBeNull();
  });

  test("a key expiring after minting kills the ticket too", async () => {
    const expiring = await ApiKeyStore.create(
      {
        projectId,
        environmentId,
        label: "short-lived",
        scopes: ["send:text"],
        expiresAt: new Date(5_000),
      },
      database,
    );
    const { ticket } = await mintTicket(environmentId, expiring.apiKey.id, new Date(0), database);

    // Inside the ticket's own TTL, but past the key's expiry.
    expect(await spendTicket(ticket, new Date(6_000), database)).toBeNull();
  });

  test("a live key still spends normally", async () => {
    // The checks must not refuse the ordinary case.
    const { ticket } = await mintTicket(environmentId, apiKeyId, new Date(0), database);
    expect((await spendTicket(ticket, new Date(1_000), database))?.environmentId).toBe(environmentId);
  });
});

describe("the ticket itself is never stored", () => {
  test("the row holds a hash, and the plaintext appears nowhere", async () => {
    // A ticket lives for a minute; a database dump lives for months. There is
    // no reason to leave a spendable credential in one.
    const { ticket } = await mintTicket(environmentId, apiKeyId, new Date(0), database);

    const hashes = await storedHashes(environmentId, database);
    expect(hashes).toHaveLength(1);
    expect(hashes[0]!).not.toBe(ticket);
    expect(hashes[0]!).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("unspent tickets do not accumulate", () => {
  test("the sweep removes expired ones and leaves live ones", async () => {
    // A console the user closed leaves a ticket nobody will ever spend. Without
    // the sweep the table grows by one row per page load.
    await mintTicket(environmentId, apiKeyId, new Date(0), database);
    await mintTicket(environmentId, apiKeyId, new Date(0), database);
    await mintTicket(environmentId, apiKeyId, new Date(TICKET_TTL_MS), database);
    expect(await ticketCount(environmentId, database)).toBe(3);

    const removed = await sweepTickets(new Date(TICKET_TTL_MS + 1), database);
    expect(removed).toBe(2);
    expect(await ticketCount(environmentId, database)).toBe(1);
  });
});
