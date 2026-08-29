/**
 * Light, dark, or the machine's choice.
 *
 * The property that matters is that "system" keeps following the system. A
 * switcher that quietly froze the choice at whatever the machine said when the
 * page loaded would look correct all day and be wrong at sunset — and the
 * failure is invisible, because nothing announces that it stopped following.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test";

import { useTheme } from "../store/theme";

/** A controllable stand-in for the media query the store watches. */
let systemDark = false;
let listeners: Array<() => void> = [];

const installMatchMedia = () => {
  listeners = [];
  (window as unknown as { matchMedia: unknown }).matchMedia = (query: string) => ({
    matches: query.includes("dark") && systemDark,
    media: query,
    addEventListener: (_: string, fn: () => void) => listeners.push(fn),
    removeEventListener: (_: string, fn: () => void) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  });
};

/** Flip the machine's preference and tell whoever is listening. */
const setSystemDark = (value: boolean) => {
  systemDark = value;
  for (const fn of [...listeners]) fn();
};

const isDark = () => document.documentElement.classList.contains("dark");

beforeEach(() => {
  systemDark = false;
  installMatchMedia();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  useTheme.setState({ theme: "system", resolved: "light" });
});

afterEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("an explicit choice", () => {
  test("applies immediately", () => {
    useTheme.getState().set("dark");
    expect(isDark()).toBe(true);

    useTheme.getState().set("light");
    expect(isDark()).toBe(false);
  });

  test("survives a reload", () => {
    useTheme.getState().set("dark");
    expect(localStorage.getItem("bunwa.theme")).toBe("dark");
  });

  test("wins over the machine", () => {
    setSystemDark(true);
    useTheme.getState().set("light");
    expect(isDark(), "the operator asked for light on a dark desktop").toBe(false);
  });
});

describe("following the system", () => {
  test("takes the machine's answer", () => {
    setSystemDark(true);
    useTheme.getState().set("system");
    expect(isDark()).toBe(true);
  });

  test("stores nothing, so the machine stays in charge next time", () => {
    // A stored "system" would be read by the pre-paint script as a value to
    // honour rather than an absence to fall through.
    useTheme.getState().set("dark");
    useTheme.getState().set("system");
    expect(localStorage.getItem("bunwa.theme")).toBeNull();
  });

  test("keeps following after the page has loaded", () => {
    // The failure this exists for: a switcher that read the preference once
    // looks right all day and is wrong when the desktop switches at sunset.
    useTheme.getState().set("system");
    const stop = useTheme.getState().watchSystem();

    setSystemDark(true);
    expect(isDark()).toBe(true);

    setSystemDark(false);
    expect(isDark()).toBe(false);
    stop();
  });

  test("stops following once a side is chosen", () => {
    // Someone who chose light did not ask to be moved at sunset.
    const stop = useTheme.getState().watchSystem();
    useTheme.getState().set("light");

    setSystemDark(true);

    expect(isDark()).toBe(false);
    stop();
  });

  test("the watcher can be torn down", () => {
    useTheme.getState().set("system");
    const stop = useTheme.getState().watchSystem();
    stop();

    setSystemDark(true);

    expect(isDark(), "a removed listener must not still be applying changes").toBe(false);
  });
});

describe("the control", () => {
  test("cycles through all three and returns", () => {
    useTheme.setState({ theme: "system" });
    useTheme.getState().cycle();
    expect(useTheme.getState().theme).toBe("light");
    useTheme.getState().cycle();
    expect(useTheme.getState().theme).toBe("dark");
    useTheme.getState().cycle();
    expect(useTheme.getState().theme).toBe("system");
  });

  test("reports what is actually on screen, which 'system' alone does not say", () => {
    setSystemDark(true);
    useTheme.getState().set("system");
    expect(useTheme.getState().resolved).toBe("dark");
  });
});
