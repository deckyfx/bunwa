/**
 * The console shell.
 *
 * The test here is for retry: clearing project state before applying a new key
 * is right, but with an unchanged key `setKey` is a no-op, so nothing re-ran
 * and the console sat blank. That is the failure mode of the previous fix, not
 * of the original code.
 */
import { describe, expect, test, afterEach } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import { App } from "../App";
import { api } from "../api";

const REAL = { whoami: api.whoami, devices: api.devices, deliveries: api.deliveries };
const REAL_GLOBALS = {
  fetch: globalThis.fetch,
  EventSource: (globalThis as { EventSource?: unknown }).EventSource,
};

/** Never connects, so the stream cannot race the assertions. */
class SilentEventSource {
  addEventListener(): void {}
  close(): void {}
}

afterEach(() => {
  cleanup();
  Object.assign(api, REAL);
  globalThis.fetch = REAL_GLOBALS.fetch;
  (globalThis as { EventSource?: unknown }).EventSource = REAL_GLOBALS.EventSource;
  try {
    localStorage.clear();
  } catch {
    /* not available in every environment */
  }
});

function connectWith(key: string) {
  fireEvent.change(screen.getByLabelText("API key"), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "connect" }));
}

describe("retry with the same key", () => {
  test("submitting an unchanged key reloads rather than blanking the console", async () => {
    (globalThis as { EventSource?: unknown }).EventSource = SilentEventSource;
    globalThis.fetch = (async () => new Promise<Response>(() => undefined)) as unknown as typeof fetch;

    let whoamiCalls = 0;
    (api as { whoami: typeof api.whoami }).whoami = async () => {
      whoamiCalls += 1;
      if (whoamiCalls === 1) throw new Error("transient");
      return { projectId: "proj-1", environmentId: "env-1", scopes: ["send:text"] };
    };
    (api as { devices: typeof api.devices }).devices = async () => [];
    (api as { deliveries: typeof api.deliveries }).deliveries = async () => [];

    render(<App />);

    // First attempt fails.
    connectWith("same-key");
    await waitFor(() => expect(screen.getByRole("alert")).toBeDefined());

    // Same key again: this is the retry that used to do nothing.
    connectWith("same-key");
    await waitFor(() => expect(screen.getByText("proj-1 / env-1")).toBeDefined());
    expect(whoamiCalls, "resubmitting the same key did not reload").toBeGreaterThan(1);
  });
});
