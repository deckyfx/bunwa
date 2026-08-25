/**
 * Delivery against a real database and a stubbed network.
 *
 * The queue's job is that nothing is lost, so these tests are about what
 * survives: a failure, a restart, a dead target, a replay.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eq } from "drizzle-orm";

import { createDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { deliveries, environmentWebhooks } from "../../db/schema";
import { DeliveryStore } from "../../stores/delivery-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { runOnce } from "../worker";
import { verify, SIGNATURE_HEADER } from "../signature";
import { EVENT_SCHEMA_VERSION, type EventEnvelope } from "../../events/schema";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

// Captured once, at module load: the process is shared across test
// files, so deleting these keys strips whatever the runner supplied
// from every file that runs later.
const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let environmentId: string;
let projectId: string;

const SECRET = "test-secret";

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-delivery-"));
  resetConfig();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: "production" }, database);
  projectId = project.id;
  environmentId = environment.id;
  await database.insert(environmentWebhooks).values({
    environmentId,
    url: "https://hooks.example.com/wa",
    secret: SECRET,
  });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  restoreEnv();
});

function event(overrides: Partial<EventEnvelope> = {}): EventEnvelope {
  return {
    schema: EVENT_SCHEMA_VERSION,
    id: crypto.randomUUID(),
    type: "device.logged_out",
    occurred_at: new Date().toISOString(),
    environment: { id: environmentId, slug: "production" },
    project: { id: projectId, slug: "grande" },
    data: {},
    meta: { origin: "engine" },
    ...overrides,
  };
}

/** A fetch stub that records what it was asked to send. */
function stubFetch(status: number | Error) {
  const calls: Array<{ url: string; body: string; signature: string | null }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: String(init?.body ?? ""),
      signature: new Headers(init?.headers).get(SIGNATURE_HEADER),
    });
    if (status instanceof Error) throw status;
    return new Response(null, { status });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/**
 * A resolver returning a public address, so the SSRF check runs for real
 * without the suite depending on DNS. Skipping the check in tests would assert
 * against a code path production does not take.
 */
const publicLookup = async () => [{ address: "93.184.216.34" }];

const opts = (fetchImpl: typeof fetch) => ({
  database,
  fetchImpl,
  lookupImpl: publicLookup,
  allowInsecure: false,
});

describe("enqueue", () => {
  test("persists before anything is attempted", async () => {
    const queued = await DeliveryStore.enqueue(environmentId, event(), database);
    expect(queued).not.toBeNull();
    expect(queued!.state).toBe("pending");
    expect(queued!.attemptCount).toBe(0);
  });

  test("is idempotent on the event id", async () => {
    // The same event offered twice must not become two deliveries.
    const e = event();
    expect(await DeliveryStore.enqueue(environmentId, e, database)).not.toBeNull();
    expect(await DeliveryStore.enqueue(environmentId, e, database)).toBeNull();
    expect(await database.select().from(deliveries)).toHaveLength(1);
  });

  test("call.offer is not delivered unless asked for", async () => {
    // bunwa never answers or rejects a call, so a project that never considered
    // calls should not start receiving them because a device rang.
    expect(await DeliveryStore.enqueue(environmentId, event({ type: "call.offer" }), database)).toBeNull();

    await database
      .update(environmentWebhooks)
      .set({ eventFilter: ["call.offer"] })
      .where(eq(environmentWebhooks.environmentId, environmentId));
    expect(await DeliveryStore.enqueue(environmentId, event({ type: "call.offer" }), database)).not.toBeNull();
  });

  test("a disabled webhook queues nothing", async () => {
    await database
      .update(environmentWebhooks)
      .set({ enabled: false })
      .where(eq(environmentWebhooks.environmentId, environmentId));
    expect(await DeliveryStore.enqueue(environmentId, event(), database)).toBeNull();
  });
});

