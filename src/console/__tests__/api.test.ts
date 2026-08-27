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

afterEach(() => {
  globalThis.fetch = REAL_FETCH;
});

describe("a response with no body", () => {
  test("204 resolves rather than failing to parse", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await api.logoutDevice("k", "otp")).toBeNull();
  });

  test("markChatRead is the same shape and must not reject", async () => {
    globalThis.fetch = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect(await api.markChatRead("k", "t1")).toBeNull();
  });

  test("a real error still becomes an ApiError", async () => {
    // The 204 shortcut must not swallow failures on the way past.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ title: "Nope", detail: "no" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(api.logoutDevice("k", "otp")).rejects.toBeInstanceOf(ApiError);
  });
});
