/**
 * The deliveries screen.
 *
 * Written for the race the reviewer found rather than for the rendering: with
 * SSE bumping `revision` in bursts, several requests are in flight at once and
 * whichever resolves last would otherwise win. A typecheck cannot see that, and
 * neither can a test that only asserts the happy path.
 */
import { describe, expect, test, afterEach, mock } from "bun:test";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";

import { Deliveries } from "../Deliveries";
import { api, type Delivery } from "../api";

afterEach(cleanup);

function delivery(id: string, eventType: string): Delivery {
  return {
    id,
    eventId: `evt-${id}`,
    eventType,
    state: "pending",
    attemptCount: 0,
    nextAttemptAt: new Date(0).toISOString(),
    deliveredAt: null,
    createdAt: new Date(0).toISOString(),
  };
}

describe("an older response never replaces a newer one", () => {
  test("a slow first request does not overwrite a fast second", async () => {
    // The exact ordering the guard exists for: revision changes, the first
    // request is still in flight, the second finishes first, and then the
    // first arrives carrying a list that is already out of date.
    let call = 0;
    const original = api.deliveries;
    (api as { deliveries: typeof api.deliveries }).deliveries = async () => {
      call += 1;
      if (call === 1) {
        await Bun.sleep(120);
        return [delivery("old", "stale.event")];
      }
      return [delivery("new", "fresh.event")];
    };

    try {
      const view = render(<Deliveries apiKey="k" revision={0} />);
      // Second request, superseding the first while it is still sleeping.
      view.rerender(<Deliveries apiKey="k" revision={1} />);

      await waitFor(() => expect(screen.getByText("fresh.event")).toBeDefined());

      // Long enough for the slow first response to land and try to commit.
      await Bun.sleep(200);
      expect(screen.getByText("fresh.event")).toBeDefined();
      expect(
        screen.queryByText("stale.event"),
        "an obsolete response overwrote the current list",
      ).toBeNull();
    } finally {
      (api as { deliveries: typeof api.deliveries }).deliveries = original;
    }
  });

  test("an error from a superseded request is not shown", async () => {
    let call = 0;
    const original = api.deliveries;
    (api as { deliveries: typeof api.deliveries }).deliveries = async () => {
      call += 1;
      if (call === 1) {
        await Bun.sleep(120);
        throw new Error("stale failure");
      }
      return [delivery("new", "fresh.event")];
    };

    try {
      const view = render(<Deliveries apiKey="k" revision={0} />);
      view.rerender(<Deliveries apiKey="k" revision={1} />);
      await waitFor(() => expect(screen.getByText("fresh.event")).toBeDefined());

      await Bun.sleep(200);
      expect(
        screen.queryByRole("alert"),
        "an error from an obsolete request reached the screen",
      ).toBeNull();
    } finally {
      (api as { deliveries: typeof api.deliveries }).deliveries = original;
    }
  });
});

describe("a delivery cannot be replayed twice at once", () => {
  test("starting a second row does not re-enable the first", async () => {
    // `replaying` tracked only the most recent id, so clicking replay on a
    // second row re-enabled the first while its request was still in flight.
    // A replay is a webhook the consumer receives again, so a double send is
    // not a cosmetic problem.
    const inFlight = new Map<string, () => void>();
    const originalReplay = api.replay;
    const originalList = api.deliveries;

    (api as { deliveries: typeof api.deliveries }).deliveries = async () => [
      { ...delivery("a", "first.event"), state: "dead" as const },
      { ...delivery("b", "second.event"), state: "dead" as const },
    ];
    (api as { replay: typeof api.replay }).replay = (_key: string, id: string) =>
      // Promise<void>, matching what replay returns. Typed as `unknown` the
      // stub satisfied the signature by being wider than it, so a replay that
      // started resolving with a value would have gone unnoticed here.
      new Promise<void>((resolve) => {
        inFlight.set(id, () => {
          resolve();
        });
      });

    try {
      render(<Deliveries apiKey="k" revision={0} />);
      await waitFor(() => expect(screen.getByText("first.event")).toBeDefined());

      const buttons = screen.getAllByRole("button", { name: "replay" });
      expect(buttons).toHaveLength(2);

      fireEvent.click(buttons[0]!);
      await waitFor(() => expect(inFlight.has("a")).toBe(true));

      fireEvent.click(screen.getAllByRole("button", { name: "replay" })[0]!);
      await waitFor(() => expect(inFlight.has("b")).toBe(true));

      // The first row must still be busy: its request has not resolved.
      const stillBusy = screen.getAllByRole("button", { name: "replaying…" });
      expect(stillBusy.length, "a row was re-enabled while its replay was in flight").toBe(2);
    } finally {
      (api as { replay: typeof api.replay }).replay = originalReplay;
      (api as { deliveries: typeof api.deliveries }).deliveries = originalList;
    }
  });
});

describe("what the row says", () => {
  test("state and attempts appear together", async () => {
    // "pending, 3 attempts" and "pending, 0 attempts" mean opposite things, so
    // the screen must not show one without the other.
    const original = api.deliveries;
    (api as { deliveries: typeof api.deliveries }).deliveries = async () => [
      { ...delivery("d1", "message.undelivered"), state: "pending" as const, attemptCount: 3 },
    ];
    try {
      render(<Deliveries apiKey="k" revision={0} />);
      await waitFor(() => expect(screen.getByText("message.undelivered")).toBeDefined());
      expect(screen.getByText("pending")).toBeDefined();
      expect(screen.getByText("3")).toBeDefined();
    } finally {
      (api as { deliveries: typeof api.deliveries }).deliveries = original;
    }
  });

  test("replay is offered only where it can help", async () => {
    // Replaying a delivered event sends it twice; replaying one still backing
    // off does nothing the worker was not about to do.
    const original = api.deliveries;
    (api as { deliveries: typeof api.deliveries }).deliveries = async () => [
      { ...delivery("a", "pending.one"), state: "pending" as const },
      { ...delivery("b", "dead.one"), state: "dead" as const },
    ];
    try {
      render(<Deliveries apiKey="k" revision={0} />);
      await waitFor(() => expect(screen.getByText("dead.one")).toBeDefined());
      expect(screen.getAllByRole("button", { name: "replay" })).toHaveLength(1);
    } finally {
      (api as { deliveries: typeof api.deliveries }).deliveries = original;
    }
  });
});

void mock;
