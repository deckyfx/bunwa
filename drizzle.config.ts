import type { Config } from "drizzle-kit";

/**
 * Drizzle Kit reads DATABASE_URL directly rather than through src/config/env,
 * because the config class validates values this CLI does not need and would
 * fail on a machine that only wants to generate a migration.
 */
const url = process.env["DATABASE_URL"];
if (url === undefined || url.trim() === "") {
  throw new Error("DATABASE_URL is required to generate or apply migrations");
}

export default {
  schema: "./src/db/schema.ts",
  out: "./src/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true,
} satisfies Config;
