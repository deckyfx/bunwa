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

    const { data, error } = await client(apiKey).v1.devices.get();
    if (useSession.getState().apiKey !== apiKey) return;

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
    // the only one this answer belongs to.
    if (useSession.getState().apiKey !== under) {
      set({ busy: false });
      return null;
    }

    if (error !== null || data === null || !("outcome" in data)) {
      set({ busy: false, error: "could not release this number" });
      return null;
    }

    set({ busy: false, error: null });
    await get().load();
    return data as ReleaseOutcome;
  },
}));

// Cleared when the credential changes, so this store never renders one
// tenant's data under another's key while the new key's requests are in
// flight. See ./tenant.
blankOnKeyChange(useDevices, () => ({ devices: null, error: null, busy: false }));
