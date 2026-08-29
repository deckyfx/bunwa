/**
 * One transient message, shown wherever the operator ends up.
 *
 * Exists because the console navigates as a result of things that happen
 * elsewhere: a device finishes pairing while the claim screen is open, and the
 * screen that answers "what now?" is the device list rather than the one the
 * operator is looking at. Moving them without saying why is worse than not
 * moving them, so the reason travels with the navigation.
 *
 * Cleared when the credential changes, like every other store here. A notice
 * names what it is about — "released +62812… from Beta" — so one left standing
 * across a sign-out would tell the next person to use this console the number
 * and the tenant it belonged to.
 *
 * Deliberately one message rather than a queue. Two notices at once means two
 * things happened and neither was read; the newer one replaces the older
 * because it is the one that describes the screen now in front of the reader.
 */
import { create } from "zustand";

import { blankOnKeyChange } from "./tenant";

export type NoticeTone = "good" | "bad";

interface NoticeState {
  message: string | null;
  tone: NoticeTone;
  show: (message: string, tone?: NoticeTone) => void;
  dismiss: () => void;
}

/**
 * The one pending message, and the store every screen reads it from.
 *
 * Global rather than passed down because the writer and the reader are
 * different screens: the claim page knows the device paired, the device list
 * is where the operator lands, and nothing connects them but this.
 */
export const useNotice = create<NoticeState>((set) => ({
  message: null,
  tone: "good",

  show: (message, tone = "good") => {
    set({ message, tone });
  },

  dismiss: () => {
    set({ message: null });
  },
}));

// See ./tenant. This store holds a sentence about someone else's device, which
// is exactly the kind of thing a new credential must not inherit.
blankOnKeyChange(useNotice, () => ({ message: null, tone: "good" as NoticeTone }));
