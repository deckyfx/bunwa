/**
 * The address bar, as state.
 *
 * The console had one `useState` in the shell, so a reload dropped whoever was
 * reading a conversation back to the devices table and a link to a screen was
 * impossible to send. The fragment fixes both without the server learning a
 * single section name: `/app#conversations/<id>` is a request for `/app`,
 * because nothing after the `#` leaves the browser.
 *
 * The browser's own history is the source of truth rather than a copy kept
 * beside it. Copies drift — the back button changes the address without going
 * through this store, and a mirror would then be describing the previous
 * screen.
 */
import { create } from "zustand";

import { DEFAULT_ROUTE, formatRoute, parseRoute, sameRoute, type Route } from "../lib/route";
import type { SectionId } from "../components/Sidebar";

interface RouteState {
  route: Route;
  /** Go somewhere, adding a history entry so back returns here. */
  navigate: (section: SectionId, detail?: string | null) => void;
  /** Change the address without adding an entry. For canonicalising. */
  replace: (section: SectionId, detail?: string | null) => void;
  /** Start following the browser's back and forward. Returns an unsubscribe. */
  listen: () => () => void;
}

const readHash = (): Route => {
  try {
    return parseRoute(window.location.hash);
  } catch {
    return DEFAULT_ROUTE;
  }
};

export const useRoute = create<RouteState>((set, get) => ({
  route: readHash(),

  navigate: (section, detail = null) => {
    const next: Route = { section, detail };
    // Nothing to do, and doing it anyway would put a duplicate entry in the
    // history so that back appears not to work.
    if (sameRoute(get().route, next)) return;

    window.location.hash = formatRoute(next);
    // Set optimistically rather than waiting for `hashchange`. The event is
    // asynchronous, and a render between the click and the event would show
    // the old screen — a visible flicker on every navigation.
    set({ route: next });
  },

  replace: (section, detail = null) => {
    const next: Route = { section, detail };
    if (sameRoute(get().route, next)) return;

    try {
      // replaceState, so canonicalising a bare `/app` into `/app#devices` does
      // not leave an entry whose back button appears to do nothing.
      window.history.replaceState(null, "", formatRoute(next));
    } catch {
      window.location.hash = formatRoute(next);
    }
    set({ route: next });
  },

  listen: () => {
    const onChange = () => {
      const next = readHash();
      if (!sameRoute(get().route, next)) set({ route: next });
    };

    window.addEventListener("hashchange", onChange);
    return () => {
      window.removeEventListener("hashchange", onChange);
    };
  },
}));
