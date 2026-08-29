/**
 * Ending a device: the session, the credentials, and everything they reached.
 *
 * One operation because both levels of the console call it and the difference
 * between them is *when*, not *what*. An operator retiring a device and the
 * last project releasing one must destroy the same things, or the version
 * nobody exercised is the one that leaves account-takeover material behind.
 *
 * Ordered so a failure part-way through cannot leave a live socket attached to
 * credentials that have already gone: the socket ends first, then the
 * credentials, then what they were used to fetch, and only then does the row
 * say the device is unpaired.
 *
 * Deliberately not deletion. The device row and its consent history survive,
 * because "who agreed to what, and when" is the record a disputed claim is
 * settled from and it outlives the pairing it describes.
 */
import { eq } from "drizzle-orm";

import { AuthStateStore } from "../stores/auth-state-store";
import { ChatStore } from "../stores/chat-store";
import { db, type Database } from "../db";
import { devices } from "../db/schema";
import { DeviceStore } from "../stores/device-store";
import { type EngineRegistry } from "../engine/registry";
import { log } from "../observability/logger";

export interface RetireOutcome {
  /** Whether a live session was found and ended. */
  hadSession: boolean;
  messagesErased: number;
  threadsErased: number;
}

/**
 * End a device and destroy everything its pairing gave access to.
 *
 * Takes the registry rather than reaching for a global one so the caller's
 * engines are the ones asked: a retire that quietly used a different registry
 * would report success having left the real socket connected.
 *
 * Both engine calls are best-effort. A pool that no longer holds this device,
 * or a socket already gone, must not stop the credentials being destroyed —
 * the failure worth preventing is material surviving the operation, not an
 * operation refusing to finish.
 *
 * @returns what was actually found and erased, so the caller can say
 * "credentials destroyed" rather than "credentials probably destroyed".
 */
export async function retireDevice(
  deviceId: string,
  registry: EngineRegistry,
  database: Database = db(),
): Promise<RetireOutcome> {
  const [device] = await database
    .select({ enginePoolId: devices.enginePoolId })
    .from(devices)
    .where(eq(devices.id, deviceId))
    .limit(1);

  const poolId = device?.enginePoolId ?? null;
  let hadSession = false;

  if (poolId !== null) {
    // `list().find` rather than `get`, which throws for a pool that is not
    // registered. A device assigned to a pool this process did not configure
    // is exactly the case retirement has to survive: the credentials still
    // need destroying whether or not anything can reach the socket.
    const pool = registry.list().find((candidate) => candidate.id === poolId);
    if (pool !== undefined) {
      hadSession = true;

      // logout before purge: logout tells WhatsApp the device is unlinked, so
      // the phone stops listing it. Purging first would drop the credentials
      // needed to send that message, leaving the account paired to a device
      // that no longer exists anywhere but on the customer's screen.
      //
      // Best effort, because a socket that is already gone must not stop the
      // credentials being destroyed. That order is the one that matters: a
      // failed logout leaves a stale entry in a list, a skipped purge leaves
      // the keys to someone's WhatsApp account in the database.
      await pool.engine.logout(deviceId).catch((err: unknown) => {
        log.warn("logout failed while retiring a device; continuing", {
          deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      await pool.engine.purge(deviceId).catch((err: unknown) => {
        log.warn("engine purge failed while retiring a device; continuing", {
          deviceId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  // The credentials and the Signal keys. This is the part that makes the
  // retirement real: without it the device could be resumed from storage on
  // the next boot, whatever the row says.
  await AuthStateStore.forget(deviceId, database);

  const erased = await ChatStore.forgetDevice(deviceId, database);
  await DeviceStore.markRetired(deviceId, database);

  log.info("device retired", {
    deviceId,
    hadSession,
    messagesErased: erased.messages,
    threadsErased: erased.threads,
  });

  return { hadSession, messagesErased: erased.messages, threadsErased: erased.threads };
}