describe("the worker", () => {
  test("delivers, and signs what it delivers", async () => {
    const { impl, calls } = stubFetch(200);
    await DeliveryStore.enqueue(environmentId, event(), database);
    expect(await runOnce(opts(impl))).toBe(1);

    expect(calls).toHaveLength(1);
    // The receiver must be able to tell bunwa from anyone else.
    expect(verify(calls[0]!.body, calls[0]!.signature, SECRET)).toEqual({ valid: true });

    const [row] = await database.select().from(deliveries);
    expect(row!.state).toBe("delivered");
    expect(row!.deliveredAt).toBeInstanceOf(Date);
  });

  test("retries a failure rather than dropping it", async () => {
    const { impl } = stubFetch(500);
    await DeliveryStore.enqueue(environmentId, event(), database);
    await runOnce(opts(impl));

    const [row] = await database.select().from(deliveries);
    expect(row!.state).toBe("pending");
    expect(row!.attemptCount).toBe(1);
    // Scheduled forward, so it is not retried immediately in a hot loop.
    expect(row!.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
  });

  test("treats a 3xx as a failure — a webhook target has not moved", async () => {
    const { impl } = stubFetch(302);
    await DeliveryStore.enqueue(environmentId, event(), database);
    await runOnce(opts(impl));
    expect((await database.select().from(deliveries))[0]!.state).toBe("pending");
  });

  test("dead-letters after the configured attempts, keeping every attempt", async () => {
    const { impl } = stubFetch(500);
    await database
      .update(environmentWebhooks)
      .set({ maxAttempts: 2 })
      .where(eq(environmentWebhooks.environmentId, environmentId));
    const queued = await DeliveryStore.enqueue(environmentId, event(), database);

    for (let i = 0; i < 3; i++) {
      await database.update(deliveries).set({ nextAttemptAt: new Date(0) }).where(eq(deliveries.id, queued!.id));
      await runOnce(opts(impl));
    }

    const [row] = await database.select().from(deliveries);
    expect(row!.state).toBe("dead");
    // Nothing is lost: the row and its history remain, and it can be replayed.
    const attempts = await DeliveryStore.attemptsFor(projectId, environmentId, queued!.id, database);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((a) => a.statusCode === 500)).toBe(true);
  });

  test("a replayed delivery is attempted again with a full schedule", async () => {
    const { impl: failing } = stubFetch(500);
    await database
      .update(environmentWebhooks)
      .set({ maxAttempts: 1 })
      .where(eq(environmentWebhooks.environmentId, environmentId));
    const queued = await DeliveryStore.enqueue(environmentId, event(), database);
    await runOnce(opts(failing));
    expect((await database.select().from(deliveries))[0]!.state).toBe("dead");

    const replayed = await DeliveryStore.replay(projectId, environmentId, queued!.id, database);
    expect(replayed.state).toBe("pending");
    expect(replayed.attemptCount).toBe(0);

    const { impl: ok } = stubFetch(200);
    await runOnce(opts(ok));
    expect((await database.select().from(deliveries))[0]!.state).toBe("delivered");
  });

  test("a network error is a retry, not a crash", async () => {
    const { impl } = stubFetch(new Error("ECONNREFUSED"));
    await DeliveryStore.enqueue(environmentId, event(), database);
    await expect(runOnce(opts(impl))).resolves.toBe(1);
    const attempts = await DeliveryStore.attemptsFor(projectId, environmentId, (await database.select().from(deliveries))[0]!.id, database);
    expect(attempts[0]!.error).toContain("ECONNREFUSED");
  });

  test("refuses a target pointing at a private address, without calling fetch", async () => {
    const { impl, calls } = stubFetch(200);
    await database
      .update(environmentWebhooks)
      .set({ url: "https://169.254.169.254/latest/meta-data/" })
      .where(eq(environmentWebhooks.environmentId, environmentId));
    await DeliveryStore.enqueue(environmentId, event(), database);
    // No lookup stub here: the literal address is refused before DNS is reached.
    await runOnce({ database, fetchImpl: impl, allowInsecure: false });

    // The request must never be made, not merely fail.
    expect(calls).toHaveLength(0);
    const attempts = await DeliveryStore.attemptsFor(projectId, environmentId, (await database.select().from(deliveries))[0]!.id, database);
    expect(attempts[0]!.error).toContain("private or loopback");
  });
});

describe("DNS rebinding", () => {
  test("a public-looking hostname that resolves to a private address is refused", async () => {
    // validateWebhookTarget cannot catch this: the name is unremarkable and the
    // answer only appears at resolution time. This is what resolve-then-check
    // is for, and the reason the resolver is injected rather than skipped.
    const { impl, calls } = stubFetch(200);
    await DeliveryStore.enqueue(environmentId, event(), database);
    await runOnce({
      database,
      fetchImpl: impl,
      lookupImpl: async () => [{ address: "169.254.169.254" }],
      allowInsecure: false,
    });

    expect(calls).toHaveLength(0);
    const [row] = await database.select().from(deliveries);
    const attempts = await DeliveryStore.attemptsFor(projectId, environmentId, row!.id, database);
    expect(attempts[0]!.error).toContain("private or loopback");
  });

  test("one blocked address among several is enough to refuse", async () => {
    // A resolver returning both a public and a private answer must not be
    // treated as safe because the first entry looked fine.
    const { impl, calls } = stubFetch(200);
    await DeliveryStore.enqueue(environmentId, event(), database);
    await runOnce({
      database,
      fetchImpl: impl,
      lookupImpl: async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }],
      allowInsecure: false,
    });
    expect(calls).toHaveLength(0);
  });
});

describe("delivery log isolation", () => {
  test("another project cannot read the log or replay from it", async () => {
    const other = await ProjectStore.create({ slug: "rival", displayName: "Rival" }, database);
    const queued = await DeliveryStore.enqueue(environmentId, event(), database);

    expect(await DeliveryStore.listForEnvironment(other.id, environmentId, 50, database)).toHaveLength(0);
    await expect(DeliveryStore.attemptsFor(other.id, environmentId, queued!.id, database)).rejects.toThrow();
    await expect(DeliveryStore.replay(other.id, environmentId, queued!.id, database)).rejects.toThrow();
  });
});
