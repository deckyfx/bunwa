/**
 * Where a device's WhatsApp credentials and Signal keys live.
 *
 * Deals in opaque bytes and knows nothing about Baileys. That separation is
 * deliberate: ADR-0009 allows exactly one file to import the library, so the
 * serialisation of credentials belongs in the port and the encryption,
 * tenancy and retention belong here, where the rest of the stores are.
 *
 * Everything is sealed before it reaches a column. `creds` is
 * account-takeover material and the Signal keys decrypt message content, so
 * neither is something to hold in the clear in a multi-tenant database
 * ([13](../../docs/13-owning-the-data.md)).
 *
 * ## Why these methods take a device and not an environment
 *
 * A review asked for tenant scoping here, as the store path instructions
 * require, and it is the one place in the codebase where that would be wrong.
 *
 * Credentials belong to the WhatsApp account, and the account belongs to the
 * device — which docs/04 makes global and system-owned precisely so several
 * projects can share one number through the consent flow. A device held by two
 * projects has exactly one set of credentials and one Signal session. There is
 * no environment that owns them, so an environment parameter here could only
 * be decorative: whatever value a caller passed, the same row would be read.
 *
 * What that scoping is for is enforced instead where the tenant boundary
 * actually is. Chat history carries `environment_id` and is scoped on it.
 * `ChatStore.record` refuses an environment with no active binding. The device
 * routes resolve a binding before touching an engine.
 *
 * And no request reaches this file. Its only caller is the Baileys port, with
 * a device id the engine already holds — never one a caller supplied. If that
 * changes, the binding check belongs at the new caller, where an environment
 * exists to check against.
 */
import { and, count, eq, inArray } from "drizzle-orm";

import { db, type Database } from "../db";
import { withTransaction } from "../db/transaction";
import { deviceCredentials, deviceSignalKeys } from "../db/schema";
import { keyFromSecret, keyIdHash, open, seal } from "../crypto/secret-box";
import { config } from "../config/env";

/**
 * The encryption key, or a refusal.
 *
 * Read per call rather than cached at module load: config is reloaded between
 * tests, and a cached key would outlive the configuration it came from.
 */
function requireKey(): Buffer {
  const secret = config().credentialEncryptionKey;
  if (secret === null) {
    // Reached only outside production, where the key is optional. Refusing is
    // the point — the alternative is writing account-takeover material in the
    // clear because someone forgot a variable in development and then copied
    // that deployment.
    throw new Error(
      "cannot store WhatsApp credentials without CREDENTIAL_ENCRYPTION_KEY; generate one with `openssl rand -hex 32`",
    );
  }
  return keyFromSecret(secret);
}

