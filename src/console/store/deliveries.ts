/**
 * Webhook deliveries, and replaying the ones that failed.
 *
 * The screen that answers "did our webhook fire, and what did they say" —
 * docs/06 calls that the question a customer eventually asks in anger, and
 * answering it from logs is archaeology.
 */
import { create } from "zustand";

import { client } from "../lib/api";
import { useSession } from "./session";

type Api = ReturnType<typeof client>;
type Rows<T> = T extends { data: infer D } ? Extract<NonNullable<D>, readonly unknown[]> : never;

export type Delivery = Rows<Awaited<ReturnType<Api["v1"]["deliveries"]["get"]>>>[number];

interface DeliveryState {
  deliveries: Delivery[] | null;
  /** Every id currently being replayed, not just the last one clicked. */
  replaying: ReadonlySet<string>;
  error: string | null;

  load: () => Promise<void>;
  replay: (id: string) => Promise<void>;
}

export const useDeliveries = create<DeliveryState>((set, get) => ({
  deliveries: null,
  replaying: new Set(),
  error: null,

  load: async () => {
    const { apiKey } = useSession.getState();
    if (apiKey === "") return;

    const { data, error } = await client(apiKey).v1.deliveries.get();
    if (useSession.getState().apiKey !== apiKey) return;

    if (error !== null || !Array.isArray(data)) {
      set({ error: "could not load deliveries" });
      return;
    }
    set({ deliveries: data, error: null });
  },

  replay: async (id: string) => {
    // Refused rather than queued. A second click on a row already in flight is
    // a duplicate webhook at the far end, not a retry.
    if (get().replaying.has(id)) return;

    const { apiKey } = useSession.getState();
    set((state) => ({ replaying: new Set(state.replaying).add(id) }));

    const { error } = await client(apiKey).v1.deliveries({ id }).replay.post();

    if (error !== null) set({ error: "could not replay" });
    else await get().load();

    set((state) => {
      const next = new Set(state.replaying);
      next.delete(id);
      return { replaying: next };
    });
  },
}));
