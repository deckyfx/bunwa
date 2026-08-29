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

import { LIMITS, consume, type Limit } from "../ops/rate-limit";
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
      // The reason is logged by the resolver, which is the only place that
      // knows it. This adds the path, which the resolver does not have.
      log.warn("api key rejected", { path });
      throw new AuthError(401, "invalid-credential", "Unauthorized", "the API key is not valid", path);
    }

    // The backstop LIMITS.request describes itself as covering "everything
    // else, per key" — and had no call site at all, so every route outside
    // send and claim was unlimited. A limit that exists only as a constant
    // reads in review as though it protects something.
    //
    // Applied after resolution, not before: an unauthenticated caller must not
    // be able to spend a real key's budget by guessing at its id.
    requireWithinLimit(`key:${resolved.apiKey.id}`, LIMITS.request, path);

    // Ordered after the limit, not before. touch() issues an UPDATE, so a
    // caller being refused was still writing on every attempt — the same fault
    // just fixed inside consume(), reintroduced one line above it by the commit
    // that added this backstop. A refused request should cost no writes at all.
    ApiKeyStore.touch(resolved.apiKey.id, resolved.level === "tenant" ? resolved.environmentId : null);

    // An admin key is refused here rather than given an empty tenant.
    //
    // Every route behind this middleware acts inside one environment and reads
    // it straight off `auth`. Letting an admin key through with nulls would
    // push that question into ~37 call sites; refusing it keeps the contract
    // this middleware has always had — if you are past this line, you have a
    // tenant — and admin routes use `requireAdminKey` instead.
    if (resolved.level !== "tenant") {
      throw new AuthError(
        403,
        "tenant-key-required",
        "Forbidden",
        "this endpoint acts inside a project; present a tenant API key rather than an admin key",
        path,
      );
    }

    const auth: AuthContext = {
      projectId: resolved.projectId,
      environmentId: resolved.environmentId,
      scopes: resolved.scopes,
      apiKeyId: resolved.apiKey.id,
    };
    return { auth };
  });

/**
 * What an admin key resolves to. No tenant, because it has none.
 *
 * Deliberately not `AuthContext` with nullable fields: the two are different
 * kinds of caller and a handler should not be able to reach for a project id
 * that was never going to be there.
 */
export interface AdminAuthContext {
  scopes: string[];
  apiKeyId: string;
}

/**
 * Authenticate an instance-level caller.
 *
 * The mirror of `requireApiKey`: same credential path, opposite conclusion. A
 * tenant key is refused rather than accepted-and-scope-checked, because the
 * question "may this key act on the instance?" is answered by what the key is,
 * before any scope is consulted. A tenant key that somehow carried
 * `manage:projects` still must not reach these routes.
 */
export const requireAdminKey = new Elysia({ name: "requireAdminKey" })
  .derive({ as: "scoped" }, async ({ request, set, path }) => {
    const supplied = tenantFromRequest(request.headers);
    if (supplied !== null) {
      set.status = 400;
      throw new AuthError(
        400,
        "tenant-not-accepted",
        "Tenant may not be specified",
        `${supplied} is not accepted; an admin key acts on the instance`,
        path,
      );
    }

    const presented = request.headers.get(API_KEY_HEADER);
    if (presented === null || presented.trim() === "") {
      throw new AuthError(401, "missing-credential", "Unauthorized", `${API_KEY_HEADER} header is required`, path);
    }

    const resolved = await ApiKeyStore.resolve(presented);
    if (resolved === null) {
      log.warn("api key rejected", { path });
      throw new AuthError(401, "invalid-credential", "Unauthorized", "the API key is not valid", path);
    }

    requireWithinLimit(`key:${resolved.apiKey.id}`, LIMITS.request, path);
    ApiKeyStore.touch(resolved.apiKey.id, resolved.level === "tenant" ? resolved.environmentId : null);

    if (resolved.level !== "admin") {
      throw new AuthError(
        403,
        "admin-key-required",
        "Forbidden",
        "this endpoint acts on the instance; present an admin API key",
        path,
      );
    }

    const admin: AdminAuthContext = { scopes: resolved.scopes, apiKeyId: resolved.apiKey.id };
    return { admin };
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
    /** Extra response headers, e.g. Retry-After on a 429. */
    readonly headers?: Record<string, string>,
  ) {
    super(detail);
  }
}

/**
 * Assert a limit has room, and consume one unit if it does.
 *
 * Sits beside requireScope because it is the same kind of gate: a precondition
 * checked per operation, throwing the same error type so the HTTP layer needs
 * no special case.
 *
 * The subject is passed explicitly rather than derived from `auth`, because the
 * thing being protected differs by operation — a send is limited per *device*,
 * since the damage lands on that phone number, while a claim is limited per
 * environment.
 */
export function requireWithinLimit(subject: string, limit: Limit, instance?: string): void {
  const decision = consume(subject, limit);
  if (decision.allowed) return;

  const retryAfter = Math.max(1, Math.ceil((decision.resetAt.getTime() - Date.now()) / 1000));
  throw new AuthError(
    429,
    "rate-limited",
    "Too many requests",
    `limit of ${limit.max} per ${Math.round(limit.windowMs / 1000)}s exceeded; retry in ${retryAfter}s`,
    instance,
    { "retry-after": String(retryAfter) },
  );
}

/**
 * Assert the authenticated key carries a scope.
 *
 * Scopes are checked per operation rather than per route group: a route that
 * grows a second capability should need a second check, not inherit one.
 */
export function requireScope(auth: { scopes: string[] }, scope: string, instance?: string): void {
  if (!auth.scopes.includes(scope)) {
    throw new AuthError(403, "insufficient-scope", "Forbidden", `this API key lacks the "${scope}" scope`, instance);
  }
}
