/**
 * Claiming a number.
 *
 * The screen this backs carried three separate guards — a generation counter,
 * a ref to the current key, and an unmount cleanup — each added after a
 * reviewer found the case it covers. All three were doing the same job:
 * refusing to commit a result that arrived after the thing it described had
 * changed.
 *
 * In a store there is one place to ask that question, and no unmount case at
 * all: the store outlives the component, so a late result finds the current
 * state rather than a captured copy of it.
 */
import { create } from "zustand";

import { client } from "../lib/api";
import { useSession } from "./session";
import { blankOnKeyChange } from "./tenant";

type Api = ReturnType<typeof client>;
type Payload<T> = T extends { data: infer D } ? NonNullable<D> : never;

/** Derived from the route, so a changed response shape is a compile error. */
export type ClaimResult = Payload<Awaited<ReturnType<Api["v1"]["devices"]["claim"]["post"]>>>;

interface ClaimState {
  msisdn: string;
  alias: string;
  result: ClaimResult | null;
  error: string | null;
  busy: boolean;

  setMsisdn: (value: string) => void;
  setAlias: (value: string) => void;
  submit: () => Promise<void>;
  reset: () => void;
}

/**
 * Which submission is the current one.
 *
 * The stale-key branch below clears `busy` rather than returning bare, because
 * a bare return left the claim button disabled for ever. That fix has its own
 * hazard: key A's claim finishing *after* the operator switched to B and
 * started a new claim would clear B's `busy` too, re-enabling the form while
 * B's request is still in flight — and a second submission is a second device
 * claim, not a retry.
 *
 * So the key check answers "may this result be shown?" and the generation
 * answers "is this still the submission the form is waiting on?". They are
 * different questions and the earlier version conflated them.
 */
let submitGeneration = 0;

export const useClaim = create<ClaimState>((set, get) => ({
  msisdn: "",
  alias: "",
  result: null,
  error: null,
  busy: false,

  setMsisdn: (value) => {
    set({ msisdn: value });
  },
  setAlias: (value) => {
    set({ alias: value });
  },

  submit: async () => {
    const { msisdn, alias } = get();
    const { apiKey } = useSession.getState();
    if (apiKey === "" || msisdn.trim() === "" || alias.trim() === "") return;

    const mine = ++submitGeneration;
    set({ busy: true, error: null, result: null });

    const { data, error } = await client(apiKey).v1.devices.claim.post({
      msisdn: msisdn.trim(),
      alias: alias.trim(),
    });

    // Dropped if the session moved on. Claiming under one key and reporting
    // the result under another is how a console shows one project's device to
    // a different project.
    //
    // Cleared, not just returned from. A bare return left `busy` true for
    // ever, and the claim button is disabled on `busy` — so switching keys
    // while a claim was in flight killed the form until a page reload, with
    // nothing on screen to say why.
    // Superseded submissions write nothing at all — not even to clear `busy`,
    // which belongs to whichever submission the form is waiting on now.
    if (submitGeneration !== mine) return;

    if (useSession.getState().apiKey !== apiKey) {
      set({ busy: false, result: null, error: null });
      return;
    }

    if (error !== null) {
      set({ busy: false, error: "the claim was refused" });
      return;
    }

    set({ result: data, busy: false, error: null });
    // The device list is now stale — the caller refreshes it.
    useSession.getState().bumpRevision();
  },

  reset: () => {
    // Invalidates anything in flight as well as clearing the form: a claim
    // that lands after a reset must not repopulate the fields it just cleared.
    submitGeneration += 1;
    set({ msisdn: "", alias: "", result: null, error: null, busy: false });
  },
}));

// Cleared when the credential changes, so this store never renders one
// tenant's data under another's key while the new key's requests are in
// flight. See ./tenant.
blankOnKeyChange(useClaim, () => {
  // The generation moves too. Clearing the visible state is not enough: sign
  // out and back in with the same key while a claim is in flight and both
  // guards in `submit` still pass — same generation, same key — so the old
  // response repopulates the form that was just cleared.
  submitGeneration += 1;
  return { msisdn: "", alias: "", result: null, error: null, busy: false };
});
