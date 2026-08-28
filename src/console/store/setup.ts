/**
 * Whether this instance has been set up, and the settings that describe it.
 *
 * Kept apart from the session store because it answers a question that comes
 * before a credential exists: the session store asks "who is this key?", this
 * one asks "is there a key at all?". Conflating them is what made a purged
 * database look identical to a wrong password.
 */
import { create } from "zustand";

import { anonymous } from "../lib/api";

export type SettingKey = "instanceName" | "serverTimezone";
export type SettingSource = "environment" | "database" | "default";

export interface SettingValue {
  value: string;
  source: SettingSource;
}

export type Settings = Record<SettingKey, SettingValue>;

interface SetupState {
  /** Null until the first status call answers; the console shows nothing until then. */
  configured: boolean | null;
  canMintKey: boolean;
  apiKeySource: "environment" | "database" | "none";
  settings: Settings | null;
  busy: boolean;
  error: string | null;
  /** The minted key, shown once. Held in memory only — never persisted. */
  mintedKey: string | null;

  refresh: () => Promise<void>;
  submit: (token: string, values: Partial<Record<SettingKey, string>>) => Promise<void>;
  dismissKey: () => void;
}

/** Turn whatever the server said into something worth putting on screen. */
const messageFrom = (error: { status?: number; value?: unknown }): string => {
  const value = error.value;
  if (typeof value === "object" && value !== null && "message" in value) {
    const message = (value as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  if (error.status === 401) return "that setup token was not accepted";
  return "the server rejected that";
};

export const useSetup = create<SetupState>((set) => ({
  configured: null,
  canMintKey: false,
  apiKeySource: "none",
  settings: null,
  busy: false,
  error: null,
  mintedKey: null,

  refresh: async () => {
    const { data, error } = await anonymous().setup.status.get();

    if (error !== null || data === null) {
      // Left as null rather than guessed. Assuming "configured" would hide the
      // setup screen on a fresh instance; assuming "not configured" would show
      // it to someone who is merely offline.
      set({ error: "could not reach the server" });
      return;
    }

    set({
      configured: data.configured,
      canMintKey: data.canMintKey,
      apiKeySource: data.apiKeySource,
      settings: data.settings as Settings,
      error: null,
    });
  },

  submit: async (token, values) => {
    set({ busy: true, error: null });

    const { data, error } = await anonymous().setup.post(values, {
      headers: { "x-setup-token": token.trim() },
    });

    if (error !== null || data === null) {
      set({ busy: false, error: messageFrom(error ?? {}) });
      return;
    }

    set({
      busy: false,
      error: null,
      settings: data.settings as Settings,
      apiKeySource: data.apiKeySource,
      // Only after a successful submit, and only in memory. Writing it to
      // storage would leave a credential somewhere nobody remembers putting it.
      mintedKey: data.apiKey,
      configured: true,
      canMintKey: false,
    });
  },

  dismissKey: () => {
    set({ mintedKey: null });
  },
}));
