/**
 * Who the console is acting as.
 *
 * The API key and what it resolves to. Held here rather than in App's state
 * because four screens need it and passing it down meant every one of them
 * took an `apiKey` prop — which is how a stale key reached a screen that had
 * already been told to use a different one.
 *
 * Persisted to localStorage deliberately: a refresh should not log an operator
 * out mid-investigation. It is a credential, so nothing else about the session
 * is stored beside it.
 */
import { create } from "zustand";

import { client } from "../lib/api";

const STORAGE_KEY = "bunwa.apiKey";

export interface Identity {
  projectId: string;
  environmentId: string;
  scopes: string[];
  /** The zone the server renders timestamps in. See `useServerTimezone`. */
  serverTimezone: string;
}

interface SessionState {
  apiKey: string;
  identity: Identity | null;
  error: string | null;
  busy: boolean;
  /** Bumped by the event stream. Screens watch it to know something changed. */
  revision: number;

  connect: (key: string) => Promise<void>;
  disconnect: () => void;
  bumpRevision: () => void;
}

const readStoredKey = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    // Private browsing, or storage disabled. The console still works; it just
    // asks for the key again next time.
    return "";
  }
};

/**
 * The console's session: the API key, and what the server says it resolves to.
 *
 * A store rather than state in the shell because every screen needs it, and
 * passing it down meant each one took an `apiKey` prop — which is how a stale
 * key reached a screen that had already been told to use a different one. A
 * singleton also outlives any component, so a response landing after an unmount
 * has somewhere valid to check itself against instead of writing into a tree
 * that is gone.
 */
export const useSession = create<SessionState>((set, get) => ({
  apiKey: readStoredKey(),
  identity: null,
  error: null,
  busy: false,
  revision: 0,

  connect: async (key: string) => {
    const trimmed = key.trim();

    if (trimmed === "") {
      // Clearing the key clears everything it authorised. Leaving the identity
      // on screen would show one tenant's context with no credential behind it.
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch {
        /* nothing to clean up */
      }
      set({ apiKey: "", identity: null, error: null, busy: false });
      return;
    }

    set({ apiKey: trimmed, busy: true, error: null, identity: null });

    const { data, error } = await client(trimmed).v1.whoami.get();

    // The store is a singleton, so a slow response can land after the user has
    // moved on. Committing only when the key still matches is the same guard
    // the components used to carry individually, in one place now.
    if (get().apiKey !== trimmed) return;

    if (error !== null) {
      set({ identity: null, busy: false, error: "that key was not accepted" });
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      /* the session still works, it just will not survive a refresh */
    }

    set({ identity: data, busy: false, error: null });
  },

  disconnect: () => {
    void get().connect("");
  },

  bumpRevision: () => {
    set((state) => ({ revision: state.revision + 1 }));
  },
}));

/**
 * The zone to render timestamps in.
 *
 * The server's, not the browser's. A console showing the reader's local time
 * while the logs show Jakarta means two people looking at the same incident
 * read different clocks. UTC is the fallback for the moment before the
 * identity has loaded, and is at least honestly labelled.
 */
export const useServerTimezone = (): string => useSession((s) => s.identity?.serverTimezone ?? "UTC");
