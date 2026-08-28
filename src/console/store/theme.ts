/**
 * Light, dark, or whatever the machine says.
 *
 * Three states rather than a toggle. A two-way switch has to pick a side the
 * first time it is shown, and picking either means an operator whose whole
 * desktop is dark gets a white console until they notice the control — or the
 * reverse. "System" keeps the answer someone already gave their operating
 * system, and stays correct when they change it.
 *
 * The class on the document is applied by a script in index.html before the
 * first paint; this store only keeps it in step afterwards. Doing it from
 * React alone renders the page light and then flips it, and that flash is
 * worst in exactly the case dark mode exists for.
 */
import { create } from "zustand";

export type Theme = "system" | "light" | "dark";

const STORAGE_KEY = "bunwa.theme";

/** The same key and values the pre-paint script in index.html reads. */
function readStored(): Theme {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value === "light" || value === "dark" ? value : "system";
  } catch {
    // Storage disabled. The console still works; the choice just will not
    // survive a reload.
    return "system";
  }
}

/** Whether the machine is asking for dark. */
function systemPrefersDark(): boolean {
  try {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

/** Put the class where the stylesheet's `dark:` variant looks for it. */
function apply(theme: Theme): void {
  const dark = theme === "dark" || (theme === "system" && systemPrefersDark());
  document.documentElement.classList.toggle("dark", dark);
}

interface ThemeState {
  theme: Theme;
  /** What is actually on screen right now, which "system" alone does not say. */
  resolved: "light" | "dark";
  set: (theme: Theme) => void;
  /** Step to the next choice. One control, three states, no menu. */
  cycle: () => void;
  /** Start following the system preference for changes. Returns an unsubscribe. */
  watchSystem: () => () => void;
}

const resolve = (theme: Theme): "light" | "dark" =>
  theme === "system" ? (systemPrefersDark() ? "dark" : "light") : theme;

const ORDER: Theme[] = ["system", "light", "dark"];

export const useTheme = create<ThemeState>((set, get) => ({
  theme: readStored(),
  resolved: resolve(readStored()),

  set: (theme) => {
    apply(theme);
    try {
      if (theme === "system") localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* the choice still applies, it just will not survive a reload */
    }
    set({ theme, resolved: resolve(theme) });
  },

  cycle: () => {
    const next = ORDER[(ORDER.indexOf(get().theme) + 1) % ORDER.length] ?? "system";
    get().set(next);
  },

  watchSystem: () => {
    let query: MediaQueryList;
    try {
      query = window.matchMedia("(prefers-color-scheme: dark)");
    } catch {
      return () => undefined;
    }

    const onChange = () => {
      // Only while following it. Someone who chose light explicitly did not
      // ask to be moved when their desktop switches at sunset.
      if (get().theme !== "system") return;
      apply("system");
      set({ resolved: resolve("system") });
    };

    query.addEventListener("change", onChange);
    return () => {
      query.removeEventListener("change", onChange);
    };
  },
}));
