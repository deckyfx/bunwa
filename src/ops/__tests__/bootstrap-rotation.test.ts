/**
 * What happens to the operator's credential when `API_KEY` changes.
 *
 * The one key that cannot be rotated from inside the product: it lives in the
 * environment, so every change to it arrives as a restart, and the only chance
 * to get the consequences right is the moment the process comes up. Nothing
 * tested that moment, and both things it got wrong locked the operator out of
 * their own instance in ways that left no trace explaining why.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import { createDatabase, resetDatabase, type Database } from "../../db";
import { MigrationManager } from "../../db/migration-manager";
import { apiKeys } from "../../db/schema";
import { resetConfig } from "../../config/env";
import { captureEnv, FIXTURE_ENV_KEYS } from "../../testing/env";
import { ensureBootstrap, BOOTSTRAP_KEY_LABEL } from "../bootstrap";
import { bootstrapPrefix } from "../../auth/api-key";

const restoreEnv = captureEnv([...FIXTURE_ENV_KEYS]);

let dir: string;
let database: Database;

/** Come up with `API_KEY` set to this value, as a restart would. */
const bootWith = async (key: string): Promise<void> => {
  Bun.env["API_KEY"] = key;
  resetConfig();
  await ensureBootstrap(database);
};

/** Every bootstrap row, oldest first. */
const rows = async () =>
  database
    .select({ prefix: apiKeys.keyPrefix, revokedAt: apiKeys.revokedAt, level: apiKeys.level })
    .from(apiKeys)
    .where(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL))
    .orderBy(apiKeys.createdAt);

/** The one row for this key, found rather than indexed. */
const rowFor = async (prefix: string) => (await rows()).find((r) => r.prefix === prefix);

/** The row currently able to authenticate, if any. */
const active = async () => (await rows()).filter((r) => r.revokedAt === null);

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "bunwa-boot-"));
  // Cleared first: a value left by an earlier test in this file would make the
  // migration step below come up already configured.
  delete Bun.env["API_KEY"];
  resetConfig();
  Bun.env["NODE_ENV"] = "test";
  Bun.env["LOG_LEVEL"] = "error";
  Bun.env["RUNTIME_DIR"] = dir;
  Bun.env["DATABASE_PATH"] = join(dir, "test.sqlite");
  database = createDatabase(join(dir, "test.sqlite"));
  await MigrationManager.runMigrations(database);
});

afterEach(() => {
  resetDatabase();
  rmSync(dir, { recursive: true, force: true });
  resetConfig();
  restoreEnv();
});

describe("API_KEY registration", () => {
  test("registers once and recognises itself across restarts", async () => {
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_alpha_secret_padding_0001");

    // Three boots, one row: the prefix is derived from the key, so a restart
    // recognises what it wrote last time rather than piling up duplicates.
    expect(await rows()).toHaveLength(1);
    expect((await active())[0]?.level).toBe("admin");
  });

  test("rotating retires the previous key and leaves exactly one usable", async () => {
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_beta_secret_padding_0002");

    expect(await rows(), "the rotation did not record the old key").toHaveLength(2);

    // Found by prefix rather than by position. Two boots can land in the same
    // millisecond, and `createdAt` is the only ordering key — so asking for
    // "the first row" was asking a question the data cannot always answer.
    const alpha = await rowFor(bootstrapPrefix("bw_live_admin_alpha_secret_padding_0001"));
    const beta = await rowFor(bootstrapPrefix("bw_live_admin_beta_secret_padding_0002"));
    expect(alpha?.revokedAt, "the superseded key still authenticates").not.toBeNull();
    expect(beta?.revokedAt, "the new key was registered already revoked").toBeNull();

    const usable = await active();
    expect(usable, "rotation left more than one working credential").toHaveLength(1);
    expect(usable[0]?.prefix).toBe(beta?.prefix);
  });

  test("rolling back to a previous API_KEY works again", async () => {
    // The bug: X → Y → X found X's superseded row, took it for an existing
    // registration and returned. The operator rolled a deployment back to the
    // key they had been using an hour earlier and it no longer authenticated,
    // with nothing anywhere saying why.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    const alpha = bootstrapPrefix("bw_live_admin_alpha_secret_padding_0001");

    await bootWith("bw_live_admin_beta_secret_padding_0002");
    await bootWith("bw_live_admin_alpha_secret_padding_0001");

    const usable = await active();
    expect(usable, "rolling back to a former API_KEY left no working credential").toHaveLength(1);
    expect(usable[0]?.prefix, "the wrong key came back").toBe(alpha);
  });

  test("a key revoked by hand stays revoked across a restart", async () => {
    // The counterpart, and the reason the rollback case cannot simply
    // re-register anything it finds revoked. Revoking the current API_KEY is
    // the only way to disable it without a redeploy, so a restart must not
    // undo it.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");

    const now = new Date();
    await database
      .update(apiKeys)
      .set({ revokedAt: now, updatedAt: now })
      .where(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL));

    await bootWith("bw_live_admin_alpha_secret_padding_0001");

    expect(await active(), "a restart un-revoked a key that was revoked deliberately").toHaveLength(0);
    expect(await rows(), "a restart registered a second row for the same key").toHaveLength(1);
  });
});

