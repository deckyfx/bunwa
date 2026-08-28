/**
 * The console shell.
 *
 * Holds the key form, the connection indicator and the pages. It holds no
 * request state of its own any more — that moved into the stores, because
 * four screens needed the same guards and each had written its own.
 */
import { useEffect, useState } from "react";

import { ChatsPage } from "./pages/ChatsPage";
import { ClaimPage } from "./pages/ClaimPage";
import { DeliveriesPage } from "./pages/DeliveriesPage";
import { DevicesPage } from "./pages/DevicesPage";
import { useEventStream } from "./hooks/useEventStream";
import { useSession } from "./store/session";

export function App() {
  const { apiKey, identity, error, busy, connect } = useSession();
  const [draft, setDraft] = useState(apiKey);
  const stream = useEventStream();

  // Prove the restored key once, on mount.
  //
  // The store reads the key back out of localStorage, so `apiKey` survives a
  // refresh — but nothing called `connect` with it, so `identity` stayed null
  // and every page stayed hidden until the operator pressed connect on a form
  // that was already filled in. Guarded on `identity` and `error` so this does
  // not re-run behind a key the server has already rejected, and on `busy` so
  // it cannot race the connection it started.
  useEffect(() => {
    if (apiKey === "" || identity !== null || error !== null || busy) return;
    void connect(apiKey);
  }, [apiKey, identity, error, busy, connect]);

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-4 p-4">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">bunwa console</h1>
          {identity !== null && (
            <p className="font-mono text-xs text-slate-500">
              {identity.projectId} / {identity.environmentId}
            </p>
          )}
        </div>

        {/* The stream state is shown because "nothing is happening" and "we
            stopped listening" look identical otherwise. */}
        <span
          aria-label={`event stream ${stream}`}
          className="rounded-full bg-slate-100 px-2 py-0.5 text-xs dark:bg-slate-800"
        >
          {stream}
        </span>
      </header>

      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void connect(draft);
        }}
      >
        <div className="flex flex-1 flex-col gap-1">
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
            className="rounded-md border border-slate-300 px-3 py-2 text-sm dark:border-slate-700 dark:bg-slate-900"
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? "checking…" : "connect"}
        </button>
      </form>

      {error !== null && (
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
        </>
      )}
    </main>
  );
}
