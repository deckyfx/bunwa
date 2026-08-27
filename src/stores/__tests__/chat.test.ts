/**
 * Conversation history.
 *
 * The properties that matter are tenancy and idempotency: bunwa is now the
 * system of record for other people's messages, so one tenant reading
 * another's is a bug that can exist, and WhatsApp resending a message must not
 * show the customer the same thing twice.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { ChatStore } from "../chat-store";
import { DeviceStore } from "../device-store";
import { ProjectStore } from "../project-store";
import { EnvironmentStore } from "../environment-store";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

let dir: string;
let database: Database;
let environmentId: string;
let otherEnvironmentId: string;
let deviceId: string;
let otherDeviceId: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-chat-"));
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
  environmentId = env.id;
  otherEnvironmentId = other.id;

  deviceId = (
    await DeviceStore.claim({ environmentId, msisdn: "+628111111111", alias: "otp" }, database)
  ).device.id;
  otherDeviceId = (
    await DeviceStore.claim(
      { environmentId: otherEnvironmentId, msisdn: "+628222222222", alias: "staging-otp" },
      database,
    )
  ).device.id;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

const inbound = (over: Partial<Parameters<typeof ChatStore.record>[0]> = {}) => ({
  deviceId,
  peerJid: "628999@s.whatsapp.net",
  direction: "inbound" as const,
  providerMessageId: "wa-1",
  kind: "text" as const,
  body: "hello",
  occurredAt: new Date(1_000),
  ...over,
});

describe("recording a message", () => {
  test("creates the thread and the message together", async () => {
    const recorded = await ChatStore.record(inbound(), database);
    expect(recorded).not.toBeNull();

    const threads = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    expect(threads).toHaveLength(1);
    expect(threads[0]!.peerJid).toBe("628999@s.whatsapp.net");
    expect(threads[0]!.unreadCount).toBe(1);
  });

  test("a resent message is not stored twice", async () => {
    // WhatsApp resends. A duplicate row shows the customer the same message
    // twice, and the second call returning null is how a caller tells the
    // difference without another query.
    expect(await ChatStore.record(inbound(), database)).not.toBeNull();
    expect(await ChatStore.record(inbound(), database)).toBeNull();

    const messages = await ChatStore.messagesInThread(
      environmentId,
      (await ChatStore.threadsForEnvironment(environmentId, 50, database))[0]!.id,
      200,
      database,
    );
    expect(messages).toHaveLength(1);
  });

  test("unread counts up in SQL, so simultaneous arrivals do not drift", async () => {
    await ChatStore.record(inbound({ providerMessageId: "a" }), database);
    await ChatStore.record(inbound({ providerMessageId: "b" }), database);
    await ChatStore.record(inbound({ providerMessageId: "c" }), database);

    const [thread] = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    expect(thread!.unreadCount).toBe(3);
  });

  test("an outbound message does not raise the unread count", async () => {
    await ChatStore.record(inbound({ direction: "outbound", providerMessageId: "out-1" }), database);
    const [thread] = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    expect(thread!.unreadCount).toBe(0);
  });
});

describe("one tenant cannot see another's conversations", () => {
  test("threads are scoped to the environment", async () => {
    await ChatStore.record(inbound(), database);
    await ChatStore.record(
      inbound({ deviceId: otherDeviceId, peerJid: "628777@s.whatsapp.net", providerMessageId: "wa-2" }),
      database,
    );

    const mine = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.peerJid).toBe("628999@s.whatsapp.net");
  });

  test("messages in someone else's thread are not readable", async () => {
    await ChatStore.record(inbound(), database);
    const [thread] = await ChatStore.threadsForEnvironment(environmentId, 50, database);

    // The other environment asks for a thread id it does not own.
    const stolen = await ChatStore.messagesInThread(otherEnvironmentId, thread!.id, 200, database);
    expect(stolen, "another environment read this thread's messages").toEqual([]);
  });

  test("marking read is refused across environments", async () => {
    await ChatStore.record(inbound(), database);
    const [thread] = await ChatStore.threadsForEnvironment(environmentId, 50, database);

    expect(await ChatStore.markRead(otherEnvironmentId, thread!.id, database)).toBe(false);
    const [after] = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    expect(after!.unreadCount, "another environment cleared this badge").toBe(1);
  });

  test("the owner can mark it read", async () => {
    await ChatStore.record(inbound(), database);
    const [thread] = await ChatStore.threadsForEnvironment(environmentId, 50, database);

    expect(await ChatStore.markRead(environmentId, thread!.id, database)).toBe(true);
    expect((await ChatStore.threadsForEnvironment(environmentId, 50, database))[0]!.unreadCount).toBe(0);
  });
});

describe("retention", () => {
  test("old messages go and recent ones stay", async () => {
    await ChatStore.record(inbound({ providerMessageId: "old", occurredAt: new Date(1_000) }), database);
    await ChatStore.record(inbound({ providerMessageId: "new", occurredAt: new Date(100_000) }), database);

    expect(await ChatStore.sweepOlderThan(new Date(50_000), database)).toBe(1);

    const [thread] = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    const left = await ChatStore.messagesInThread(environmentId, thread!.id, 200, database);
    expect(left).toHaveLength(1);
  });

  test("the thread survives its messages", async () => {
    // An empty conversation is still a conversation. Deleting it would make
    // the peer vanish from the console rather than merely lose its history.
    await ChatStore.record(inbound(), database);
    await ChatStore.sweepOlderThan(new Date(50_000), database);

    expect(await ChatStore.threadsForEnvironment(environmentId, 50, database)).toHaveLength(1);
  });
});
