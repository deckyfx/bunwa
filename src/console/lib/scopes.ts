/**
 * The scopes a project key may hold, for the console's own forms.
 *
 * Duplicated from `src/auth/scopes.ts` rather than imported. That module is
 * server-side and importing it would be harmless today — it has no
 * dependencies — but it is the natural place for anything scope-related to
 * grow, and the first such addition that touched configuration would pull the
 * environment reader into the browser bundle. The server validates the list it
 * is sent regardless, so this being stale costs a checkbox, never a bad grant.
 */
export const PROJECT_SCOPE_NAMES = [
  "send:text",
  "send:media",
  "receive:messages",
  "manage:devices",
  "manage:webhook",
  "manage:rules",
] as const;

/**
 * The project every instance has, whether or not anyone asked for it.
 *
 * A key must belong to an environment — the column is NOT NULL with a foreign
 * key — so one has to exist before setup can mint the operator's own
 * credential. That makes it a real row in the projects list, and without
 * saying so it reads as a tenant someone created and forgot.
 */
export const BOOTSTRAP_PROJECT_SLUG = "default";
