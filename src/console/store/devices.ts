/**
 * The devices this environment can act through.
 *
 * Same guard as the other stores: a response that lands after the key changed
 * is dropped rather than committed. It is a singleton, so that check cannot
 * live in a component any more — which is the point, because it was written
 * three times and missed once.
 */
import { create } from "zustand";

import { client } from "../lib/api";
import { useSession } from "./session";

type Api = ReturnType<typeof client>;
type Rows<T> = T extends { data: infer D } ? Extract<NonNullable<D>, readonly unknown[]> : never;

/** Derived from the server. The hand-written version had three wrong fields. */
export type VirtualDevice = Rows<Awaited<ReturnType<Api["v1"]["devices"]["get"]>>>[number];

interface DeviceState {
  devices: VirtualDevice[] | null;
  error: string | null;
  load: () => Promise<void>;
}

export const useDevices = create<DeviceState>((set) => ({
  devices: null,
  error: null,

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
}));
