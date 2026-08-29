/**
 * Every device on the instance, and who is using it.
 *
 * The operator's view. A project store can only ever show the numbers bound to
 * its own environment; this is the one place the question "who else has this
 * number?" can be answered — and that answer is what makes retiring a device
 * an informed decision rather than a guess.
 */
import { create } from "zustand";

import { client, type RowOf } from "../lib/api";
import { useSession } from "./session";
import { blankOnKeyChange } from "./tenant";

type Api = ReturnType<typeof client>;

/** Derived from the admin route, so a changed response is a compile error. */
export type FleetDevice = RowOf<Awaited<ReturnType<Api["admin"]["v1"]["devices"]["get"]>>>;

interface FleetState {
  devices: FleetDevice[] | null;
  error: string | null;
  busy: boolean;
  load: () => Promise<void>;
  /** Retire a device outright. Always destroys; see the route. */
  retire: (deviceId: string) => Promise<boolean>;
}

const api = () => client(useSession.getState().apiKey);

/**
 * Which load is the current one.
 *
 * Module-level rather than store state: it is bookkeeping about requests, not
 * something a component renders, and putting it in the store would make every
 * load notify subscribers twice.
 */
let loadGeneration = 0;

/**
 * The instance-wide device store, held apart from the per-project one.
 *
 * Two stores rather than one because they answer to different credentials and
 * different questions: `useDevices` shows what a project may see under a tenant
 * key, this one shows every device on the instance under an admin key. Merging
 * them would mean a single cache holding rows from both, and a console that
 * showed one tenant's fleet to another the moment the key changed.
 */
export const useFleet = create<FleetState>((set, get) => ({
  devices: null,
  error: null,
  busy: false,

  load: async () => {
    const under = useSession.getState().apiKey;
    if (under === "") return;

    // Retiring a device reloads, and the page reloads on its own, so two loads
    // overlap readily. Without this the slower one wins by finishing last, and
    // the list settles back to the state from before the retirement.
    const generation = ++loadGeneration;

    const { data, error } = await api().admin.v1.devices.get();
    if (useSession.getState().apiKey !== under) return;
    if (generation !== loadGeneration) return;

    if (error !== null || !Array.isArray(data)) {
      set({ error: "could not load devices", devices: null });
      return;
    }
    set({ devices: data, error: null });
  },

  retire: async (deviceId) => {
    const under = useSession.getState().apiKey;
    if (under === "") return false;

    set({ busy: true, error: null });
    const { error } = await api().admin.v1.devices({ deviceId }).delete();

    // Not `set({ busy: false })`: the key already changed, so
    // blankOnKeyChange has reset this store and a newer operation may already
    // have set busy for itself. Clearing it here would take the spinner off a
    // request that is still in flight.
    if (useSession.getState().apiKey !== under) return false;

    if (error !== null) {
      set({ busy: false, error: "could not retire this device" });
      return false;
    }

    await get().load();

    // Cleared after the reload, not before it. Clearing first re-enabled every
    // button on the page while the list still showed the state the retirement had
    // just changed — the operator could act again on a row that was already
    // gone. `busy` covers the whole operation, which is what the page is asking
    // about when it disables on it.
    //
    // Re-checked here too: the reload is another await, and the credential can
    // change across it. Returning the outcome then would report one tenant's
    // retirement into a console that had already switched to another.
    if (useSession.getState().apiKey !== under) return false;
    set({ busy: false, error: null });
    return true;
  },
}));

// Cleared when the credential changes, like every other store here.
blankOnKeyChange(useFleet, () => ({ devices: null, error: null, busy: false }));
