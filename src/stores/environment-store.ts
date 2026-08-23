/**
 * Environments — the unit of configuration, and the unit of isolation.
 *
 * Every method that reaches an environment takes the project id that must own
 * it. Passing an id alone would let a caller who learned an environment id from
 * anywhere read or mutate another tenant's configuration; with SQLite there is
 * no row-level security behind this, so the predicate here is the only guard
 * (see docs/adr/0005).
 */
import { and, eq } from "drizzle-orm";

import { db, type Database } from "../db";
import { environments, projects, type Environment } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export class EnvironmentStore {
  /**
   * Create an environment within a project.
   *
   * @throws NotFoundError if the project does not exist
   * @throws ConflictError if the slug is taken within that project
   */
  static async create(
    input: { projectId: string; slug: string; kind?: "live" | "test" },
    database: Database = db(),
  ): Promise<Environment> {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new ValidationError(
        "slug must be 3-40 characters of lowercase letters, digits and hyphens",
        "slug",
      );
    }

    const [project] = await database.select().from(projects).where(eq(projects.id, input.projectId)).limit(1);
    if (project === undefined) throw new NotFoundError(`project ${input.projectId} not found`);

    if ((await this.findBySlug(input.projectId, slug, database)) !== null) {
      throw new ConflictError(`project "${project.slug}" already has an environment "${slug}"`, "slug");
    }

    const [created] = await database
      .insert(environments)
      .values({ projectId: input.projectId, slug, kind: input.kind ?? "test" })
      .returning();
    if (created === undefined) throw new Error("insert returned no row");
    return created;
  }

  /** Scoped by project: an id alone is never enough to reach an environment. */
  static async findById(projectId: string, id: string, database: Database = db()): Promise<Environment | null> {
    const [found] = await database
      .select()
      .from(environments)
      .where(and(eq(environments.id, id), eq(environments.projectId, projectId)))
      .limit(1);
    return found ?? null;
  }

  static async findBySlug(projectId: string, slug: string, database: Database = db()): Promise<Environment | null> {
    const [found] = await database
      .select()
      .from(environments)
      .where(and(eq(environments.projectId, projectId), eq(environments.slug, slug)))
      .limit(1);
    return found ?? null;
  }

  static async listForProject(projectId: string, database: Database = db()): Promise<Environment[]> {
    return database.select().from(environments).where(eq(environments.projectId, projectId));
  }

  /** @throws NotFoundError — indistinguishable from "belongs to another project", deliberately. */
  static async requireById(projectId: string, id: string, database: Database = db()): Promise<Environment> {
    const found = await this.findById(projectId, id, database);
    if (found === null) throw new NotFoundError(`environment ${id} not found`);
    return found;
  }

  /**
   * Whether this environment may serve traffic right now.
   *
   * Checks the project too: suspending a project must stop its environments,
   * and a check that looked only at the environment row would let a suspended
   * tenant keep sending.
   */
  static async isServable(id: string, database: Database = db()): Promise<boolean> {
    const [row] = await database
      .select({ envStatus: environments.status, projectStatus: projects.status })
      .from(environments)
      .innerJoin(projects, eq(environments.projectId, projects.id))
      .where(eq(environments.id, id))
      .limit(1);
    return row !== undefined && row.envStatus === "active" && row.projectStatus === "active";
  }

  static async setSettings(
    projectId: string,
    id: string,
    settings: Record<string, unknown>,
    database: Database = db(),
  ): Promise<Environment> {
    await this.requireById(projectId, id, database);
    const [updated] = await database
      .update(environments)
      .set({ settings, updatedAt: new Date() })
      .where(and(eq(environments.id, id), eq(environments.projectId, projectId)))
      .returning();
    if (updated === undefined) throw new NotFoundError(`environment ${id} not found`);
    return updated;
  }
}
