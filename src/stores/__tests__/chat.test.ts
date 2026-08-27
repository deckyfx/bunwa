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
import { handleEngineEvent } from "../../engine/consumer";

const restoreEnv = captureEnv(FIXTURE_ENV_KEYS);

/**
 * Bring a claimed device to an active binding.
 *
 * Through the engine event the product actually uses, rather than an UPDATE.
 * ChatStore.record now refuses an environment with no active binding, and a
 * fixture that fakes the state would be testing a situation the system cannot
 * reach — which is how the original tenancy tests came to pass against a leak.
 */
async function activate(deviceId: string, database: Database): Promise<void> {
  await handleEngineEvent(
    { type: "device.connected", deviceId, jid: "628777777777@s.whatsapp.net", pushName: null },
    database,
    "fake",
  );
}

let dir: string;
let database: Database;
let environmentId: string;
let otherEnvironmentId: string;
let otherProjectId: string;
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

  // Two projects, not two environments of one. Consent is granted per
  // (device, project), so a second environment inside the same project shares
  // its consent and could never demonstrate the boundary being tested here.
  const project = await ProjectStore.create({ slug: "grande", displayName: "G" }, database);
  const env = await EnvironmentStore.create({ projectId: project.id, slug: "prod" }, database);
  const secondProject = await ProjectStore.create({ slug: "rival", displayName: "R" }, database);
  const other = await EnvironmentStore.create({ projectId: secondProject.id, slug: "prod" }, database);
  environmentId = env.id;
  otherEnvironmentId = other.id;
  otherProjectId = secondProject.id;

  deviceId = (
    await DeviceStore.claim({ environmentId, msisdn: "+628111111111", alias: "otp" }, database)
  ).device.id;
  otherDeviceId = (
    await DeviceStore.claim(
      { environmentId: otherEnvironmentId, msisdn: "+628222222222", alias: "staging-otp" },
      database,
    )
  ).device.id;

  // Both paired, because an inbound message for an unpaired device is not a
  // situation the product can produce.
  await activate(deviceId, database);
  await activate(otherDeviceId, database);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  resetDatabase();
  restoreEnv();
});

