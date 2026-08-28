/**
 * The console shell.
 *
 * Holds the key form, the connection indicator and the pages. It holds no
 * request state of its own any more — that moved into the stores, because
 * four screens needed the same guards and each had written its own.
 */
import { useEffect, useState } from "react";
import { KeyRound, LoaderCircle, LogIn, MessageCircleMore, Wifi, WifiOff } from "lucide-react";

import { ChatsPage } from "./pages/ChatsPage";
import { Card } from "./components/Card";
import { SettingsPage } from "./pages/SettingsPage";
import { SetupPage } from "./pages/SetupPage";
import { ClaimPage } from "./pages/ClaimPage";
import { DeliveriesPage } from "./pages/DeliveriesPage";
import { DevicesPage } from "./pages/DevicesPage";
import { useEventStream } from "./hooks/useEventStream";
import { useSession } from "./store/session";
import { useSetup } from "./store/setup";

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

export function App() {
  const { apiKey, identity, error, busy, connect, hydrate } = useSession();
  const configured = useSetup((s) => s.configured);
  const refreshSetup = useSetup((s) => s.refresh);
  const [draft, setDraft] = useState(apiKey);
  const stream = useEventStream();

  // Asked before anything else, because "this instance has no key" and "your
  // key is wrong" need different screens and look identical from here.
  useEffect(() => {
    void refreshSetup();
  }, [refreshSetup]);

  // Prove the restored key once, on mount.
  //
  // The store reads the key back out of localStorage, so `apiKey` survives a
  // refresh, and until it is proved the console looked logged out while every
  // background request behaved as though it were logged in — including the
  // stream, which asked for a ticket every few seconds against a key the
  // server had already rejected. `hydrate` owns the guards, so the same rule
  // applies wherever it is called from rather than living in this component.
  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950">
      {/* Sticky, because the stream indicator and the identity are the two
          things worth being able to check without scrolling — the question
          "is this still live?" comes up while looking at a table halfway down
          the page, not at the top of it.

          `backdrop-blur` with a translucent ground rather than a solid bar:
          content sliding under an opaque strip looks like it has been cut off,
          and the blur says it is passing behind something. */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/80 backdrop-blur dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid size-8 place-items-center rounded-lg bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900">
              <MessageCircleMore aria-hidden size={17} />
            </span>
            <div className="leading-tight">
              <h1 className="text-sm font-semibold tracking-tight">bunwa</h1>
              {identity !== null && (
                <p className="font-mono text-[11px] text-slate-500">
                  {identity.projectId.slice(0, 8)} / {identity.environmentId.slice(0, 8)}
                </p>
              )}
            </div>
          </div>

          {/* The stream state is shown because "nothing is happening" and "we
              stopped listening" look identical otherwise.

              The icon carries the same fact as the word, on purpose: this is
              read peripherally, where a shape registers and a four-letter word
              does not. `aria-label` on the wrapper keeps one announcement
              rather than two. */}
          <span
            aria-label={`event stream ${stream}`}
            className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs dark:border-slate-800 dark:bg-slate-900"
          >
            <StreamIcon state={stream} />
            <span className="text-slate-600 dark:text-slate-400">{stream}</span>
          </span>
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
        {/* A fresh instance gets the setup screen instead of a key form nothing
            could satisfy: there is no key to type, and no way to obtain one
            without this. */}
        {configured === false && <SetupPage />}

        {configured !== false && identity === null && (
          <Card id="connect" title="Connect" icon={KeyRound}>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void connect(draft);
              }}
            >
              <div className="flex min-w-64 flex-1 flex-col gap-1">
                <label htmlFor="api-key" className="text-sm font-medium">
                  API key
                </label>
                <input
                  id="api-key"
                  type="password"
                  value={draft}
                  onChange={(e) => {
                    setDraft(e.target.value);
                  }}
                  placeholder="bw_live_…"
                  className="rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-slate-500 dark:border-slate-700 dark:bg-slate-900"
                />
              </div>
              <button
                type="submit"
                disabled={busy}
                className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
              >
                {busy ? <LoaderCircle aria-hidden size={14} className="animate-spin" /> : <LogIn aria-hidden size={14} />}
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

        {/* Once connected the key form is gone, so a failure after that has
            nowhere to appear unless it is shown here. */}
        {identity !== null && error !== null && (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
            {error}
          </p>
        )}

        {identity !== null && (
          <>
            <ClaimPage />
            <DevicesPage />
            <ChatsPage />
            <DeliveriesPage />
            <SettingsPage />
          </>
        )}
      </main>
    </div>
  );
}
