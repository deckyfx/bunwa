import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit reads the location directly rather than through src/config/env,
 * because that class validates values this CLI does not need and would fail on
 * a machine that only wants to generate a migration.
 */
const path = process.env["DATABASE_PATH"] ?? "./data/db/bunwa.sqlite";

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "sqlite",
  dbCredentials: { url: path },
  strict: true,
  verbose: true,
} satisfies Config;
