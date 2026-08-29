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

export const useFleet = create<FleetState>((set, get) => ({
  devices: null,
  error: null,
  busy: false,

  load: async () => {
    const under = useSession.getState().apiKey;
    if (under === "") return;

    const { data, error } = await api().admin.v1.devices.get();
    if (useSession.getState().apiKey !== under) return;

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

    if (useSession.getState().apiKey !== under) {
      set({ busy: false });
      return false;
    }

    if (error !== null) {
      set({ busy: false, error: "could not retire this device" });
      return false;
    }

    set({ busy: false, error: null });
    await get().load();
    return true;
  },
}));

// Cleared when the credential changes, like every other store here.
blankOnKeyChange(useFleet, () => ({ devices: null, error: null, busy: false }));
