/**
 * Which engine holds which device.
 *
 * The indirection that makes an engine replaceable: the control plane asks the
 * registry for a device's engine and never constructs one itself, so moving a
 * device between a gowa pool and a native pool is a row update rather than a
 * code change (ADR-0002).
 */
import { EngineError, type DeviceEngine, type EngineKind } from "./types";

/** A named engine instance and the devices it is responsible for. */
export interface EnginePool {
  id: string;
  kind: EngineKind;
  engine: DeviceEngine;
  /**
   * How many devices this pool may hold.
   *
   * Bounded because one process holding every device is the blast radius
   * ADR-0003 exists to avoid — gowa exits the whole process on StreamReplaced,
   * and a native engine has the same exposure in a different language.
   */
  capacity: number;
}

export class EngineRegistry {
  private readonly pools = new Map<string, EnginePool>();

  register(pool: EnginePool): void {
    if (this.pools.has(pool.id)) throw new EngineError(`engine pool ${pool.id} is already registered`, false);
    this.pools.set(pool.id, pool);
  }

  get(poolId: string): EnginePool {
    const pool = this.pools.get(poolId);
    if (pool === undefined) throw new EngineError(`engine pool ${poolId} is not registered`, false);
    return pool;
  }

  list(): EnginePool[] {
    return [...this.pools.values()];
  }

  /**
   * Choose a pool for a new device.
   *
   * Least-loaded of the requested kind. `assigned` is supplied by the caller
   * from the database rather than counted here: the registry holds no state
   * that could disagree with the rows, which is the sort of drift that has a
   * pool looking empty while it is full.
   */
  choosePool(kind: EngineKind, assigned: ReadonlyMap<string, number>): EnginePool {
    const candidates = this.list()
      .filter((p) => p.kind === kind)
      .filter((p) => (assigned.get(p.id) ?? 0) < p.capacity)
      .sort((a, b) => (assigned.get(a.id) ?? 0) - (assigned.get(b.id) ?? 0));

    const chosen = candidates[0];
    if (chosen === undefined) {
      throw new EngineError(`no ${kind} engine pool has capacity for another device`, false);
    }
    return chosen;
  }

  /**
   * Choose a pool for a new device without naming an engine.
   *
   * Registration order is the preference order, which puts the choice in the
   * composition root where the deployment's intent already lives. The pairing
   * route used to ask for "gowa" by name and fall back to "fake" — so adding
   * an engine meant editing an API route, and a deployment running only
   * Baileys could not pair at all.
   *
   * Least-loaded within the first kind that has room, so the capacity
   * behaviour is unchanged; only the naming moved.
   */
  chooseAny(assigned: ReadonlyMap<string, number>): EnginePool {
    const kinds: EngineKind[] = [];
    for (const pool of this.pools.values()) {
      if (!kinds.includes(pool.kind)) kinds.push(pool.kind);
    }

    for (const kind of kinds) {
      try {
        return this.choosePool(kind, assigned);
      } catch (err) {
        // Only "no room in this kind" is worth trying the next kind for.
        if (!(err instanceof EngineError)) throw err;
      }
    }

    throw new EngineError("no engine pool has capacity for another device", false);
  }

  /**
   * The pool holding a device, or the only pool if it has no assignment yet.
   *
   * Returns undefined rather than guessing when there are several pools and no
   * recorded assignment: sending through an engine that has never provisioned
   * the device fails in a way that looks like the device is broken.
   */
  forDevice(poolId: string | null): EnginePool | undefined {
    if (poolId !== null) return this.pools.get(poolId);
    const all = this.list();
    return all.length === 1 ? all[0] : undefined;
  }

  /**
   * Close every engine, then clear.
   *
   * allSettled, not all: one engine that throws on close must not leave the
   * others open and the registry populated — this runs during shutdown, where
   * the alternative is a process that will not exit.
   */
  async closeAll(): Promise<void> {
    const results = await Promise.allSettled(this.list().map((p) => p.engine.close()));
    this.pools.clear();
    const failed = results.filter((r) => r.status === "rejected");
    if (failed.length > 0) {
      throw new EngineError(`${failed.length} engine(s) failed to close`, false, { cause: failed[0] });
    }
  }
}
