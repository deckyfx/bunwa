/**
 * Instance settings, once a credential exists.
 *
 * Separate from the setup store because it speaks to a different endpoint for
 * a different reason: setup answers before there is a key and closes once
 * there is one, this needs a key and stays open. Sharing state between them
 * would mean one of the two is always reading a value the other's endpoint
 * cannot refresh.
 */
import { create } from "zustand";

import { client } from "../lib/api";
import { useSession } from "./session";
import type { SettingKey, Settings } from "./setup";

interface SettingsState {
  settings: Settings | null;
  busy: boolean;
  error: string | null;
  saved: boolean;

  load: () => Promise<void>;
  save: (values: Partial<Record<SettingKey, string>>) => Promise<void>;
}

/** Whatever the server said, or something honest if it said nothing useful. */
const messageFrom = (error: { value?: unknown } | null): string => {
  const value = error?.value;
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "the server rejected that";
};

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  busy: false,
  error: null,
  saved: false,

  load: async () => {
    const { data, error } = await client(useSession.getState().apiKey).v1.settings.get();
    if (error !== null || data === null) {
      set({ error: "could not load settings" });
      return;
    }
    set({ settings: data as Settings, error: null });
  },

  save: async (values) => {
    set({ busy: true, error: null, saved: false });

    const { data, error } = await client(useSession.getState().apiKey).v1.settings.put(values);

    if (error !== null || data === null) {
      set({ busy: false, error: messageFrom(error) });
      return;
    }

    // Replaced with what the server returned, not with what was typed: the
    // instance name is normalised on write, and showing the unnormalised text
    // back would tell the operator their input was accepted verbatim.
    set({ settings: data as Settings, busy: false, error: null, saved: true });
  },
}));
