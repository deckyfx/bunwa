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
    expect(() => registry.choosePool("gowa", new Map())).toThrow(/no gowa engine pool/);
  });

  test("an unknown pool is an error rather than undefined", () => {
    expect(() => new EngineRegistry().get("nope")).toThrow(EngineError);
  });
});
