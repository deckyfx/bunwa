/**
 * Addresses.
 *
 * The point of the fragment is that a reload, a bookmark and a pasted link all
 * land on the same screen — and that none of it needs a server route, because
 * nothing after the `#` is ever sent. What is asserted here is mostly the
 * unhappy path: a hand-edited or stale address must land somewhere usable
 * rather than on a blank page, and a detail with a slash or a space in it must
 * survive the round trip.
 */
import { describe, expect, test, beforeEach } from "bun:test";

import { DEFAULT_ROUTE, formatRoute, parseRoute, sameRoute } from "../lib/route";
import { useRoute } from "../store/route";

describe("reading an address", () => {
  test("a bare section", () => {
    expect(parseRoute("#devices")).toEqual({ section: "devices", detail: null });
  });

  test("the URL name, which is not always the internal one", () => {
    // "conversations" reads better than "chats" in something typed by hand.
    expect(parseRoute("#conversations")).toEqual({ section: "chats", detail: null });
  });

  test("a section with a detail", () => {
    expect(parseRoute("#conversations/t-1")).toEqual({ section: "chats", detail: "t-1" });
  });

  test("with or without the hash", () => {
    // `location.hash` includes it; a stored string might not.
    expect(parseRoute("devices")).toEqual(parseRoute("#devices"));
  });

  test("case does not matter", () => {
    expect(parseRoute("#Devices").section).toBe("devices");
  });

  test("an empty address is the default, not a blank screen", () => {
    expect(parseRoute("")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#")).toEqual(DEFAULT_ROUTE);
  });

  test("an unknown section is the default, not an error", () => {
    // A stale bookmark or a typo should land somewhere usable.
    expect(parseRoute("#nonsense")).toEqual(DEFAULT_ROUTE);
    expect(parseRoute("#nonsense/with/detail")).toEqual(DEFAULT_ROUTE);
  });

  test("a trailing slash is not a detail", () => {
    expect(parseRoute("#devices/")).toEqual({ section: "devices", detail: null });
  });

  test("the internal name still works", () => {
    // So an address that predates the friendlier name does not break.
    expect(parseRoute("#chats").section).toBe("chats");
  });
});

describe("writing an address", () => {
  test("uses the URL name", () => {
    expect(formatRoute({ section: "chats", detail: null })).toBe("#conversations");
  });

  test("encodes the detail", () => {
    // A bare one would break the fragment at the first slash or space.
    expect(formatRoute({ section: "chats", detail: "a b/c" })).toBe("#conversations/a%20b%2Fc");
  });

  test("round-trips whatever it produced", () => {
    // The property, not the examples: anything written must read back the same.
    for (const detail of ["t-1", "a b", "a/b", "e2/80/93", "üñî", null]) {
      const route = { section: "chats" as const, detail };
      expect(parseRoute(formatRoute(route)), String(detail)).toEqual(route);
    }
  });
});

describe("the store", () => {
  beforeEach(() => {
    window.location.hash = "";
    useRoute.setState({ route: DEFAULT_ROUTE });
  });

  test("navigating puts it in the address bar", () => {
    useRoute.getState().navigate("chats", "t-1");
    expect(window.location.hash).toBe("#conversations/t-1");
    expect(useRoute.getState().route).toEqual({ section: "chats", detail: "t-1" });
  });

  test("navigating to where you already are does nothing", () => {
    // Otherwise every render that re-navigates adds a history entry, and back
    // appears not to work.
    useRoute.getState().navigate("devices");
    const before = window.history.length;
    useRoute.getState().navigate("devices");
    expect(window.history.length).toBe(before);
  });

  test("a hashchange from the back button is picked up", () => {
    const stop = useRoute.getState().listen();
    useRoute.getState().navigate("chats", "t-1");

    window.location.hash = "#devices";
    window.dispatchEvent(new Event("hashchange"));

    expect(useRoute.getState().route).toEqual({ section: "devices", detail: null });
    stop();
  });

  test("the listener can be torn down", () => {
    const stop = useRoute.getState().listen();
    stop();

    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));

    expect(useRoute.getState().route.section).not.toBe("settings");
  });

  test("state is set without waiting for the event", () => {
    // hashchange is asynchronous. Waiting for it would render the old screen
    // for a frame after every click.
    useRoute.getState().navigate("settings");
    expect(useRoute.getState().route.section).toBe("settings");
  });
});

describe("comparing", () => {
  test("same section and detail", () => {
    expect(sameRoute({ section: "chats", detail: "a" }, { section: "chats", detail: "a" })).toBe(true);
  });

  test("a detail is part of the identity", () => {
    // Otherwise moving between two conversations is not a navigation at all.
    expect(sameRoute({ section: "chats", detail: "a" }, { section: "chats", detail: "b" })).toBe(false);
  });
});
