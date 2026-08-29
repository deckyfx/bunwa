/**
 * One transient message, shown wherever the operator ends up.
 *
 * Exists because the console navigates as a result of things that happen
 * elsewhere: a device finishes pairing while the claim screen is open, and the
 * screen that answers "what now?" is the device list rather than the one the
 * operator is looking at. Moving them without saying why is worse than not
 * moving them, so the reason travels with the navigation.
 *
 * Deliberately one message rather than a queue. Two notices at once means two
 * things happened and neither was read; the newer one replaces the older
 * because it is the one that describes the screen now in front of the reader.
 */
import { create } from "zustand";

export type NoticeTone = "good" | "bad";

interface NoticeState {
  message: string | null;
  tone: NoticeTone;
  show: (message: string, tone?: NoticeTone) => void;
  dismiss: () => void;
}

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
