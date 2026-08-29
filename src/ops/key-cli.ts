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
import {
  BOOTSTRAP_KEY_LABEL,
  DEFAULT_ENVIRONMENT_SLUG,
  DEFAULT_PROJECT_SLUG,
  ensureBootstrap,
} from "./bootstrap";
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
      scopes: apiKeys.scopes,
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

    // Named individually rather than counted: the question this listing gets
    // asked is "why did that screen 403", and a number does not answer it.
    const missing = ALL_SCOPES.filter((scope) => !row.scopes.includes(scope));
    if (missing.length > 0) {
      console.log(`    missing: ${missing.join(", ")}  — run \`bun run key:grant ${row.prefix}\``);
    }
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

/**
 * Bring a key up to the current scope set.
 *
 * A key is granted whatever scopes existed when it was minted, so adding a
 * scope leaves every key already in use short of it — and the symptom is a 403
 * on one screen, which reads as a bug rather than as an upgrade step. Rotating
 * the credential would also work and is a worse answer: it invalidates
 * whatever is already using it to answer a question about a list of strings.
 *
 * Only ever adds. Narrowing a key from here would be a silent revocation of
 * something a caller may depend on; that is what `revoke` is for.
 */
/** Keys this instance mints for its own operator, as opposed to a tenant's. */
const OPERATOR_LABELS = new Set([BOOTSTRAP_KEY_LABEL, "console (setup)"]);

/** The scopes that reach outside a single environment. Named, so a refusal can say why. */
const INSTANCE_WIDE = ALL_SCOPES.filter((s) => s === "manage:instance" || s === "manage:projects");

async function grant(prefix: string, force: boolean): Promise<void> {
  const [row] = await db().select().from(apiKeys).where(eq(apiKeys.keyPrefix, prefix)).limit(1);
  if (row === undefined) {
    console.error(`no key with prefix ${prefix}. Run \`bun run key:list\` to see them.`);
    process.exitCode = 1;
    return;
  }

  // ALL_SCOPES includes manage:instance and manage:projects, which reach past
  // the environment a project key is confined to. Granting them to a tenant's
  // key hands that tenant the instance — the name WhatsApp shows for every
  // other project on this deployment, and the timezone the logs are written
  // in. A mistyped prefix is enough, and nothing about the result is visible
  // afterwards.
  //
  // This command exists to repair the operator's own console key, so that is
  // what it does by default. Escalating anything else has to be said out loud.
  if (!OPERATOR_LABELS.has(row.label) && !force) {
    console.error(`refusing: "${row.label}" is not an operator key.`);
    console.error(`granting every scope would give it ${INSTANCE_WIDE.join(" and ")},`);
    console.error("which reach past the environment a project key is confined to.");
    console.error(`\nIf that is genuinely what you want: bun run key:grant ${prefix} --force`);
    process.exitCode = 1;
    return;
  }

  const missing = ALL_SCOPES.filter((scope) => !row.scopes.includes(scope));
  if (missing.length === 0) {
    console.log(`${prefix} already has every scope.`);
    return;
  }

  await db()
    .update(apiKeys)
    .set({ scopes: [...new Set([...row.scopes, ...ALL_SCOPES])], updatedAt: new Date() })
    .where(eq(apiKeys.id, row.id));

  console.log(`granted to ${prefix} ("${row.label}"): ${missing.join(", ")}`);
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
} else if (command === "grant") {
  if (argument === undefined) {
    console.error("usage: bun run key:grant <prefix> [--force]");
    process.exitCode = 1;
  } else {
    await grant(argument, Bun.argv.includes("--force"));
  }
} else if (command === "revoke") {
  if (argument === undefined) {
    console.error("usage: bun run key:revoke <prefix>");
    process.exitCode = 1;
  } else {
    await revoke(argument);
  }
} else {
  console.error(`unknown command: ${command}. Use list, new, grant, or revoke.`);
  process.exitCode = 1;
}
