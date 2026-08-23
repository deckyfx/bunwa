/**
 * Authentication for the project-facing API.
 *
 * The tenant is *derived* from the credential and never read from the request.
 * That is the whole design: with no project or environment id accepted from a
 * body, query or header, a handler cannot be tricked into acting on someone
 * else's data, and cross-tenant access is structurally impossible rather than a
 * check somebody has to remember.
 */
import { Elysia } from "elysia";

import { ApiKeyStore, type ResolvedKey } from "../stores/api-key-store";
import { log } from "../observability/logger";

/** What an authenticated handler is given. Nothing here came from the caller. */
export interface AuthContext {
  projectId: string;
  environmentId: string;
  scopes: string[];
  apiKeyId: string;
}

/** Header the key is presented in. */
export const API_KEY_HEADER = "x-api-key";

/**
 * Reject any attempt to name a tenant in the request.
 *
 * A handler that ignored these would be safe, but their presence means someone
 * expected them to work — and the next handler might oblige. Failing loudly is
 * cheaper than discovering the assumption later.
 */
const TENANT_HEADERS = ["x-project-id", "x-environment-id", "x-tenant-id"];

export function tenantFromRequest(headers: Headers): string | null {
  for (const name of TENANT_HEADERS) {
    if (headers.get(name) !== null) return name;
  }
  return null;
}

/**
 * Elysia plugin providing `auth` to every route that mounts it.
 *
 * Returns 401 rather than 403 for an unusable key: revoked, expired, unknown
 * and malformed are deliberately indistinguishable, so probing cannot tell a
 * real key that was turned off from one that never existed.
 */
export const requireApiKey = new Elysia({ name: "requireApiKey" })
  .derive({ as: "scoped" }, async ({ request, set, path }) => {
    const supplied = tenantFromRequest(request.headers);
    if (supplied !== null) {
      set.status = 400;
      throw new AuthError(
        400,
        "tenant-not-accepted",
        "Tenant may not be specified",
        `${supplied} is not accepted; the tenant is derived from the API key`,
        path,
      );
    }

    const presented = request.headers.get(API_KEY_HEADER);
    if (presented === null || presented.trim() === "") {
      throw new AuthError(401, "missing-credential", "Unauthorized", `${API_KEY_HEADER} header is required`, path);
    }

    const resolved: ResolvedKey | null = await ApiKeyStore.resolve(presented);
    if (resolved === null) {
      // The key itself is never logged, not even a prefix: a log aggregator is
      // a lower-trust store than the database the hash lives in.
      log.warn("api key rejected", { path });
      throw new AuthError(401, "invalid-credential", "Unauthorized", "the API key is not valid", path);
    }

    ApiKeyStore.touch(resolved.apiKey.id);

    const auth: AuthContext = {
      projectId: resolved.projectId,
      environmentId: resolved.environmentId,
      scopes: resolved.scopes,
      apiKeyId: resolved.apiKey.id,
    };
    return { auth };
  });

/** Carries an HTTP status so the error handler can render it without guessing. */
export class AuthError extends Error {
  override readonly name = "AuthError";
  constructor(
    readonly status: number,
    readonly type: string,
    readonly title: string,
    readonly detail: string,
    readonly instance?: string,
  ) {
    super(detail);
  }
}

/**
 * Assert the authenticated key carries a scope.
 *
 * Scopes are checked per operation rather than per route group: a route that
 * grows a second capability should need a second check, not inherit one.
 */
export function requireScope(auth: AuthContext, scope: string, instance?: string): void {
  if (!auth.scopes.includes(scope)) {
    throw new AuthError(403, "insufficient-scope", "Forbidden", `this API key lacks the "${scope}" scope`, instance);
  }
}
