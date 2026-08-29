/**
 * What a key is allowed to do.
 *
 * Scopes were free-form strings checked at five call sites with no list
 * anywhere, so nothing could answer "what may a key be granted?" — which is
 * the question both the setup flow and the admin API have to answer to mint
 * one. Listing them here does not change enforcement; it gives the grant side
 * the same vocabulary the check side already uses.
 */
export const ALL_SCOPES = [
  "send:text",
  "send:media",
  "receive:messages",
  "manage:devices",
  "manage:webhook",
  "manage:rules",
  /**
   * The instance itself, not a tenant's slice of it.
   *
   * Every other scope here bounds what a key may do *within its own
   * environment*. This one does not: the settings it guards are the name
   * WhatsApp shows this deployment under Linked Devices and the timezone the
   * server renders every timestamp in, both of which are one per process and
   * shared by every project on it.
   *
   * It exists because those settings were reachable with `manage:devices` — a
   * scope an ordinary project key is expected to hold — which let any tenant
   * rename the instance for all the others and change the zone the logs are
   * written in. Separating it means granting it is a deliberate act rather
   * than a side effect of being able to claim a number.
   *
   * It is in ALL_SCOPES because the console's own key is minted with the full
   * set and is the thing that has to reach these screens. A key minted for a
   * tenant should not be given this one.
   */
  "manage:instance",
  /**
   * Projects, environments, and the keys that reach them.
   *
   * The instance operator's scope, and the boundary this whole model turns on:
   * a key holding it can see and create *other tenants*, which is the one
   * thing no project key may ever do. It guards /admin/v1, which until now was
   * guarded by nothing at all — an environment flag decided whether the
   * surface existed, and once it existed anyone who could reach the port could
   * create a project and mint a credential for it.
   *
   * A project key must never be granted this. `key:new` mints with the full
   * set because that key is the operator's; project keys are minted through
   * the admin API with a narrower list.
   */
  "manage:projects",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];

/** Whether a string is a scope this build enforces. */
export const isScope = (value: string): value is Scope => (ALL_SCOPES as readonly string[]).includes(value);

/**
 * Scopes that bound a key within its own environment.
 *
 * The only ones the admin API may grant. A project key is created through that
 * API, so if it could hand out the instance scopes below, the boundary they
 * establish would have a door in it: an operator creating a tenant could —
 * accidentally, by passing a string — issue a credential able to create
 * further tenants and rename the deployment.
 */
export const PROJECT_SCOPES = [
  "send:text",
  "send:media",
  "receive:messages",
  "manage:devices",
  "manage:webhook",
  "manage:rules",
] as const satisfies readonly Scope[];

/**
 * Scopes that act on the whole deployment rather than one tenant.
 *
 * Granted only by minting an operator key — `bun run key:new`, or the setup
 * screen — never through an API a tenant's own credential can reach.
 */
export const INSTANCE_SCOPES = ["manage:instance", "manage:projects"] as const satisfies readonly Scope[];

/** Whether a scope is one the admin API may put on a project key. */
export const isProjectScope = (value: string): boolean => (PROJECT_SCOPES as readonly string[]).includes(value);
