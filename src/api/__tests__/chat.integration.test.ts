/**
 * The chat endpoints.
 *
 * Tenancy is the whole point: a thread id is a UUID, and guessing one must not
 * be enough to read someone else's conversation. Each route is checked from
 * the wrong environment as well as the right one.
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
import { DeviceStore } from "../../stores/device-store";
import { ChatStore } from "../../stores/chat-store";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let app: ReturnType<typeof createApp>;
let key: string;
let otherKey: string;
let threadId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-chatapi-"));
  resetConfig();
  resetDatabase();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "t.sqlite");
  database = createDatabase(join(dir, "t.sqlite"));
  await MigrationManager.runMigrations(database);

  const project = await ProjectStore.create({ slug: "grande", displayName: "G" }, database);
  const env = await EnvironmentStore.create({ projectId: project.id, slug: "prod" }, database);
  const other = await EnvironmentStore.create({ projectId: project.id, slug: "staging" }, database);

  key = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId: env.id, label: "console", scopes: ["send:text"] },
      database,
    )
  ).plaintext;
  otherKey = (
    await ApiKeyStore.create(
      { projectId: project.id, environmentId: other.id, label: "other", scopes: ["send:text"] },
      database,
    )
  ).plaintext;

  const device = (
    await DeviceStore.claim({ environmentId: env.id, msisdn: "+628123456789", alias: "otp" }, database)
  ).device;

  await ChatStore.record(
    {
      environmentId: env.id,
      deviceId: device.id,
      peerJid: "628999@s.whatsapp.net",
      direction: "inbound",
      providerMessageId: "wa-1",
      kind: "text",
      body: "hello there",
      occurredAt: new Date(1_000),
    },
    database,
  );
  threadId = (await ChatStore.threadsForEnvironment(env.id, 50, database))[0]!.id;

  app = createApp();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

const get = (path: string, withKey = key) =>
  app.handle(new Request(`http://localhost${path}`, { headers: { "x-api-key": withKey } }));

const post = (path: string, body: unknown, withKey = key) =>
  app.handle(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "x-api-key": withKey, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

describe("listing conversations", () => {
  test("returns this environment's threads", async () => {
    const body = (await (await get("/v1/chats")).json()) as { peerJid: string; unreadCount: number }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.peerJid).toBe("628999@s.whatsapp.net");
    expect(body[0]!.unreadCount).toBe(1);
  });

  test("another environment sees none of them", async () => {
    const body = (await (await get("/v1/chats", otherKey)).json()) as unknown[];
    expect(body).toEqual([]);
  });
});

describe("reading a conversation", () => {
  test("the owner can read it", async () => {
    const body = (await (await get(`/v1/chats/${threadId}/messages`)).json()) as { body: string }[];
    expect(body).toHaveLength(1);
    expect(body[0]!.body).toBe("hello there");
  });

  test("another environment gets 404, not 403", async () => {
    // 403 would confirm the id exists, which is the one bit an attacker
    // enumerating UUIDs is trying to learn.
    const res = await get(`/v1/chats/${threadId}/messages`, otherKey);
    expect(res.status).toBe(404);
  });

  test("an id that does not exist is also 404", async () => {
    expect((await get(`/v1/chats/${crypto.randomUUID()}/messages`)).status).toBe(404);
  });
});

describe("marking read", () => {
  test("the owner clears the badge", async () => {
    expect((await post(`/v1/chats/${threadId}/read`, {})).status).toBe(204);
    const body = (await (await get("/v1/chats")).json()) as { unreadCount: number }[];
    expect(body[0]!.unreadCount).toBe(0);
  });

  test("another environment cannot", async () => {
    expect((await post(`/v1/chats/${threadId}/read`, {}, otherKey)).status).toBe(404);
    const body = (await (await get("/v1/chats")).json()) as { unreadCount: number }[];
    expect(body[0]!.unreadCount, "another environment cleared this badge").toBe(1);
  });
});

describe("replying", () => {
  test("is accepted as pending, not as sent", async () => {
    // The response must not claim delivery. Acceptance meant nothing for 203
    // seconds when it was measured (docs/12), and a console that renders this
    // as delivered repeats that mistake.
    const res = await post(`/v1/chats/${threadId}/messages`, { text: "replying" });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { status: string; note: string };
    expect(body.status).toBe("pending");
    expect(body.note).toContain("ack");
  });

  test("appears in the thread", async () => {
    await post(`/v1/chats/${threadId}/messages`, { text: "replying" });
    const body = (await (await get(`/v1/chats/${threadId}/messages`)).json()) as {
      direction: string;
      body: string;
    }[];
    expect(body).toHaveLength(2);
    expect(body[1]!.direction).toBe("outbound");
  });

  test("another environment cannot reply into it", async () => {
    expect((await post(`/v1/chats/${threadId}/messages`, { text: "x" }, otherKey)).status).toBe(404);
  });

  test("an empty message is refused", async () => {
    expect((await post(`/v1/chats/${threadId}/messages`, { text: "" })).status).toBeGreaterThanOrEqual(400);
  });
});
