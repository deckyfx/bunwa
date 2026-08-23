/**
 * Projects — the tenant root.
 *
 * A project has no parent scope, so unlike every other store here its methods
 * take no tenant id. That makes it the one place where a missing scope is not
 * a bug, and worth stating explicitly so the exception is not read as a
 * precedent by the stores below.
 */
import { eq } from "drizzle-orm";

import { db, type Database } from "../db";
import { projects, type Project } from "../db/schema";
import { ConflictError, NotFoundError, ValidationError } from "./errors";

import { KEY_SAFE_SLUG } from "../auth/api-key";

/**
 * Lowercase, digits and hyphens: safe in a URL, in a key prefix, and in a log.
 *
 * The same constant the key parser uses. Two copies would drift, and the
 * failure mode is silent — keys that mint successfully and then authenticate
 * nothing.
 */
const SLUG_PATTERN = KEY_SAFE_SLUG;

export class ProjectStore {
  /**
   * Create a project.
   *
   * @throws ValidationError if the slug is not URL- and prefix-safe
   * @throws ConflictError if the slug is taken
   */
  static async create(
    input: { slug: string; displayName: string },
    database: Database = db(),
  ): Promise<Project> {
    const slug = input.slug.trim().toLowerCase();
    if (!SLUG_PATTERN.test(slug)) {
      throw new ValidationError(
        "slug must be 3-40 characters of lowercase letters, digits and hyphens, starting and ending alphanumeric",
        "slug",
      );
    }
    const displayName = input.displayName.trim();
    if (displayName === "") throw new ValidationError("displayName is required", "displayName");

    if ((await this.findBySlug(slug, database)) !== null) {
      throw new ConflictError(`a project with slug "${slug}" already exists`, "slug");
    }

    const [created] = await database.insert(projects).values({ slug, displayName }).returning();
    if (created === undefined) throw new Error("insert returned no row");
    return created;
  }

  static async findById(id: string, database: Database = db()): Promise<Project | null> {
    const [found] = await database.select().from(projects).where(eq(projects.id, id)).limit(1);
    return found ?? null;
  }

  static async findBySlug(slug: string, database: Database = db()): Promise<Project | null> {
    const [found] = await database.select().from(projects).where(eq(projects.slug, slug)).limit(1);
    return found ?? null;
  }

  static async list(database: Database = db()): Promise<Project[]> {
    return database.select().from(projects);
  }

  /** @throws NotFoundError */
  static async requireById(id: string, database: Database = db()): Promise<Project> {
    const found = await this.findById(id, database);
    if (found === null) throw new NotFoundError(`project ${id} not found`);
    return found;
  }

  /** Suspending a project must stop its environments serving; see EnvironmentStore. */
  static async setStatus(
    id: string,
    status: "active" | "suspended",
    database: Database = db(),
  ): Promise<Project> {
    const [updated] = await database
      .update(projects)
      .set({ status, updatedAt: new Date() })
      .where(eq(projects.id, id))
      .returning();
    if (updated === undefined) throw new NotFoundError(`project ${id} not found`);
    return updated;
  }
}