const inbound = (over: Partial<Parameters<typeof ChatStore.record>[0]> = {}) => ({
  environmentId,
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
      inbound({
        environmentId: otherEnvironmentId,
        deviceId: otherDeviceId,
        peerJid: "628777@s.whatsapp.net",
        providerMessageId: "wa-2",
      }),
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

describe("two projects sharing one phone number", () => {
  // The case the earlier tests could not catch: they used different devices,
  // so the assertions held whether or not scoping worked.
  //
  // The fixture goes through the real consent flow rather than setting
  // virtual_devices.status with raw SQL. A review pointed out that bypassing
  // it proved isolation from an unauthorised state, which is a weaker claim
  // than the one that matters — two projects that both legitimately hold the
  // number still cannot see each other's messages.
  async function shareDeviceWithSecondProject(): Promise<string> {
    const first = await DeviceStore.claim(
      { environmentId, msisdn: "+628777777777", alias: "shared" },
      database,
    );

    const second = await DeviceStore.claim(
      { environmentId: otherEnvironmentId, msisdn: "+628777777777", alias: "shared-too" },
      database,
    );
    expect(second.outcome, "the second claim should need the phone holder's consent").toBe(
      "awaiting_confirmation",
    );

    // The phone holder says yes, exactly as they would over WhatsApp.
    const consent = await DeviceStore.consentFor(first.device.id, otherProjectId, database);
    expect(consent?.challengeToken).toBeString();
    await DeviceStore.respondToConsent(consent!.challengeToken!, "granted", "whatsapp_reply", {}, database);

    // Pairing completes once, for the device both projects now hold.
    await activate(first.device.id, database);

    return first.device.id;
  }

  test("the second project cannot read the first one's conversation", async () => {
    const deviceId = await shareDeviceWithSecondProject();

    await ChatStore.record(
      {
        environmentId,
        deviceId,
        peerJid: "628999@s.whatsapp.net",
        direction: "inbound",
        providerMessageId: "shared-1",
        kind: "text",
        body: "FIRST PROJECT ONLY",
        occurredAt: new Date(5_000),
      },
      database,
    );

    const theirs = await ChatStore.threadsForEnvironment(otherEnvironmentId, 50, database);
    expect(theirs, "the other project saw a conversation on a shared device").toEqual([]);

    // Nor by knowing the thread id, which is the attack a UUID does not stop.
    const mine = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    const thread = mine.find((candidate) => candidate.peerJid === "628999@s.whatsapp.net");
    expect(thread).toBeDefined();
    expect(
      await ChatStore.messagesInThread(otherEnvironmentId, thread!.id, 200, database),
      "the other project read the messages directly",
    ).toEqual([]);
  });

  test("each project keeps its own history on the same device", async () => {
    // Isolation is not the whole requirement: both projects legitimately use
    // the number, so both must be able to talk to the same peer.
    const deviceId = await shareDeviceWithSecondProject();

    for (const [env, body] of [
      [environmentId, "mine"],
      [otherEnvironmentId, "theirs"],
    ] as const) {
      await ChatStore.record(
        {
          environmentId: env,
          deviceId,
          peerJid: "628999@s.whatsapp.net",
          direction: "inbound",
          providerMessageId: `msg-${body}`,
          kind: "text",
          body,
          occurredAt: new Date(5_000),
        },
        database,
      );
    }

    const mine = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    const theirs = await ChatStore.threadsForEnvironment(otherEnvironmentId, 50, database);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]!.id).not.toBe(theirs[0]!.id);

    expect((await ChatStore.messagesInThread(environmentId, mine[0]!.id, 200, database))[0]!.body).toBe("mine");
    expect((await ChatStore.messagesInThread(otherEnvironmentId, theirs[0]!.id, 200, database))[0]!.body).toBe(
      "theirs",
    );
  });

  test("an environment with no binding cannot record at all", async () => {
    // The store refuses rather than trusting the caller's environmentId. Every
    // caller derives it from an active binding today, so this is the boundary
    // where a mistake upstream would otherwise become one tenant's history
    // filed under another's.
    const orphan = await DeviceStore.claim(
      { environmentId, msisdn: "+628666666666", alias: "mine-only" },
      database,
    );

    await expect(
      ChatStore.record(
        {
          environmentId: otherEnvironmentId,
          deviceId: orphan.device.id,
          peerJid: "628999@s.whatsapp.net",
          direction: "inbound",
          providerMessageId: "no-binding",
          kind: "text",
          body: "should not be stored",
          occurredAt: new Date(5_000),
        },
        database,
      ),
    ).rejects.toThrow(/no active binding/);
  });
});

describe("thread ordering", () => {
  test("a late-arriving older message does not drag the thread down the list", async () => {
    // WhatsApp redelivers, so an older message can arrive after a newer one.
    // Taking the last write would sort a live conversation below stale ones
    // and hide it from the console.
    await ChatStore.record(inbound({ providerMessageId: "new", occurredAt: new Date(90_000) }), database);
    await ChatStore.record(inbound({ providerMessageId: "old", occurredAt: new Date(10_000) }), database);

    const [thread] = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    expect(thread!.lastMessageAt?.getTime(), "the thread timestamp moved backwards").toBe(90_000);
  });

  test("a genuinely newer message does move it", async () => {
    await ChatStore.record(inbound({ providerMessageId: "first", occurredAt: new Date(10_000) }), database);
    await ChatStore.record(inbound({ providerMessageId: "second", occurredAt: new Date(90_000) }), database);

    const [thread] = await ChatStore.threadsForEnvironment(environmentId, 50, database);
    expect(thread!.lastMessageAt?.getTime()).toBe(90_000);
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