describe("when two registrations share a timestamp", () => {
  /** Flatten every bootstrap row onto one `createdAt`, as a restart loop would. */
  const collapseTimestamps = async () => {
    const when = new Date(1_700_000_000_000);
    await database
      .update(apiKeys)
      .set({ createdAt: when })
      .where(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL));
  };

  test("the rollback still works when createdAt cannot break the tie", async () => {
    // SQLite does not define the order of rows with equal `createdAt`, so
    // picking "the newest" by that column was asking a question the data does
    // not answer. With the timestamps collapsed, ordering could hand back the
    // revoked half of the rotation as the current registration and the X → Y →
    // X rollback would silently fail again.
    //
    // The decision is made from revocation now — at most one bootstrap row is
    // ever live, which is a fact about the writes rather than about the clock.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_beta_secret_padding_0002");
    await collapseTimestamps();

    await bootWith("bw_live_admin_alpha_secret_padding_0001");

    const usable = await active();
    expect(usable, "a tied timestamp left no working credential").toHaveLength(1);
    expect(usable[0]?.prefix, "the tie decided which key came back").toBe(
      bootstrapPrefix("bw_live_admin_alpha_secret_padding_0001"),
    );
  });

  test("a hand-revoked key stays revoked when createdAt cannot break the tie", async () => {
    // The other side of the same tie. Nothing is live here, so the decision
    // falls to which key was revoked last — and that must still be the one the
    // operator acted on, not whichever row the database happened to return.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_beta_secret_padding_0002");
    await collapseTimestamps();

    const now = new Date();
    await database
      .update(apiKeys)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL), isNull(apiKeys.revokedAt)));

    await bootWith("bw_live_admin_beta_secret_padding_0002");

    expect(await active(), "a restart un-revoked the key an operator had disabled").toHaveLength(0);
  });
});

describe("a database written before rotation retired anything", () => {
  test("leaves exactly one usable key, even when one of them is the current one", async () => {
    // Rotation did not always revoke what it replaced, so an existing database
    // can hold several live bootstrap rows. Returning because one of them
    // matched the current API_KEY left the others usable — admin keys carrying
    // every scope, for values the operator had already replaced and believed
    // were gone.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");

    // A second live row for a key that is no longer configured, as the old
    // code would have left behind.
    const now = new Date();
    await database.insert(apiKeys).values({
      level: "admin",
      environmentId: null,
      keyHash: "stale-hash",
      keyPrefix: "bw_boot_stale000000000000000000",
      label: BOOTSTRAP_KEY_LABEL,
      scopes: [],
      createdAt: now,
      updatedAt: now,
    });
    expect(await active(), "the fixture did not produce two live rows").toHaveLength(2);

    await bootWith("bw_live_admin_alpha_secret_padding_0001");

    const usable = await active();
    expect(usable, "a superseded API_KEY was left able to authenticate").toHaveLength(1);
    expect(usable[0]?.prefix).toBe(bootstrapPrefix("bw_live_admin_alpha_secret_padding_0001"));

    // And it settles: the next restart recognises the single live row and
    // writes nothing further.
    const before = (await rows()).length;
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    expect((await rows()).length, "the repair repeated itself on every boot").toBe(before);
  });
});

