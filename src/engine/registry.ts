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

  async closeAll(): Promise<void> {
    await Promise.all(this.list().map((p) => p.engine.close()));
    this.pools.clear();
  }
}
