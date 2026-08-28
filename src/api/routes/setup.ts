/**
 * First-run setup.
 *
 * The one surface that answers before a credential exists, which is exactly
 * what makes it dangerous: an endpoint that mints an API key is worth more to
 * an attacker than any endpoint behind one. Three things keep it honest.
 *
 * It closes permanently. Once a key exists, minting returns 409 — so the
 * window is between the process starting and the operator finishing, not for
 * as long as the deployment lives.
 *
 * It requires a token printed to the log at startup. Racing the operator is
 * otherwise a real attack on a public deployment: whoever reaches it first
 * gets an all-scope credential. Reading the token means already being able to
 * read the logs, which is a level of access that has already won.
 *
 * It reports status without the token, because a console that cannot tell
 * "not set up" from "wrong key" shows the wrong screen — and knowing an
 * instance is unconfigured is not worth protecting when the fix is to
 * configure it.
 */
import { Elysia, t } from "elysia";

import { ALL_SCOPES } from "../../auth/scopes";
import { ApiKeyStore } from "../../stores/api-key-store";
import { config } from "../../config/env";
import { ensureBootstrap } from "../../ops/bootstrap";
import { log } from "../../observability/logger";
import { SettingsStore, SETTING_KEYS, type SettingKey } from "../../stores/settings-store";
import { setServerTimezone } from "../../time/format";
import { ValidationError } from "../../stores/errors";

/**
 * The token that authorises minting the first key.
 *
 * Regenerated every start: a token that survived a restart would outlive the
 * log line that announced it, and an operator who scrolled past would have no
 * way to get a fresh one short of guessing that restarting works.
 */
let setupToken: string | null = null;

/** Mint a setup token and announce it. Called at boot when unconfigured. */
export function issueSetupToken(): string {
  setupToken = crypto.randomUUID().replace(/-/g, "");
  return setupToken;
}

/** Forget the token. Called once setup completes, and by tests. */
export function clearSetupToken(): void {
  setupToken = null;
}

/** Constant-time comparison, so the token cannot be discovered a byte at a time. */
function tokenMatches(presented: string): boolean {
  if (setupToken === null) return false;
  const a = Buffer.from(presented);
  const b = Buffer.from(setupToken);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/** Header the setup token is presented in. */
export const SETUP_TOKEN_HEADER = "x-setup-token";

export const setupRoutes = new Elysia({ prefix: "/setup" })
  /**
   * What the console needs to decide which screen to show.
   *
   * Unauthenticated on purpose — see the module comment. It reveals whether
   * the instance is configured and which settings are locked by the
   * environment, and nothing that helps configure it.
   */
  .get("/status", async () => {
    const state = await ensureBootstrap();
    return {
      configured: state.configured,
      apiKeySource: state.apiKeySource,
      /** True while the setup screen can still mint a key. */
      canMintKey: !state.configured,
      settings: SettingsStore.all(),
    };
  })

  /**
   * Finish setup: record the settings, and mint a key if one is needed.
   *
   * The key is in the response body and nowhere else, ever. It is not logged —
   * logging a credential is how one ends up in a shipped log bundle.
   */
  .post(
    "/",
    async ({ body, headers, set }) => {
      const state = await ensureBootstrap();

      if (!tokenMatches(headers[SETUP_TOKEN_HEADER] ?? "")) {
        set.status = 401;
        return {
          error: "setup-token-required",
          message: `Present the setup token from the server log in the ${SETUP_TOKEN_HEADER} header.`,
        };
      }

      // Settings are accepted whether or not a key is minted, so an operator
      // whose key came from the environment can still name the instance.
      const applied: Partial<Record<SettingKey, string>> = {};
      for (const key of SETTING_KEYS) {
        const value = body[key];
        if (value === undefined || value.trim() === "") continue;

        if (SettingsStore.resolve(key).source === "environment") {
          // Silently ignoring it would leave the console showing a value the
          // deployment overrides, which is the failure this rule exists to
          // prevent — so say so instead.
          throw new ValidationError(`${key} is set in the environment and cannot be changed here`, key);
        }
        applied[key] = SettingsStore.set(key, value);
      }

      if (applied.serverTimezone !== undefined) setServerTimezone(applied.serverTimezone);

      if (state.configured) {
        // Not an error for the settings half; only minting is closed.
        return { settings: SettingsStore.all(), apiKey: null, apiKeySource: state.apiKeySource };
      }

      if (state.environmentId === null || state.projectId === null) {
        throw new Error("bootstrap did not produce an environment to mint against");
      }

      const { plaintext } = await ApiKeyStore.create({
        projectId: state.projectId,
        environmentId: state.environmentId,
        label: "console (setup)",
        scopes: [...ALL_SCOPES],
      });

      // The window is closed the moment it is used, not when the operator
      // navigates away.
      clearSetupToken();
      log.info("setup completed; the first API key was minted", {
        environmentId: state.environmentId,
        scopes: ALL_SCOPES.length,
      });

      set.status = 201;
      return { settings: SettingsStore.all(), apiKey: plaintext, apiKeySource: "database" as const };
    },
    {
      body: t.Object({
        instanceName: t.Optional(t.String({ maxLength: 200 })),
        serverTimezone: t.Optional(t.String({ maxLength: 100 })),
      }),
    },
  );

/** Whether the environment supplies the key, for the boot log. */
export const keyComesFromEnvironment = (): boolean => config().apiKey !== null;
