/**
 * Disconnect classification.
 *
 * The highest-consequence logic in the port and the hardest to notice being
 * wrong, because every branch "works": it just reconnects when it should stop,
 * or stops when it should reconnect. The first strands a paired device for
 * ever; the second hammers WhatsApp with credentials it has already rejected,
 * which is how a number gets restricted.
 *
 * Codes are asserted by number, verified against the pinned 7.0.0-rc14, so an
 * upstream renumbering fails here rather than silently changing behaviour.
 * The version is named because that is the whole value of the reference — an
 * earlier draft said 6.7.24, which the project no longer uses.
 */
import { describe, expect, test } from "bun:test";

import { classifyDisconnect } from "../socket";

describe("a disconnect that must not be retried", () => {
  test("logged out: the credentials are void", () => {
    // Reconnecting with unlinked credentials cannot succeed, and repeating it
    // looks like an attack rather than a bug.
    expect(classifyDisconnect(401)).toEqual({ reason: "logged_out", recoverable: false });
  });

  test("forbidden: the account is blocked", () => {
    // Retrying a block is the worst available response.
    expect(classifyDisconnect(403)).toEqual({ reason: "logged_out", recoverable: false });
  });

  test("replaced: another client holds the session", () => {
    // Baileys' 440 is the condition that makes gowa exit its whole process
    // (ADR-0003). Reconnecting fights the other client for the slot.
    expect(classifyDisconnect(440)).toEqual({ reason: "replaced", recoverable: false });
  });

  test("bad session: the stored credentials are corrupt", () => {
    expect(classifyDisconnect(500)).toEqual({ reason: "bad_session", recoverable: false });
  });

  test("multidevice mismatch: the phone must re-link", () => {
    expect(classifyDisconnect(411)).toEqual({ reason: "bad_session", recoverable: false });
  });
});

describe("a disconnect that must be retried", () => {
  test("restart required is expected, not a failure", () => {
    // Baileys asks for exactly one reconnect after pairing completes. A caller
    // that treats 515 as an error never finishes pairing at all — the device
    // sits in `pairing` for ever having actually succeeded.
    expect(classifyDisconnect(515)).toEqual({ reason: "restart_required", recoverable: true });
  });

  test("timeouts and closes are transient", () => {
    for (const code of [408, 428, 503]) {
      expect(classifyDisconnect(code), `code ${String(code)}`).toEqual({
        reason: "transient",
        recoverable: true,
      });
    }
  });

  test("an unknown code is treated as transient", () => {
    // Deliberate: an unfamiliar code that is actually transient must not
    // strand a working device. The cases with teeth are enumerated above, so
    // the default is the safe direction to be wrong in.
    expect(classifyDisconnect(9999)).toEqual({ reason: "transient", recoverable: true });
    expect(classifyDisconnect(undefined)).toEqual({ reason: "transient", recoverable: true });
  });
});

describe("the two directions are not confused", () => {
  test("every non-recoverable reason is one a human must resolve", () => {
    // A guard against the tempting simplification of making everything
    // recoverable: each of these needs a person, and retrying makes each worse.
    for (const code of [401, 403, 440, 500, 411]) {
      expect(classifyDisconnect(code).recoverable, `code ${String(code)}`).toBe(false);
    }
  });
});
