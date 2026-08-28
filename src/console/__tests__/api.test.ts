/**
 * The fetch wrapper.
 *
 * One case, because it broke two shipped features at once: a 204 has no body,
 * and calling response.json() on an empty one rejects. logoutDevice and
 * markChatRead both return 204, so both reported failure on success.
 */
import { describe, expect, test, afterEach } from "bun:test";

import { api, ApiError } from "../api";

const REAL_FETCH = globalThis.fetch;

/**
 * A stand-in for `fetch` that still satisfies its type.
 *
 * Bun's `typeof fetch` carries a `preconnect` method, so a bare
 * `async () => Response` does not satisfy it and the assignments below needed a
 * cast through `unknown` — which would also have accepted a stub returning the
 * wrong thing entirely. Borrowing the real `preconnect` keeps the contract
 * checked while replacing only the call being tested.
 */
const stubFetch = (respond: () => Promise<Response>): typeof fetch =>
  Object.assign(respond, { preconnect: REAL_FETCH.preconnect });

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe("a response with no body", () => {
  test("204 resolves rather than failing to parse", async () => {
    globalThis.fetch = stubFetch(async () => new Response(null, { status: 204 }));
    expect(await api.logoutDevice("k", "otp")).toBeNull();
  });

  test("markChatRead is the same shape and must not reject", async () => {
    globalThis.fetch = stubFetch(async () => new Response(null, { status: 204 }));
    expect(await api.markChatRead("k", "t1")).toBeNull();
  });

  test("a real error still becomes an ApiError", async () => {
    // The 204 shortcut must not swallow failures on the way past.
    globalThis.fetch = stubFetch(
      async () =>
        new Response(JSON.stringify({ title: "Nope", detail: "no" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    );

    await expect(api.logoutDevice("k", "otp")).rejects.toBeInstanceOf(ApiError);
  });
});
