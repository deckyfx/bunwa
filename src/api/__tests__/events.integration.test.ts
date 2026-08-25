/**
 * The SSE ticket and stream.
 *
 * The stream is the one endpoint that cannot use the API key, so the things
 * worth proving are that the ticket is genuinely the only way in, that it
 * cannot be reused, and that a stream reaches only its own environment.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../server";
import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { ProjectStore } from "../../stores/project-store";
import { EnvironmentStore } from "../../stores/environment-store";
import { ApiKeyStore } from "../../stores/api-key-store";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { publish, resetBus } from "../../events/bus";
import { EVENT_SCHEMA_VERSION } from "../../events/schema";
import type { EventEnvelope } from "../../events/schema";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let app: ReturnType<typeof createApp>;
let key: string;
let environmentId: string;
let otherEnvironmentId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-sse-"));
  resetConfig();
  resetDatabase();
  resetBus();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "Grande" }, database);
  const environment = await EnvironmentStore.create({ projectId: project.id, slug: "production" }, database);
  environmentId = environment.id;
  const other = await EnvironmentStore.create({ projectId: project.id, slug: "staging" }, database);
  otherEnvironmentId = other.id;

  key = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId, label: "console", scopes: ["send:text"] },
      database,
    )
  ).plaintext;

  app = createApp();
});

afterEach(() => {
  resetBus();
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

async function mint(): Promise<string> {
  const res = await app.handle(
    new Request("http://localhost/v1/events/ticket", {
      method: "POST",
      headers: { "x-api-key": key },
    }),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { ticket: string }).ticket;
}

const openStream = (ticket: string) =>
  app.handle(new Request(`http://localhost/v1/events/stream?ticket=${encodeURIComponent(ticket)}`));

function envelope(id: string, envId: string): EventEnvelope {
  return {
    schema: EVENT_SCHEMA_VERSION,
    id,
    type: "device.connected",
    occurred_at: new Date(0).toISOString(),
    environment: { id: envId, slug: "production" },
    project: { id: "p", slug: "grande" },
    data: {},
    meta: { origin: "engine" },
  };
}

/** Read frames until `want` is seen, or give up rather than hang. */
async function readUntil(response: Response, want: string): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  // One read outstanding at a time. Racing read() against a sleep left the
  // losing read queued, so a later frame resolved a promise nobody was
  // reading and never reached `seen` — an intermittent failure built into the
  // helper meant to make these tests deterministic.
  const timeout = setTimeout(() => void reader.cancel().catch(() => undefined), 3_000);
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done === true) break;
      seen += decoder.decode(next.value, { stream: true });
      if (seen.includes(want)) break;
    }
  } catch {
    // The timeout cancelled the reader mid-read; `seen` holds what arrived.
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
  return seen;
}

describe("the ticket is the only way in", () => {
  test("minting requires the api key", async () => {
    const res = await app.handle(
      new Request("http://localhost/v1/events/ticket", { method: "POST" }),
    );
    expect(res.status).toBe(401);
  });

  test("the stream refuses a missing ticket", async () => {
    const res = await app.handle(new Request("http://localhost/v1/events/stream"));
    // Elysia's validation rejects the absent query parameter before the handler.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  test("the stream refuses an unknown ticket", async () => {
    const res = await openStream("not-a-real-ticket");
    expect(res.status).toBe(401);
  });

  test("a ticket cannot be reused", async () => {
    const ticket = await mint();
    const first = await openStream(ticket);
    expect(first.status).toBe(200);
    await first.body?.cancel();

    const second = await openStream(ticket);
    expect(second.status, "the same ticket opened a second stream").toBe(401);
  });

  test("the api key itself is not accepted as a ticket", async () => {
    // The shortcut ADR-0008 rejected. If this ever passes, the key is being
    // put in a URL and therefore into access logs.
    const res = await openStream(key);
    expect(res.status).toBe(401);
  });
});

describe("a stream carries its own environment and no other", () => {
  test("it announces itself, then delivers matching events", async () => {
    const response = await openStream(await mint());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    publish(environmentId, envelope("mine", environmentId));

    const seen = await readUntil(response, '"mine"');
    expect(seen).toContain("event: stream.open");
    expect(seen).toContain('"mine"');
  });

  test("an event for another environment never appears", async () => {
    const response = await openStream(await mint());
    publish(otherEnvironmentId, envelope("theirs", otherEnvironmentId));
    publish(environmentId, envelope("mine", environmentId));

    const seen = await readUntil(response, '"mine"');
    expect(seen).toContain('"mine"');
    expect(seen, "another environment's event reached this stream").not.toContain('"theirs"');
  });
});
