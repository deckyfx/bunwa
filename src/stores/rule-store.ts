/**
 * Rule storage.
 *
 * Every method takes the environment that must own the binding. Rules decide
 * what a device does with a customer's messages, so reaching another tenant's
 * would be among the worst leaks in the system — and with SQLite there is no
 * row-level security behind this (ADR-0005).
 */
import { and, asc, eq } from "drizzle-orm";

import { db, type Database } from "../db";
import { rules, virtualDevices, type JsonValue, type Rule } from "../db/schema";
import { prepareRule, type PreparedRule, type RuleDefinition } from "../rules/schema";
import { ConflictError, NotFoundError } from "./errors";

export class RuleStore {
  /**
   * Create a rule.
   *
   * Validated and compiled before it is stored, so an unsafe pattern is
   * refused here rather than on the inbound path where the only options are to
   * drop a customer's message or to hang.
   */
  static async create(
    environmentId: string,
    virtualDeviceId: string,
    definition: RuleDefinition,
    database: Database = db(),
  ): Promise<Rule> {
    await this.requireBinding(environmentId, virtualDeviceId, database);
    prepareRule(definition);

    const existing = await database
      .select({ id: rules.id })
      .from(rules)
      .where(and(eq(rules.virtualDeviceId, virtualDeviceId), eq(rules.name, definition.name)))
      .limit(1);
    if (existing.length > 0) {
      throw new ConflictError(`a rule named "${definition.name}" already exists for this device`, "name");
    }

    const [created] = await database
      .insert(rules)
      .values({
        virtualDeviceId,
        environmentId,
        name: definition.name,
        enabled: definition.enabled,
        priority: definition.priority,
        stopOnMatch: definition.stopOnMatch,
        match: definition.match as unknown as Record<string, JsonValue>,
        actions: definition.actions as unknown as JsonValue[],
      })
      .returning();
    if (created === undefined) throw new Error("insert returned no row");
    return created;
  }

  /** Replace a rule, bumping its version so a change is visible in an audit. */
  static async update(
    environmentId: string,
    virtualDeviceId: string,
    ruleId: string,
    definition: RuleDefinition,
    database: Database = db(),
  ): Promise<Rule> {
    const current = await this.requireRule(environmentId, virtualDeviceId, ruleId, database);
    prepareRule(definition);

    const [updated] = await database
      .update(rules)
      .set({
        name: definition.name,
        enabled: definition.enabled,
        priority: definition.priority,
        stopOnMatch: definition.stopOnMatch,
        match: definition.match as unknown as Record<string, JsonValue>,
        actions: definition.actions as unknown as JsonValue[],
        version: current.version + 1,
        // Cleared: an edit is the operator saying the problem is addressed.
        disabledReason: null,
        updatedAt: new Date(),
      })
      .where(eq(rules.id, ruleId))
      .returning();
    if (updated === undefined) throw new NotFoundError(`rule ${ruleId} not found`);
    return updated;
  }

  static async list(
    environmentId: string,
    virtualDeviceId: string,
    database: Database = db(),
  ): Promise<Rule[]> {
    await this.requireBinding(environmentId, virtualDeviceId, database);
    return database
      .select()
      .from(rules)
      .where(and(eq(rules.virtualDeviceId, virtualDeviceId), eq(rules.environmentId, environmentId)))
      .orderBy(asc(rules.priority));
  }

  static async remove(
    environmentId: string,
    virtualDeviceId: string,
    ruleId: string,
    database: Database = db(),
  ): Promise<void> {
    await this.requireRule(environmentId, virtualDeviceId, ruleId, database);
    await database.delete(rules).where(eq(rules.id, ruleId));
  }

  /**
   * Load a binding's rules ready to evaluate.
   *
   * A rule that no longer compiles is skipped rather than throwing: one bad
   * rule must not stop every other rule on the device from running, and it was
   * already validated once, so this means something changed underneath it.
   */
  static async prepared(
    virtualDeviceId: string,
    database: Database = db(),
  ): Promise<{ prepared: PreparedRule[]; broken: string[] }> {
    const rows = await database
      .select()
      .from(rules)
      .where(and(eq(rules.virtualDeviceId, virtualDeviceId), eq(rules.enabled, true)))
      .orderBy(asc(rules.priority));

    const prepared: PreparedRule[] = [];
    const broken: string[] = [];
    for (const row of rows) {
      try {
        prepared.push(prepareRule(toDefinition(row)));
      } catch {
        broken.push(row.id);
      }
    }
    return { prepared, broken };
  }

  /**
   * Disable a rule that exceeded its match budget, recording why.
   *
   * The reason is stored rather than silently flipping `enabled`, so an
   * operator can tell a rule that protected itself from one somebody turned off.
   */
  static async disableForTimeout(ruleId: string, database: Database = db()): Promise<void> {
    await database
      .update(rules)
      .set({
        enabled: false,
        disabledReason: "the match pattern repeatedly exceeded its time budget",
        updatedAt: new Date(),
      })
      .where(eq(rules.id, ruleId));
  }

  private static async requireBinding(
    environmentId: string,
    virtualDeviceId: string,
    database: Database,
  ): Promise<void> {
    const [found] = await database
      .select({ id: virtualDevices.id })
      .from(virtualDevices)
      .where(and(eq(virtualDevices.id, virtualDeviceId), eq(virtualDevices.environmentId, environmentId)))
      .limit(1);
    if (found === undefined) throw new NotFoundError(`device ${virtualDeviceId} not found`);
  }

  private static async requireRule(
    environmentId: string,
    virtualDeviceId: string,
    ruleId: string,
    database: Database,
  ): Promise<Rule> {
    const [found] = await database
      .select()
      .from(rules)
      .where(
        and(
          eq(rules.id, ruleId),
          eq(rules.virtualDeviceId, virtualDeviceId),
          eq(rules.environmentId, environmentId),
        ),
      )
      .limit(1);
    if (found === undefined) throw new NotFoundError(`rule ${ruleId} not found`);
    return found;
  }
}

/** A stored row as the evaluator's definition shape. */
export function toDefinition(row: Rule): RuleDefinition {
  return {
    name: row.name,
    enabled: row.enabled,
    priority: row.priority,
    stopOnMatch: row.stopOnMatch,
    match: row.match as never,
    actions: row.actions as never,
  };
}
