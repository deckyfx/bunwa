/**
 * The devices this environment can act through.
 *
 * Same guard as the other stores: a response that lands after the key changed
 * is dropped rather than committed. It is a singleton, so that check cannot
 * live in a component any more — which is the point, because it was written
 * three times and missed once.
 */
import { create } from "zustand";

import { client, type RowOf } from "../lib/api";
import { useSession } from "./session";
import { blankOnKeyChange } from "./tenant";

type Api = ReturnType<typeof client>;

/** Derived from the server. The hand-written version had three wrong fields. */
export type VirtualDevice = RowOf<Awaited<ReturnType<Api["v1"]["devices"]["get"]>>>;

/** What releasing a number turned out to mean. */
export type ReleaseOutcome = { outcome: "released"; stillHeldBy: number } | { outcome: "retired" };

interface DeviceState {
  devices: VirtualDevice[] | null;
  error: string | null;
  busy: boolean;
  load: () => Promise<void>;
  /**
   * Let this project go of a number.
   *
   * Returns what happened rather than just succeeding, because the two
   * outcomes are not equally reversible: unsubscribing can be undone by
   * claiming again, and retiring destroyed the credentials.
   */
  release: (ref: string) => Promise<ReleaseOutcome | null>;
}

/**
 * The devices this environment can act through.
 *
 * A cache scoped to the credential that filled it. Every screen needs the list
 * and each used to fetch its own, so a late response could commit under a key
 * that had since changed — showing one tenant's numbers to another. One store
 * means that check is written once, and `blankOnKeyChange` below empties it
 * the moment the credential moves rather than leaving it to be overwritten.
 */
/**
 * Which load is the current one. See the note in ./fleet, which does the same.
 *
 * Module-level rather than store state: it is bookkeeping about requests, not
 * something a component renders.
 */
let loadGeneration = 0;

/**
 * The devices one project can see, under a tenant key.
 *
 * The tenant counterpart to `useFleet`, and separate from it for the same
 * reason the routes are: this store's rows are what a project is entitled to
 * know about its own numbers, and none of them say who else holds one.
 */
export const useDevices = create<DeviceState>((set, get) => ({
  devices: null,
  error: null,
  busy: false,

  load: async () => {
    const { apiKey } = useSession.getState();
    if (apiKey === "") {
      set({ devices: null });
      return;
    }

    // Releasing reloads, and the page reloads on its own, so two loads overlap
    // readily. Without this the slower one wins by finishing last, and the list
    // settles back to the state from before the release.
    const generation = ++loadGeneration;

    const { data, error } = await client(apiKey).v1.devices.get();
    if (useSession.getState().apiKey !== apiKey) return;
    if (generation !== loadGeneration) return;

    if (error !== null || !Array.isArray(data)) {
      set({ error: "could not load devices" });
      return;
    }
    set({ devices: data, error: null });
  },

  release: async (ref) => {
    const under = useSession.getState().apiKey;
    if (under === "") return null;

    set({ busy: true, error: null });
    const { data, error } = await client(under).v1.devices({ ref }).delete();

    // Same rule as everywhere else in this store: the credential that asked is
    // the only one this answer belongs to. Not `set({ busy: false })` — the key
    // already changed, so blankOnKeyChange has reset this store and a newer
    // operation may already have set busy for itself. Clearing it here would
    // take the spinner off a request that is still in flight.
    if (useSession.getState().apiKey !== under) return null;

    if (error !== null || data === null || !("outcome" in data)) {
      set({ busy: false, error: "could not release this number" });
      return null;
    }

    const outcome = data as ReleaseOutcome;
    await get().load();

    // Cleared after the reload, not before it. Clearing first re-enabled every
    // button on the page while the list still showed the state the release had
    // just changed — the operator could act again on a row that was already
    // gone. `busy` covers the whole operation, which is what the page is asking
    // about when it disables on it.
    //
    // Re-checked here too: the reload is another await, and the credential can
    // change across it. Returning the outcome then would report one tenant's
    // release into a console that had already switched to another.
    if (useSession.getState().apiKey !== under) return null;
    set({ busy: false, error: null });
    return outcome;
  },
}));

// Cleared when the credential changes, so this store never renders one
// tenant's data under another's key while the new key's requests are in
// flight. See ./tenant.
blankOnKeyChange(useDevices, () => ({ devices: null, error: null, busy: false }));