describe("when two revocations share a timestamp", () => {
  test("a hand-revoked key stays revoked even if a rotation ties with it", async () => {
    // The last ordering question left: picking "the most recently revoked" row
    // when two were revoked in the same millisecond. A rotation revoking
    // several rows writes one timestamp to all of them, so the tie is not
    // hypothetical. The reason is recorded now, and no rule compares two rows.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_beta_secret_padding_0002");

    // Beta is current; an operator disables it by hand, and every revocation
    // in the table ends up claiming the same instant.
    const when = new Date(1_700_000_000_000);
    await database
      .update(apiKeys)
      .set({ revokedAt: when, updatedAt: when })
      .where(and(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL), isNull(apiKeys.revokedAt)));
    await database
      .update(apiKeys)
      .set({ revokedAt: when })
      .where(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL));

    await bootWith("bw_live_admin_beta_secret_padding_0002");

    expect(
      await active(),
      "a tied timestamp let a restart re-register a key an operator had disabled",
    ).toHaveLength(0);
  });

  test("a superseded key still comes back when its revocation ties", async () => {
    // The other direction, so the rule cannot be read as "never re-register".
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_beta_secret_padding_0002");

    const when = new Date(1_700_000_000_000);
    await database.update(apiKeys).set({ revokedAt: when }).where(isNotNull(apiKeys.revokedAt));

    await bootWith("bw_live_admin_alpha_secret_padding_0001");

    const usable = await active();
    expect(usable, "a rollback to a superseded key left nothing usable").toHaveLength(1);
    expect(usable[0]?.prefix).toBe(bootstrapPrefix("bw_live_admin_alpha_secret_padding_0001"));
  });
});

describe("a key disabled by hand stays disabled", () => {
  /** Disable whatever currently authenticates, the way the CLI or admin API does. */
  const revokeByHand = async () => {
    const now = new Date();
    await database
      .update(apiKeys)
      .set({ revokedAt: now, updatedAt: now })
      .where(and(eq(apiKeys.label, BOOTSTRAP_KEY_LABEL), isNull(apiKeys.revokedAt)));
  };

  test("through a rotation away and back again", async () => {
    // X → Y → disable Y by hand → X → Y. The check for a hand-revoked key sat
    // inside the "nothing is live" branch, so with X live the return to Y
    // skipped it and re-inserted Y: an admin key holding every scope, brought
    // back by an environment variable after a person had deliberately disabled
    // it.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_beta_secret_padding_0002");
    await revokeByHand();

    // Back to X, which was only ever superseded, so it legitimately returns.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    expect(await active(), "a superseded key did not come back").toHaveLength(1);

    // And now back to Y, which a person disabled.
    await bootWith("bw_live_admin_beta_secret_padding_0002");

    const beta = bootstrapPrefix("bw_live_admin_beta_secret_padding_0002");
    expect(
      (await active()).map((r) => r.prefix),
      "a key an operator disabled was re-registered by setting the variable back to it",
    ).not.toContain(beta);
  });

  test("and takes any still-live key down with it", async () => {
    // The consequence of refusing the configured key: whatever was live is a
    // previous API_KEY, and leaving it working would mean a stale credential
    // surviving precisely because the current one was refused.
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    await bootWith("bw_live_admin_beta_secret_padding_0002");
    await revokeByHand();
    await bootWith("bw_live_admin_alpha_secret_padding_0001");
    expect(await active(), "the fixture did not leave alpha live").toHaveLength(1);

    await bootWith("bw_live_admin_beta_secret_padding_0002");

    expect(
      await active(),
      "a previous API_KEY kept working after the configured one was refused",
    ).toHaveLength(0);
  });
});
