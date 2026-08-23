/**
 * The HTTP side of delivery.
 *
 * Kept apart from the queue so the queue can be tested without a network and
 * this can be tested without a database.
 */
import { lookup } from "node:dns/promises";

import { isAddressAllowed, validateWebhookTarget } from "./target";
import { sign, SIGNATURE_HEADER } from "./signature";
import { log } from "../observability/logger";

/** How long a single attempt may take before it is abandoned. */
export const ATTEMPT_TIMEOUT_MS = 10_000;

export interface SendOutcome {
  ok: boolean;
  statusCode: number | null;
  error: string | null;
  durationMs: number;
}

/** Resolves a hostname to addresses. Injected so tests need no network. */
export type LookupFn = (hostname: string) => Promise<Array<{ address: string }>>;

export interface SendOptions {
  allowInsecure?: boolean;
  /** Injected in tests so no real socket is opened. */
  fetchImpl?: typeof fetch;
  /**
   * Injected in tests so no real DNS query is made.
   *
   * Injectable rather than skipped under a flag: the resolve-then-pin check is
   * a security control, and a test suite that disables it would be asserting
   * against a different code path than production runs.
   */
  lookupImpl?: LookupFn;
  now?: Date;
}

/**
 * Deliver one payload.
 *
 * Any 2xx is success. Everything else — including a 3xx, which for a webhook
 * means the target is misconfigured rather than moved — is a failure to retry.
 */
export async function send(
  target: string,
  body: string,
  secret: string,
  options: SendOptions = {},
): Promise<SendOutcome> {
  const began = performance.now();
  const doFetch = options.fetchImpl ?? fetch;

  try {
    const url = validateWebhookTarget(target, { ...(options.allowInsecure === undefined ? {} : { allowInsecure: options.allowInsecure }) });

    // Resolve and check before connecting. validateWebhookTarget covers literal
    // addresses; a hostname can still resolve into a blocked range, either by
    // misconfiguration or deliberately.
    //
    // KNOWN GAP — this narrows the DNS rebinding window, it does not close it.
    // Closing it needs the connection bound to the address we validated while
    // Host and TLS SNI keep the original hostname, and Bun's fetch has no such
    // option in 1.4 (`tls`, `unix`, `proxy`, `verbose` only); Bun.dns exposes
    // just `lookup`. A resolver that answers with a public address here and a
    // private one microseconds later would still be followed.
    //
    // What is done instead: resolve immediately before the request so the
    // window is as small as possible, and refuse if *any* returned address is
    // blocked rather than only the first. Closing it properly means a
    // hand-rolled HTTP client over Bun.connect, which is a large amount of
    // security-critical code to own — tracked rather than attempted here.
    if (options.allowInsecure !== true) {
      const resolve: LookupFn =
        options.lookupImpl ?? ((hostname) => lookup(hostname, { all: true }));
      const resolved = await resolve(url.hostname);
      if (resolved.length === 0) {
        return { ok: false, statusCode: null, error: "target did not resolve", durationMs: elapsed(began) };
      }
      const blocked = resolved.find((entry) => !isAddressAllowed(entry.address));
      if (blocked !== undefined) {
        // Logged as a warning rather than an error: a tenant pointing a webhook
        // at a private address is a configuration mistake, and possibly a probe.
        log.warn("webhook target resolved to a blocked address", { host: url.hostname });
        return {
          ok: false,
          statusCode: null,
          error: "target resolved to a private or loopback address",
          durationMs: elapsed(began),
        };
      }
    }

    const response = await doFetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "user-agent": "bunwa/1",
        [SIGNATURE_HEADER]: sign(body, secret, options.now),
      },
      body,
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
      redirect: "manual",
    });

    return {
      ok: response.status >= 200 && response.status < 300,
      statusCode: response.status,
      error: null,
      durationMs: elapsed(began),
    };
  } catch (err) {
    return {
      ok: false,
      statusCode: null,
      error: err instanceof Error ? err.message : String(err),
      durationMs: elapsed(began),
    };
  }
}

function elapsed(from: number): number {
  return Math.round(performance.now() - from);
}
