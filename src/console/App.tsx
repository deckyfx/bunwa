/**
 * The console shell.
 *
 * Holds the ribbon, the left panel and whichever section is showing. It holds
 * no request state of its own — that lives in the stores, because four screens
 * needed the same guards and each had written its own.
 *
 * Three shapes, and choosing between them is the shell's only real decision:
 * setup for an instance with no credential, a centred connect card for one
 * that has a credential nobody has presented yet, and the full console once
 * the server has accepted one.
 */
import { useEffect, useState } from "react";
import { KeyRound, LoaderCircle, LogIn, LogOut, MessageCircleMore, Wifi, WifiOff } from "lucide-react";

import { Card } from "./components/Card";
import { Field } from "./components/Field";
import { Sidebar, sectionsFor, type SectionId } from "./components/Sidebar";
import { ThemeToggle } from "./components/ThemeToggle";
import { ChatsPage } from "./pages/ChatsPage";
import { ClaimPage } from "./pages/ClaimPage";
import { DeliveriesPage } from "./pages/DeliveriesPage";
import { DevicesPage } from "./pages/DevicesPage";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { useEventStream } from "./hooks/useEventStream";
import { useNotice } from "./store/notice";
import { useSession } from "./store/session";
import { useRoute } from "./store/route";
import { useSetup } from "./store/setup";
import { useTheme } from "./store/theme";

/**
 * The event stream's state as a shape.
 *
 * `live` is deliberately the quiet one. A connected stream is the normal case
 * and should not draw the eye; the two that matter are `connecting`, which
 * spins so a wait looks like a wait, and `stale`, which is the console
 * admitting that what is on screen may be out of date.
 */
function StreamIcon({ state }: { state: ReturnType<typeof useEventStream> }) {
  if (state === "live") return <Wifi aria-hidden size={12} className="text-emerald-600" />;
  if (state === "connecting")
    return <LoaderCircle aria-hidden size={12} className="animate-spin text-amber-600" />;
  return <WifiOff aria-hidden size={12} className="text-rose-600" />;
}

/** The selected section. One at a time, so each gets the whole page. */
function Section({ id }: { id: SectionId }) {
  if (id === "devices") return <DevicesPage />;
  if (id === "chats") return <ChatsPage />;
  if (id === "claim") return <ClaimPage />;
  if (id === "deliveries") return <DeliveriesPage />;
  if (id === "projects") return <ProjectsPage />;
  return <SettingsPage />;
}