export const AuthStateStore = {
  /**
   * Restore a paired device's account state after a restart.
   *
   * The reason credentials are persisted at all: without this a process
   * restart would make every customer re-pair, which is the most expensive
   * thing this system could do to them. Null means the device has never
   * paired, so the caller starts a fresh identity rather than failing.
   */
  async loadCreds(deviceId: string, database: Database = db()): Promise<Buffer | null> {
    const [row] = await database
      .select({ ciphertext: deviceCredentials.ciphertext, iv: deviceCredentials.iv })
      .from(deviceCredentials)
      .where(eq(deviceCredentials.deviceId, deviceId))
      .limit(1);

    if (row === undefined) return null;
    return open({ ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv) }, requireKey());
  },

  /**
   * Write the credentials.
   *
   * Upsert rather than delete-then-insert: Baileys reports creds.update
   * frequently, and a window where a device has no credentials at all is a
   * window where a restart loses the pairing.
   */
  async saveCreds(deviceId: string, plaintext: Buffer, database: Database = db()): Promise<void> {
    const sealed = seal(plaintext, requireKey());
    await database
      .insert(deviceCredentials)
      .values({ deviceId, ciphertext: sealed.ciphertext, iv: sealed.iv, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: deviceCredentials.deviceId,
        set: { ciphertext: sealed.ciphertext, iv: sealed.iv, updatedAt: new Date() },
      });
  },

  /**
   * Fetch Signal keys by id.
   *
   * Ids are hashed on the way in, so a caller passes the real id and the
   * database never sees it. Missing ids are simply absent from the result —
   * Baileys expects that and treats it as "not held".
   */
  async loadKeys(
    deviceId: string,
    keyType: string,
    ids: readonly string[],
    database: Database = db(),
  ): Promise<Map<string, Buffer>> {
    if (ids.length === 0) return new Map();

    const key = requireKey();
    const byHash = new Map(ids.map((id) => [keyIdHash(id, key), id]));
    const rows = await database
      .select({
        keyHash: deviceSignalKeys.keyHash,
        ciphertext: deviceSignalKeys.ciphertext,
        iv: deviceSignalKeys.iv,
      })
      .from(deviceSignalKeys)
      .where(
        and(
          eq(deviceSignalKeys.deviceId, deviceId),
          eq(deviceSignalKeys.keyType, keyType),
          inArray(deviceSignalKeys.keyHash, [...byHash.keys()]),
        ),
      );

    const out = new Map<string, Buffer>();
    for (const row of rows) {
      const id = byHash.get(row.keyHash);
      if (id === undefined) continue;
      out.set(id, open({ ciphertext: Buffer.from(row.ciphertext), iv: Buffer.from(row.iv) }, key));
    }
    return out;
  },

  /**
   * Write and delete keys in one transaction.
   *
   * A null value means delete, which is how Baileys expires a consumed
   * pre-key. Both halves in one transaction because a partial application
   * leaves the key store disagreeing with what Baileys believes it holds, and
   * that surfaces as decryption failures rather than as a storage error.
   */
  async saveKeys(
    deviceId: string,
    entries: readonly { keyType: string; id: string; value: Buffer | null }[],
    database: Database = db(),
  ): Promise<void> {
    if (entries.length === 0) return;
    const key = requireKey();
    const now = new Date();

    // withTransaction, not database.transaction. Drizzle's wrapper does not
    // await an async callback on bun-sqlite, so writes either side of an await
    // survive a rollback — verified in this repo, which is why the helper
    // exists. Code written against the wrapper looks transactional and is not.
    await withTransaction(database, async (tx) => {
      for (const entry of entries) {
        const keyHash = keyIdHash(entry.id, key);

        if (entry.value === null) {
          await tx
            .delete(deviceSignalKeys)
            .where(
              and(
                eq(deviceSignalKeys.deviceId, deviceId),
                eq(deviceSignalKeys.keyType, entry.keyType),
                eq(deviceSignalKeys.keyHash, keyHash),
              ),
            );
          continue;
        }

        const sealed = seal(entry.value, key);
        await tx
          .insert(deviceSignalKeys)
          .values({
            deviceId,
            keyType: entry.keyType,
            keyHash,
            ciphertext: sealed.ciphertext,
            iv: sealed.iv,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [deviceSignalKeys.deviceId, deviceSignalKeys.keyType, deviceSignalKeys.keyHash],
            set: { ciphertext: sealed.ciphertext, iv: sealed.iv, updatedAt: now },
          });
      }
    });
  },

  /**
   * Forget everything for a device.
   *
   * What `purge()` needs, and what a logout leaves behind if nobody calls it:
   * credentials that no longer work and thousands of key rows nothing will
   * ever read.
   */
  async forget(deviceId: string, database: Database = db()): Promise<void> {
    // Both or neither. saveKeys already uses a transaction to avoid a
    // half-applied state; two bare deletes here could leave a device holding
    // credentials whose keys are gone, which is the same fault in the other
    // direction and fails as decryption errors rather than as a storage one.
    await withTransaction(database, async (tx) => {
      await tx.delete(deviceSignalKeys).where(eq(deviceSignalKeys.deviceId, deviceId));
      await tx.delete(deviceCredentials).where(eq(deviceCredentials.deviceId, deviceId));
    });
  },

  /** How many key rows a device holds. For tests and for /metrics. */
  async keyCount(deviceId: string, database: Database = db()): Promise<number> {
    // Counted in SQL. This module's own documentation says thousands of rows
    // per device, and loading every one to take a length is a poor thing for
    // /metrics to do on an interval.
    const [row] = await database
      .select({ total: count() })
      .from(deviceSignalKeys)
      .where(eq(deviceSignalKeys.deviceId, deviceId));
    return Number(row?.total ?? 0);
  },
};
