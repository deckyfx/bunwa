/**
 * First-run setup.
 *
 * The one surface that answers before a credential exists, which is exactly
 * what makes it dangerous: an endpoint that mints an API key is worth more to
 * an attacker than any endpoint behind one. Three things keep it honest.
 *
 * It closes permanently. Once a key exists, minting is over: the request still
 * succeeds and still applies settings, but it answers `apiKey: null` rather
 * than a second credential. So the window is between the process starting and
 * the operator finishing, not for as long as the deployment lives. It is not a
 * 409, which this paragraph claimed for a while — an operator whose key came
 * from the environment can still name the instance here, and refusing the whole
 * request would take that away to describe a state they cannot change.
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
import { db } from "../../db";
import { withTransaction } from "../../db/transaction";
import { ensureBootstrap } from "../../ops/bootstrap";
import { EnvironmentStore } from "../../stores/environment-store";
import { ProjectStore } from "../../stores/project-store";
import { slugFromName } from "../../stores/slug";
import { log } from "../../observability/logger";
import {
  SettingsStore,
  SETTING_KEYS,
  type SettingKey,
} from "../../stores/settings-store";
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

/**
 * Setup runs one at a time.
 *
 * Two concurrent POSTs with the same valid token raced in two places at once:
 * both passed the token check either side of an awaited create and each minted
 * an all-scope key — one instance, two credentials granting everything, the
 * operator told about one — and `ensureBootstrap()` ran twice, the loser
 * failing on the row the winner had just inserted and answering 500.
 *
 * Serialising the whole transition fixes both, and gives the second request a
 * truthful answer rather than a manufactured conflict: by the time it runs the
 * instance really is configured, so it takes the already-configured path and
 * reports `apiKey: null`.
 */
let setupChain: Promise<unknown> = Promise.resolve();

function serialised<T>(work: () => Promise<T>): Promise<T> {
  // Chained through both settled paths, so one failed setup does not wedge
  // every later attempt behind a rejected promise.
  const run = setupChain.then(work, work);
  setupChain = run.catch(() => undefined);
  return run;
}

/**
 * Mint a setup token and announce it. Called at boot when unconfigured.
 *
 */
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
    async ({ body, headers, set }) =>
      serialised(async () => {
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
        // Checked in full before anything is written, so a request that is
        // going to be refused does not leave half of itself applied: a valid
        // name persisted beside a rejected timezone, answered 400, and the
        // console showing a value it had been told was not saved.
        const pending: Array<{ key: SettingKey; value: string }> = [];
        for (const key of SETTING_KEYS) {
          const value = body[key];
          if (value === undefined || value.trim() === "") continue;

          if (SettingsStore.resolve(key).source === "environment") {
            // Silently ignoring it would leave the console showing a value the
            // deployment overrides, which is the failure this rule exists to
            // prevent — so say so instead.
            throw new ValidationError(
              `${key} is set in the environment and cannot be changed here`,
              key,
            );
          }
          // Throws on a bad value, before any write has happened.
          pending.push({ key, value: SettingsStore.validate(key, value) });
        }

        // The first project is resolved in the same pass, for the same reason.
        // Validating it after the settings were written meant a name that
        // reduces to no usable slug answered 400 having already persisted the
        // instance name and moved the server clock — half of a request the
        // operator was told had failed.
        //
        // Optional because the two things setup does are independent: the
        // credential is what makes the instance usable, and a project is what
        // makes it useful. An operator who only wants the key can add projects
        // afterwards, and one who names a project here does not have to visit
        // a second screen to get a working tenant.
        let plannedProject: { slug: string; displayName: string } | null = null;
        if (body.projectName !== undefined && body.projectName.trim() !== "") {
          const displayName = body.projectName.trim();
          const supplied = body.projectSlug?.trim();
          const slug = supplied !== undefined && supplied !== "" ? supplied : slugFromName(displayName);

          if (slug === null) {
            throw new ValidationError(
              `"${displayName}" has no usable slug; give one explicitly`,
              "projectSlug",
            );
          }
          plannedProject = { slug, displayName };
        }

        // Everything that touches the database goes in together.
        //
        // Settings were written first and the project created after, so a slug
        // already taken — which only the write can discover — answered 409 with
        // the instance name and timezone already persisted. Creating the
        // project first would only have swapped which half survived. The
        // credential is in here too: minting it outside meant a failure there
        // left a project committed, and the retry the operator was invited to
        // make then collided with the project their first attempt had created.
        //
        // The timezone is applied after the commit, not inside: it is a
        // process-level change, and a rollback cannot take it back.
        const outcome = await withTransaction(db(), async (tx) => {
          const applied: Partial<Record<SettingKey, string>> = {};
          for (const { key, value } of pending) applied[key] = SettingsStore.set(key, value, tx);

          if (state.configured) {
            return { applied, firstProject: null, plaintext: null };
          }

          let firstProject: { id: string; slug: string; displayName: string } | null = null;
          if (plannedProject !== null) {
            const project = await ProjectStore.create(plannedProject, tx);
            await EnvironmentStore.create({ projectId: project.id, slug: "production", kind: "live" }, tx);
            firstProject = { id: project.id, slug: project.slug, displayName: project.displayName };
          }

          // An admin key, not a tenant key that happens to hold every scope.
          //
          // The first credential belongs to whoever is setting the instance up,
          // and what they need is the instance: projects, environments, keys,
          // devices. Minting it into `default/production` made it
          // simultaneously a credential that could send WhatsApp messages as
          // that project, which is a tenant power an operator never asked for.
          //
          // Tenant keys are minted per project afterwards, from the Projects
          // screen, which is where deciding what a project may do belongs.
          const { plaintext } = await ApiKeyStore.createAdmin(
            { label: "console (setup)", scopes: [...ALL_SCOPES] },
            tx,
          );

          return { applied, firstProject, plaintext };
        });

        if (outcome.applied.serverTimezone !== undefined)
          setServerTimezone(outcome.applied.serverTimezone);

        if (state.configured) {
          // The token is spent here too, and that is the whole point of it being
          // single-use. Returning without clearing left it valid after a request
          // that had already used it: an attacker who read it from the log could
          // keep replaying this endpoint to rewrite the instance name and the
          // server timezone, on an instance whose setup was supposedly closed.
          //
          // Not an error for the settings half; only minting is closed.
          clearSetupToken();
          return {
            settings: SettingsStore.all(),
            apiKey: null,
            apiKeySource: state.apiKeySource,
          };
        }

        const firstProject = outcome.firstProject;

        // The window is closed the moment it is used, not when the operator
        // navigates away.
        clearSetupToken();
        log.info("setup completed; the first API key was minted", {
          scopes: ALL_SCOPES.length,
          project: firstProject?.slug ?? null,
        });

        set.status = 201;
        return {
          settings: SettingsStore.all(),
          apiKey: outcome.plaintext,
          apiKeySource: "database" as const,
          project: firstProject,
        };
      }),
    {
      body: t.Object({
        instanceName: t.Optional(t.String({ maxLength: 200 })),
        serverTimezone: t.Optional(t.String({ maxLength: 100 })),
        /** The first project's name. Its slug is derived unless one is given. */
        projectName: t.Optional(t.String({ maxLength: 200 })),
        projectSlug: t.Optional(t.String({ maxLength: 40 })),
      }),
    },
  );

/** Whether the environment supplies the key, for the boot log. */
export const keyComesFromEnvironment = (): boolean => config().apiKey !== null;