export function App() {
  const { apiKey, identity, error, busy, hydrated, connect, hydrate, forget, disconnect } = useSession();
  const configured = useSetup((s) => s.configured);
  const mintedKey = useSetup((s) => s.mintedKey);
  const refreshSetup = useSetup((s) => s.refresh);
  const watchSystem = useTheme((s) => s.watchSystem);
  const stream = useEventStream();
  const notice = useNotice((s) => s.message);
  const noticeTone = useNotice((s) => s.tone);
  const dismissNotice = useNotice((s) => s.dismiss);

  const [draft, setDraft] = useState(apiKey);

  /**
   * Sign out, and empty the box the key was typed into.
   *
   * `disconnect` clears the session; the draft is component state and outlived
   * it, so the connect form came back pre-filled with the credential that had
   * just been signed out of — and the reveal control would show it in plain
   * text to whoever was standing there. Signing out has to mean the key is
   * gone from the screen as well as from the store.
   */
  const signOut = () => {
    setDraft("");
    disconnect();
  };
  // Whether what is in the box came from storage rather than from typing. A
  // prefilled masked field is the case where "is this the right key?" cannot
  // be answered by looking, so the field says where it came from.
  //
  // Latched from the store rather than read once at first render. `hydrate`
  // proves a stored key and `forget` drops one that the instance can no longer
  // have issued, and both happen after this component mounts — so a snapshot
  // taken on render claimed "restored from this browser" beside a box the
  // store had since emptied, which is a hint pointing at a credential that is
  // not there.
  const [restored, setRestored] = useState(false);

  useEffect(() => {
    // The store owns the key; the box mirrors it whenever it changes from
    // outside. Typing does not come through here — it moves `draft` alone —
    // so this cannot fight the operator mid-edit.
    setDraft(apiKey);
    setRestored(apiKey !== "");
  }, [apiKey]);
  const route = useRoute((s) => s.route);
  const navigate = useRoute((s) => s.navigate);
  const replace = useRoute((s) => s.replace);
  const listenToHistory = useRoute((s) => s.listen);

  // Asked before anything else, because "this instance has no key" and "your
  // key is wrong" need different screens and look identical from here.
  useEffect(() => {
    void refreshSetup();
  }, [refreshSetup]);

  /*
   * A key restored from storage is unverified until the server says otherwise
   * — but only worth presenting once we know the instance has keys at all.
   *
   * Hydrating unconditionally meant a fresh instance spent its first second
   * offering a credential from a database that no longer existed: two 401s,
   * two "api key rejected" warnings in the server log, and an error banner
   * accusing a key the operator had never typed, all while the setup screen
   * was still loading. When the instance reports no keys, the stored one is
   * provably dead, so it is dropped rather than tried.
   */
  useEffect(() => {
    if (configured === null) return;
    if (configured) void hydrate();
    else forget();
  }, [configured, hydrate, forget]);

  // Only takes effect while the choice is "system"; the store decides that.
  useEffect(() => watchSystem(), [watchSystem]);

  // Back and forward move between sections, because they are addresses now.
  useEffect(() => listenToHistory(), [listenToHistory]);


  const signedIn = identity !== null;

  /*
   * Whether the console still has a question outstanding about itself.
   *
   * Two of them: whether this instance has been set up at all, and whether the
   * key restored from storage is any good. Neither is answered on the first
   * render, and the sign-in form was shown in the meantime — so reopening a
   * tab flashed an empty key field before the console appeared, which reads as
   * having been signed out.
   *
   * A brief wait is the honest thing to show, because a brief wait is what is
   * happening.
   */
  const checking = !signedIn && (configured === null || (apiKey !== "" && !hydrated));

  /*
   * An address naming a section this key cannot use goes somewhere it can.
   *
   * The sidebar hides those sections, but the address bar is not the sidebar:
   * a project key following a link an operator sent, or reloading after its
   * scopes were narrowed, would otherwise render a screen whose every request
   * answers 403 — an empty page full of errors instead of the console it does
   * have access to.
   *
   * Replace, not navigate: the address it arrived with is not somewhere to go
   * back to.
   */
  useEffect(() => {
    if (identity === null) return;
    const allowed = sectionsFor(identity.level, identity.scopes);
    if (allowed.some((section) => section.id === route.section)) return;

    const fallback = allowed[0];
    if (fallback !== undefined) replace(fallback.id, null);
  }, [identity, route.section, replace]);

  // Canonicalise a bare /app once there is something to look at, so the
  // address in the bar is one that can be copied. Replace rather than push:
  // arriving at /app should not leave an entry whose back button does nothing.
  useEffect(() => {
    if (signedIn && window.location.hash === "") replace(route.section, route.detail);
  }, [signedIn, replace, route.section, route.detail]);

  return (
    <div className="flex min-h-screen flex-col bg-slate-50 dark:bg-slate-950">
      {/* Sticky, because the stream indicator and the identity are the two
          things worth being able to check without scrolling — the question
          "is this still live?" comes up while looking at a table halfway down
          the page, not at the top of it.

          `backdrop-blur` with a translucent ground rather than a solid bar:
          content sliding under an opaque strip looks like it has been cut off,
          and the blur says it is passing behind something. */}
      <header className="sticky top-0 z-20 shrink-0 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
        <div className="flex items-center justify-between gap-3 px-4 py-2.5">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
              <MessageCircleMore aria-hidden size={17} />
            </span>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold tracking-tight">bunwa</h1>
              {identity !== null && (
                // The names, not the ids. "7f30cbb0 / fff9c296" told an
                // operator nothing about which project or environment they
                // were acting on — which is the one thing a header in front of
                // a live WhatsApp connection has to make obvious. The ids are
                // still available on the panel for anyone quoting one in a
                // support ticket.
                identity.level === "admin" ? (
                  <p className="text-[11px] text-slate-500">
                    instance
                    <span className="ml-1.5 rounded bg-slate-200 px-1 py-px text-[10px] font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                      admin
                    </span>
                  </p>
                ) : (
                <p className="text-[11px] text-slate-500">
                  {identity.projectName}
                  <span className="mx-1 text-slate-300 dark:text-slate-700">/</span>
                  {identity.environmentSlug}
                  {identity.environmentKind === "test" && (
                    // Called out, because sending from a test environment when
                    // you meant production is silent and irreversible.
                    <span className="ml-1.5 rounded bg-amber-100 px-1 py-px text-[10px] font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                      test
                    </span>
                  )}
                </p>
                )
              )}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {signedIn && (
              <span
                aria-label={`event stream ${stream}`}
                className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs dark:border-slate-800 dark:bg-slate-900"
              >
                <StreamIcon state={stream} />
                <span className="text-slate-600 dark:text-slate-400">{stream}</span>
              </span>
            )}

            <ThemeToggle />

            {/* In the ribbon as well as the panel. The panel is the considered
                place for it; the ribbon is where someone reaches when they
                want out of a shared screen quickly. */}
            {signedIn && (
              <button
                type="button"
                onClick={signOut}
                aria-label="Sign out"
                title="Sign out"
                className="grid size-8 place-items-center rounded-md text-slate-500 hover:bg-rose-50 hover:text-rose-700 dark:hover:bg-rose-950 dark:hover:text-rose-400"
              >
                <LogOut aria-hidden size={16} />
              </button>
            )}
          </div>
        </div>
      </header>

      {signedIn ? (
        /* The full width, with the panel. The tables and the conversation view
           were squeezed into a 5xl column that left half of any real monitor
           empty. */
        <div className="flex min-h-0 flex-1">
          <Sidebar
            active={route.section}
            onSelect={navigate}
            onSignOut={signOut}
            // An admin key has no tenant to name in the panel, and the level
            // is what decides which sections exist at all.
            identity={identity.level === "tenant" ? identity : null}
            level={identity.level}
            scopes={identity.scopes}
          />

          <main className="min-w-0 flex-1 p-4">
            {error !== null && (
              <p role="alert" className="mb-3 text-sm text-rose-700 dark:text-rose-400">
                {error}
              </p>
            )}

            {/* In the shell rather than on a page, because what raises a
                notice and what shows it are usually different screens: pairing
                finishes on the claim page and the operator is sent to the
                device list to read about it. Dismissed by hand, not on a
                timer — this is the explanation for a navigation the operator
                did not ask for, and it should still be there if they looked
                away. */}
            {notice !== null && (
              <div
                role="status"
                className={`mb-3 flex items-start justify-between gap-3 rounded-md p-3 text-sm ${
                  noticeTone === "bad"
                    ? "bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200"
                    : "bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-100"
                }`}
              >
                <span>{notice}</span>
                <button
                  type="button"
                  onClick={dismissNotice}
                  aria-label="Dismiss"
                  className="shrink-0 rounded px-1 opacity-60 hover:opacity-100"
                >
                  ×
                </button>
              </div>
            )}

            <Section id={route.section} />
          </main>
        </div>
      ) : (
        /* One card, centred. There is exactly one thing to do on this screen,
           and pinning it to the top of a full-width page stranded it in a
           corner. */
        <main className="flex flex-1 items-center justify-center p-4">
          <div className="w-full max-w-md">
            {/* A fresh instance gets the setup screen instead of a key form
                nothing could satisfy: there is no key to type, and no way to
                obtain one without this.

                `mintedKey` is in the condition because finishing setup flips
                `configured` to true — which unmounted this the instant the key
                was created, destroying the one and only render of a credential
                that cannot be shown again. The screen stays until the operator
                dismisses it themselves. */}
            {checking && (
              <Card id="checking" title="bunwa" icon={KeyRound}>
                <p className="flex items-center gap-2 text-sm text-slate-500">
                  <LoaderCircle aria-hidden size={14} className="animate-spin" />
                  {configured === null ? "Checking this instance…" : "Checking access key…"}
                </p>
              </Card>
            )}

            {!checking && (configured === false || mintedKey !== null) && <SetupPage />}

            {!checking && configured !== false && mintedKey === null && (
              <Card id="connect" title="Connect" icon={KeyRound}>
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void connect(draft);
                  }}
                >
                  {/* The shared Field rather than a bare input, which is how
                      this one missed the reveal toggle: a key restored from
                      storage arrives already filled, and dots give no way to
                      tell a leftover credential from the right one. */}
                  <Field
                    id="api-key"
                    label="API key"
                    type="password"
                    mono
                    value={draft}
                    onChange={(next) => {
                      // Typed now, whatever it was a moment ago: the hint
                      // would otherwise describe the stored key while the box
                      // holds something the operator has just entered.
                      setRestored(false);
                      setDraft(next);
                    }}
                    placeholder="bw_live_…"
                    hint={
                      restored
                        ? "Restored from this browser. Reveal it to check it is the key you expect."
                        : undefined
                    }
                  />

                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center justify-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
                  >
                    {busy ? (
                      <LoaderCircle aria-hidden size={14} className="animate-spin" />
                    ) : (
                      <LogIn aria-hidden size={14} />
                    )}
                    {busy ? "checking…" : "connect"}
                  </button>
                </form>

                {error !== null && (
                  <p role="alert" className="mt-3 text-sm text-rose-700 dark:text-rose-400">
                    {error}
                  </p>
                )}
              </Card>
            )}
          </div>
        </main>
      )}
    </div>
  );
}
