/**
 * One control, three states.
 *
 * The icon shows what is in force rather than what pressing will do — a sun
 * when the console is light, a moon when it is dark, a monitor when it is
 * following the machine. That is the opposite convention to the reveal toggle
 * beside it, and deliberately so: a reveal button has two states and no
 * indicator, while this one is the only thing on screen that says which of
 * three modes is active. The label carries the action for anyone who cannot
 * see the icon.
 */
import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme, type Theme } from "../store/theme";

const ICON = { system: Monitor, light: Sun, dark: Moon } as const;

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

const DESCRIBE: Record<Theme, string> = {
  system: "following the system theme",
  light: "light theme",
  dark: "dark theme",
};

export function ThemeToggle({ withLabel = false }: { withLabel?: boolean }) {
  const theme = useTheme((s) => s.theme);
  const cycle = useTheme((s) => s.cycle);

  const Icon = ICON[theme];

  return (
    <button
      type="button"
      onClick={cycle}
      // Both halves: what it is now, and what pressing does. A label of only
      // one of the two leaves a screen reader user either unable to tell the
      // current state or unable to predict the result.
      aria-label={`Theme: ${DESCRIBE[theme]}. Switch to ${DESCRIBE[NEXT[theme]]}.`}
      title={`Theme: ${DESCRIBE[theme]}`}
      className={
        withLabel
          ? "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
          : "grid size-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 dark:hover:bg-slate-800 dark:hover:text-slate-100"
      }
    >
      <Icon aria-hidden size={withLabel ? 15 : 16} />
      {withLabel && <span className="capitalize">{theme}</span>}
    </button>
  );
}
