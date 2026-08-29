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

/**
 * Whatever the server said, or something honest if it said nothing useful.
 *
 * 403 is called out by name because it has one cause here and a specific fix:
 * these settings are behind `manage:instance`, and a key minted before that
 * scope existed does not have it. "could not load settings" sent an operator
 * looking for a network problem that was not there.
 */
const messageFrom = (error: { status?: unknown; value?: unknown } | null): string => {
  const value = error?.value;
  if (typeof value === "object" && value !== null && "detail" in value) {
    const detail = (value as { detail?: unknown }).detail;
    if (typeof detail === "string") return detail;
  }
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (error?.status === 403) {
    return "this key lacks the manage:instance scope. Grant it with `bun run key:grant <prefix>`, or mint a new key.";
  }
  if (typeof error?.status !== "number") return "could not reach the server";
  return `the server rejected that (${String(error.status)})`;
};

export const useSettings = create<SettingsState>((set) => ({
  settings: null,
  busy: false,
  error: null,
  saved: false,

  load: async () => {
    const { data, error } = await client(useSession.getState().apiKey).admin.v1.settings.get();
    if (error !== null || data === null) {
      set({ error: messageFrom(error) });
      return;
    }
    set({ settings: data as Settings, error: null });
  },

  save: async (values) => {
    set({ busy: true, error: null, saved: false });

    const { data, error } = await client(useSession.getState().apiKey).admin.v1.settings.put(values);

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
