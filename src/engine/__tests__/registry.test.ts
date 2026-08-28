import { describe, expect, test } from "bun:test";

import { EngineRegistry } from "../registry";
import { FakeEngine } from "../fake";
import { EngineError } from "../types";

const pool = (id: string, capacity: number) => ({
  id,
  kind: "fake" as const,
  engine: new FakeEngine(),
  capacity,
});

describe("EngineRegistry", () => {
  test("refuses a duplicate pool id", () => {
    const registry = new EngineRegistry();
    registry.register(pool("a", 25));
    expect(() => registry.register(pool("a", 25))).toThrow(EngineError);
  });

  test("chooses the least loaded pool", () => {
    const registry = new EngineRegistry();
    registry.register(pool("a", 25));
    registry.register(pool("b", 25));
    const chosen = registry.choosePool("fake", new Map([["a", 10], ["b", 3]]));
    expect(chosen.id).toBe("b");
  });

  test("will not exceed a pool's capacity", () => {
    // Capacity is the blast radius: one pool holding everything is what
    // ADR-0003 exists to prevent.
    const registry = new EngineRegistry();
    registry.register(pool("a", 2));
    expect(() => registry.choosePool("fake", new Map([["a", 2]]))).toThrow(/capacity/);
  });

  test("will not substitute a different engine kind", () => {
    const registry = new EngineRegistry();
    registry.register(pool("a", 25));
    expect(() => registry.choosePool("baileys", new Map())).toThrow(/no baileys engine pool/);
  });

  test("an unknown pool is an error rather than undefined", () => {
    expect(() => new EngineRegistry().get("nope")).toThrow(EngineError);
  });
});

describe("choosing without naming an engine", () => {
  const noneAssigned = new Map<string, number>();

  test("registration order is the preference order", () => {
    // The composition root decides which engine a deployment prefers by the
    // order it registers them. The pairing route names none.
    const registry = new EngineRegistry();
    registry.register({ id: "first-1", kind: "fake", capacity: 2, engine: new FakeEngine() });
    registry.register({ id: "baileys-1", kind: "baileys", capacity: 2, engine: new FakeEngine() });

    expect(registry.chooseAny(noneAssigned).id).toBe("first-1");
  });

  test("a full first choice falls through to the next kind", () => {
    // Two kinds, not two pools of one. Both were registered as "baileys" and
    // named `gowa-1` and `baileys-1` — leftovers from the rename — so the test
    // asserted a fallthrough between pools while claiming one between kinds,
    // and would have passed with the kind handling removed entirely.
    const registry = new EngineRegistry();
    registry.register({ id: "fake-1", kind: "fake", capacity: 1, engine: new FakeEngine() });
    registry.register({ id: "baileys-1", kind: "baileys", capacity: 1, engine: new FakeEngine() });

    expect(registry.chooseAny(new Map([["fake-1", 1]])).id).toBe("baileys-1");
  });

  test("a Baileys-only deployment can pair", () => {
    // The case the hardcoded choosePool("baileys", …) made impossible: an engine
    // was registered, had room, and pairing was refused anyway.
    const registry = new EngineRegistry();
    registry.register({ id: "baileys-1", kind: "baileys", capacity: 5, engine: new FakeEngine() });

    expect(registry.chooseAny(noneAssigned).id).toBe("baileys-1");
  });

  test("no room anywhere is an EngineError, not a silent choice", () => {
    const registry = new EngineRegistry();
    registry.register({ id: "baileys-1", kind: "baileys", capacity: 1, engine: new FakeEngine() });

    expect(() => registry.chooseAny(new Map([["baileys-1", 1]]))).toThrow(EngineError);
  });

  test("an empty registry refuses rather than returning undefined", () => {
    expect(() => new EngineRegistry().chooseAny(noneAssigned)).toThrow(EngineError);
  });
});
