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
  /** What a person calls this tenant. The ids are for machines. */
  projectSlug: string;
  projectName: string;
  environmentSlug: string;
  environmentKind: string;
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
  /** Validate whatever key was restored from storage. Called once on mount. */
  hydrate: () => Promise<void>;
  /** The server stopped accepting the key mid-session. */
  invalidate: (reason: string) => void;
  /** Throw away the stored credential without complaining about it. */
  forget: () => void;
}

/**
 * What to say when connecting fails.
 *
 * "that key was not accepted" was said for every failure, including the ones
 * where the server never answered — so an unreachable server, a crash and a
 * genuinely wrong key all told the operator to go and check their key. Only
 * one of those is about the key.
 *
 * The server cannot say *why* a key was refused: revoked, unknown and expired
 * are deliberately indistinguishable to a caller, or probing tells an attacker
 * which guesses were close. So the message points at the log, which is allowed
 * to know and now says so.
 */
function describeFailure(status: unknown): string {
  if (typeof status !== "number" || status === 0) {
    // Eden reports a transport failure with no status at all, which is the
    // case that was previously blamed on the key.
    return "could not reach the server. Is it still running?";
  }

  if (status === 401) {
    return "the server refused that key. It logs the reason — look for \"api key rejected\" in the server output.";
  }
  if (status >= 500) return `the server failed while checking the key (${String(status)}).`;
  return `the server rejected the request (${String(status)}).`;
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
      set({ identity: null, busy: false, error: describeFailure(error.status) });
      return;
    }

    try {
      localStorage.setItem(STORAGE_KEY, trimmed);
    } catch {
      /* the session still works, it just will not survive a refresh */
    }

    set({ identity: data as Identity, busy: false, error: null });
  },

  disconnect: () => {
    void get().connect("");
  },

  /**
   * Check the restored key before anything relies on it.
   *
   * Nothing did this, so a refresh left `apiKey` set and `identity` null: the
   * pages stayed hidden until someone pressed connect again, while everything
   * keyed on the raw key carried on as though the session were live.
   */
  hydrate: async () => {
    const stored = get().apiKey;
    if (stored === "" || get().identity !== null) return;
    await get().connect(stored);
  },

  /**
   * Drop the identity but keep the key on screen.
   *
   * Called when the server rejects a credential that was working. The text is
   * left in the field because the usual cause is the key being revoked or the
   * database being replaced, and retyping it is not the fix — knowing it is no
   * longer accepted is.
   */
  invalidate: (reason: string) => {
    if (get().identity === null) return;
    set({ identity: null, busy: false, error: reason });
  },

  /**
   * Drop a stored key that cannot possibly work.
   *
   * Called when the instance reports it has no keys at all: whatever is in
   * this browser was issued by a database that no longer exists, so presenting
   * it can only produce a 401. It did — twice per load, with an alarming
   * "api key rejected" in the server log while the operator was still reading
   * the setup screen, and an error banner accusing a credential they had not
   * typed.
   *
   * Silent, unlike `invalidate`: there is nothing here for the operator to act
   * on. The key is gone because the instance it belonged to is gone.
   */
  forget: () => {
    if (get().apiKey === "" && get().error === null) return;
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* nothing to clean up */
    }
    set({ apiKey: "", identity: null, error: null, busy: false });
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
