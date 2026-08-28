/**
 * Mint an API key from the command line.
 *
 * The setup screen shows a key once and cannot show it again — which is the
 * right behaviour for a credential and leaves exactly one gap: an operator who
 * closed the tab has no way back into their own instance. The admin API can
 * mint one, but only if you already know a project and environment id, which
 * is a thing you look up in the database you have been locked out of.
 *
 * Anyone who can run this can already read the database, so it adds no
 * authority that was not already there.
 *
 * Existing keys are left alone. Minting is additive and revocable; deleting
 * someone else's credential because they asked for a new one is not.
 */
import { and, eq } from "drizzle-orm";

import { ALL_SCOPES } from "../auth/scopes";
import { ApiKeyStore } from "../stores/api-key-store";
import { apiKeys, environments, projects } from "../db/schema";
import { db } from "../db";
import { DEFAULT_ENVIRONMENT_SLUG, DEFAULT_PROJECT_SLUG, ensureBootstrap } from "./bootstrap";
import { formatDateTime } from "../time/format";
import { MigrationManager } from "../db/migration-manager";

/** List what exists, so "why is my key refused" has an answer before minting. */
async function list(): Promise<void> {
  const rows = await db()
    .select({
      prefix: apiKeys.keyPrefix,
      label: apiKeys.label,
      revokedAt: apiKeys.revokedAt,
      expiresAt: apiKeys.expiresAt,
      createdAt: apiKeys.createdAt,
      project: projects.slug,
      environment: environments.slug,
      kind: environments.kind,
    })
    .from(apiKeys)
    .innerJoin(environments, eq(apiKeys.environmentId, environments.id))
    .innerJoin(projects, eq(environments.projectId, projects.id));

  if (rows.length === 0) {
    console.log("no api keys exist. Run `bun run key:new` to mint one.");
    return;
  }

  console.log(`${String(rows.length)} key(s):\n`);
  for (const row of rows) {
    const state = row.revokedAt !== null ? "REVOKED" : row.expiresAt !== null && row.expiresAt < new Date() ? "EXPIRED" : "active";
    console.log(`  ${row.prefix}…`);
    console.log(`    ${state}  ${row.project}/${row.environment} (${row.kind})  "${row.label}"  ${formatDateTime(row.createdAt)}`);
  }
  // The prefix is the whole point of the listing: it is stored in the clear
  // precisely so a key in hand can be matched against a row without either
  // being revealed.
  console.log("\nCompare the start of your key against a prefix above.");
}

/** Mint one for the single-instance environment. */
async function mint(label: string): Promise<void> {
  const state = await ensureBootstrap();
  if (state.projectId === null || state.environmentId === null) {
    throw new Error("no default project or environment; is the database migrated?");
  }

  const { plaintext } = await ApiKeyStore.create({
    projectId: state.projectId,
    environmentId: state.environmentId,
    label,
    scopes: [...ALL_SCOPES],
  });

  console.log("\n  " + plaintext + "\n");
  console.log("This is the only time it will be shown. Existing keys are untouched;");
  console.log("revoke one with `bun run key:revoke <prefix>` when you no longer need it.\n");
}

/** Revoke by prefix, which is what the listing shows and what a log line names. */
async function revoke(prefix: string): Promise<void> {
  const [row] = await db().select().from(apiKeys).where(eq(apiKeys.keyPrefix, prefix)).limit(1);
  if (row === undefined) {
    console.error(`no key with prefix ${prefix}. Run \`bun run key:list\` to see them.`);
    process.exitCode = 1;
    return;
  }

  await db().update(apiKeys).set({ revokedAt: new Date(), updatedAt: new Date() }).where(eq(apiKeys.id, row.id));
  console.log(`revoked ${prefix} ("${row.label}")`);
}

/** Which environment the default project resolves to, for the listing header. */
async function describeInstance(): Promise<string> {
  const [row] = await db()
    .select({ kind: environments.kind })
    .from(environments)
    .innerJoin(projects, eq(environments.projectId, projects.id))
    .where(and(eq(projects.slug, DEFAULT_PROJECT_SLUG), eq(environments.slug, DEFAULT_ENVIRONMENT_SLUG)))
    .limit(1);
  return row?.kind ?? "unknown";
}

const [command = "list", argument] = Bun.argv.slice(2);

// Migrations first: this is often the first thing run against a fresh
// database, and failing on a missing table would be a worse answer than
// creating it.
await MigrationManager.runMigrations(db());

if (command === "list") {
  console.log(`instance: ${DEFAULT_PROJECT_SLUG}/${DEFAULT_ENVIRONMENT_SLUG} (${await describeInstance()})\n`);
  await list();
} else if (command === "new") {
  await mint(argument ?? "cli");
} else if (command === "revoke") {
  if (argument === undefined) {
    console.error("usage: bun run key:revoke <prefix>");
    process.exitCode = 1;
  } else {
    await revoke(argument);
  }
} else {
  console.error(`unknown command: ${command}. Use list, new, or revoke.`);
  process.exitCode = 1;
}
