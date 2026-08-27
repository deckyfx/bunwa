/**
 * The claim store.
 *
 * The screen this backs disables its submit button on `busy`, so anything that
 * leaves `busy` set takes the form with it — there is no second control to
 * recover with and no message on screen to say why. That is what the
 * session-change guard did until a review found it.
 */
import { describe, expect, test, beforeEach, mock } from "bun:test";

let claimResolver: () => Promise<unknown> = () => Promise.resolve({ data: {}, error: null });

void mock.module("../lib/api", () => ({
  client: () => ({ v1: { devices: { claim: { post: () => claimResolver() } } } }),
  anonymous: () => ({}),
}));

const { useClaim } = await import("../store/claim");
const { useSession } = await import("../store/session");

const RESET = { msisdn: "", alias: "", result: null, error: null, busy: false };

beforeEach(() => {
  useSession.setState({ apiKey: "key-a", identity: null, error: null, busy: false, revision: 0 });
  useClaim.setState(RESET);
  claimResolver = () => Promise.resolve({ data: {}, error: null });
});

describe("submitting", () => {
  test("a result arrives against the key it was claimed under", async () => {
    claimResolver = () =>
      Promise.resolve({ data: { outcome: "pending_pairing" }, error: null });
    useClaim.setState({ msisdn: "628111", alias: "otp" });

    await useClaim.getState().submit();

    expect(useClaim.getState().result).not.toBeNull();
    expect(useClaim.getState().busy).toBe(false);
  });

  test("nothing is sent without a number and an alias", async () => {
    let called = false;
    claimResolver = () => {
      called = true;
      return Promise.resolve({ data: {}, error: null });
    };
    useClaim.setState({ msisdn: "   ", alias: "otp" });
    await useClaim.getState().submit();
    expect(called).toBe(false);
  });

  test("a refusal clears busy and says so", async () => {
    claimResolver = () => Promise.resolve({ data: null, error: { status: 409 } });
    useClaim.setState({ msisdn: "628111", alias: "otp" });

    await useClaim.getState().submit();

    expect(useClaim.getState().busy).toBe(false);
    expect(useClaim.getState().error).not.toBeNull();
  });
});

describe("a key change while a claim is in flight", () => {
  test("does not report the result under the new key", async () => {
    // Claiming under one key and showing the outcome under another is how a
    // console puts one project's device in front of a different project.
    let release: ((v: unknown) => void) | undefined;
    claimResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    useClaim.setState({ msisdn: "628111", alias: "otp" });

    const inFlight = useClaim.getState().submit();
    useSession.setState({ apiKey: "key-b" });
    release?.({ data: { outcome: "pending_pairing" }, error: null });
    await inFlight;

    expect(useClaim.getState().result, "a stale claim reported under a new key").toBeNull();
  });

  test("leaves the form usable rather than stuck", async () => {
    // The bug this pins: the guard returned without clearing, `busy` stayed
    // true, and the claim button was disabled until a page reload.
    let release: ((v: unknown) => void) | undefined;
    claimResolver = () =>
      new Promise((resolve) => {
        release = resolve;
      });
    useClaim.setState({ msisdn: "628111", alias: "otp" });

    const inFlight = useClaim.getState().submit();
    useSession.setState({ apiKey: "key-b" });
    release?.({ data: { outcome: "pending_pairing" }, error: null });
    await inFlight;

    expect(useClaim.getState().busy, "the claim form was left disabled for ever").toBe(false);
  });
});
