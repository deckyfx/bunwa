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
import { blankOnKeyChange } from "./tenant";

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
    // Before the row is marked, not after: an empty key cannot replay anything,
    // and marking first left the row disabled while reporting a failure that
    // was really "nobody is signed in".
    if (apiKey === "") return;

    set((state) => ({ replaying: new Set(state.replaying).add(id) }));

    try {
      const { error } = await client(apiKey).v1.deliveries({ id }).replay.post();

      // A replay authorised by one credential must not report under another.
      // `load` and the error below both paint a screen that may by now belong
      // to a different project — the same guard `load` itself already carries.
      if (useSession.getState().apiKey !== apiKey) return;

      if (error !== null) set({ error: "could not replay" });
      else await get().load();
    } finally {
      // In a finally, because the guard above returns early. Clearing this
      // only on the paths that reach the end left the row marked as replaying
      // for ever whenever the session changed mid-request — a permanently
      // disabled button, which is the same fault as a composer that never
      // re-enables.
      set((state) => {
        const next = new Set(state.replaying);
        next.delete(id);
        return { replaying: next };
      });
    }
  },
}));

// Cleared when the credential changes, so this store never renders one
// tenant's data under another's key while the new key's requests are in
// flight. See ./tenant.
blankOnKeyChange(useDeliveries, () => ({ deliveries: null, replaying: new Set<string>(), error: null }));
