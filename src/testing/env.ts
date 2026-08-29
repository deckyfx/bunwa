/**
 * Environment variables in tests, restored rather than deleted.
 *
 * `bun test` runs every file in one process — verified: a `delete Bun.env[k]`
 * in one file is observable as `undefined` in the next. Cleanup that deletes
 * the keys a test set therefore does not restore the environment, it strips
 * it: any value the runner or the developer's shell supplied is gone for every
 * file that runs afterwards.
 *
 * Seventeen test files did exactly that. Nothing has failed because of it yet,
 * which is the usual shape of this kind of fault — it needs one CI runner that
 * sets NODE_ENV, and then the failure appears somewhere unrelated to the test
 * that caused it.
 */

/**
 * Snapshot `keys`, returning the function that puts them back.
 *
 * Exists because bun test shares one process across every test file, so a
 * fixture that deletes the keys it set does not restore the environment — it
 * strips it for each file that runs afterwards, and the resulting failure
 * appears somewhere unrelated to the fixture that caused it. Seventeen files
 * did exactly that before this helper.
 *
 * A key absent before is deleted on restore, not set to the empty string, so
 * "was not set" and "was set to nothing" stay distinguishable.
 */
export function captureEnv(keys: readonly string[]): () => void {
  const saved = new Map<string, string | undefined>();
  for (const key of keys) saved.set(key, Bun.env[key]);

  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete Bun.env[key];
      else Bun.env[key] = value;
    }
  };
}

/** The four a test fixture almost always sets. */
export const FIXTURE_ENV_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "RUNTIME_DIR",
  "DATABASE_PATH",
  // Leaked out of one fixture and broke a dozen unrelated tests in another
  // file: config() refuses ADMIN_API_ENABLED in production, so a suite that
  // sets NODE_ENV=production inherited a ConfigError and logged nothing, and
  // every assertion about a log line failed somewhere it was never set.
  // Bun shares one process across test files, so an env key one fixture writes
  // is an env key every later fixture has.
  "ADMIN_API_ENABLED",
  // Same hazard, and worse: a leaked API_KEY makes every later fixture come up
  // already configured, so a test asserting a blank instance sees a credential
  // it never created.
  "API_KEY",
] as const;
