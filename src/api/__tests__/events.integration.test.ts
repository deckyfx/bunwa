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
import { publish, resetBus, subscriberCount } from "../../events/bus";
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
      // Buffer, not TextDecoder.
      //
      // happy-dom installs Node's TextDecoder, which rejects Bun's Uint8Array
      // with ERR_INVALID_ARG_TYPE — the two disagree across realms. The bytes
      // were arriving the whole time; decoding them threw and the catch below
      // turned that into an empty string, so three tests reported a stream
      // that delivered nothing while the route was working perfectly.
      seen += Buffer.from(next.value).toString("utf8");
      if (seen.includes(want)) break;
    }
  } catch (err) {
    // Reported, never swallowed. A bare catch here hid a decode failure and
    // cost hours of looking at the route instead of the helper.
    if (!String(err).includes("aborted")) {
      throw new Error(`readUntil failed: ${String(err)}`);
    }
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

describe("a reader that disconnects while nothing is happening", () => {
  test("its subscription is closed at once, not at the next heartbeat", async () => {
    // A generator's `finally` cannot run until the body reaches a suspension
    // point it can be resumed through, and the body parks on a race that
    // includes the 25-second heartbeat. So an idle reader that went away left
    // its subscription registered on the bus — holding a fan-out slot and
    // filling a queue nobody would ever read — until that timer came round.
    // The abort listener is what makes the close immediate.
    const controller = new AbortController();
    const response = await app.handle(
      new Request(`http://localhost/v1/events/stream?ticket=${encodeURIComponent(await mint())}`, {
        signal: controller.signal,
      }),
    );
    expect(response.status).toBe(200);

    // Read the opening frame so the stream is genuinely established, then stop.
    const reader = response.body!.getReader();
    await reader.read();
    expect(subscriberCount(environmentId), "the stream never subscribed").toBe(1);

    controller.abort();
    await reader.cancel().catch(() => undefined);

    // Immediately, without waiting out HEARTBEAT_MS.
    await Bun.sleep(100);
    expect(
      subscriberCount(environmentId),
      "the subscription outlived the reader that abandoned it",
    ).toBe(0);
  }, 10_000);
});

describe("a request that was already aborted", () => {
  test("does not leave its subscription on the bus", async () => {
    // The subscription is created in `resolve`, before the generator body
    // runs. `addEventListener("abort")` on a signal that has already fired
    // registers for something that will never happen again, so neither that
    // path nor the `finally` — which needs the generator resumed — would ever
    // close it. The check has to be for the state, not only the event.
    const ticket = await mint();
    const controller = new AbortController();
    controller.abort();

    const response = await app.handle(
      new Request(`http://localhost/v1/events/stream?ticket=${encodeURIComponent(ticket)}`, {
        signal: controller.signal,
      }),
    );

    // Pull once so the generator body actually runs; an aborted request may
    // reject here, which is fine — what matters is what it left behind.
    await response.body
      ?.getReader()
      .read()
      .catch(() => undefined);
    await Bun.sleep(100);

    expect(
      subscriberCount(environmentId),
      "an already-aborted request left its subscription attached",
    ).toBe(0);
  }, 10_000);
});
