/**
 * The project console.
 *
 * docs/07 calls for two route trees — a project console for a developer at
 * Grande, and an operator console for the fleet. This is the first screen of
 * the first one: prove the key, then show what it can see. Routing arrives when
 * there is a second screen to route to.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type VirtualDevice, type Whoami } from "./api";
import { ClaimScreen } from "./ClaimScreen";
import { useEventStream } from "./useEventStream";
import { Deliveries } from "./Deliveries";

/** Where the key lives between reloads. */
const KEY_STORAGE = "bunwa.console.key";

/**
 * Held in localStorage, and that is a decision to revisit.
 *
 * ADR-0008 notes it: the console needs the key to mint stream tickets, so it
 * must keep it somewhere, and localStorage is readable by any script that gets
 * onto the page. It is acceptable for a console a developer runs against their
 * own project and not for much else — which is the argument for the cookie
 * session the ADR leaves on the table.
 */
function loadKey(): string {
  try {
    return localStorage.getItem(KEY_STORAGE) ?? "";
  } catch {
    // Private windows and blocked site data both throw rather than return null.
    return "";
  }
}

function storeKey(key: string): void {
  try {
    if (key === "") localStorage.removeItem(KEY_STORAGE);
    else localStorage.setItem(KEY_STORAGE, key);
  } catch {
    // Not fatal: the console works, it just forgets on reload.
  }
}

export function App() {
  const [key, setKey] = useState(loadKey);
  const [draft, setDraft] = useState(key);
  const [who, setWho] = useState<Whoami | null>(null);
  const [devices, setDevices] = useState<VirtualDevice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Bumped by any event, so children refetch without each opening its own
  // stream — docs/07 wants one connection per console, not one per widget.
  const [revision, setRevision] = useState(0);
  // Bumped by every submit, so resubmitting the *same* key still reloads.
  // Clearing state before setKey broke retry: setKey(draft) with an unchanged
  // draft is a no-op, so the effect never re-ran and the console sat blank
  // with no way back except a page refresh.
  const [attempt, setAttempt] = useState(0);

  // Only the newest load may commit.
  //
  // Events arrive in bursts, so several loads can be in flight at once, and
  // whichever resolves last wins regardless of which was asked for last. An
  // older response then overwrites a newer one — including restoring a project
  // after the key was cleared, which puts authenticated data back on screen
  // with no credential behind it.
  const generation = useRef(0);

  const load = useCallback(async (withKey: string) => {
    const mine = ++generation.current;
    const current = () => generation.current === mine;

    if (withKey === "") {
      // Cleared, not just skipped. Returning early left the previous project
      // and its devices on screen with no credential behind them, which reads
      // as still-connected and is the opposite of what clearing a key means.
      setWho(null);
      setDevices(null);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // whoami first: it is the cheapest way to tell a bad key from a working
      // key with nothing behind it, and those need different messages.
      const identity = await api.whoami(withKey);
      if (!current()) return;
      setWho(identity);

      const listed = await api.devices(withKey);
      if (!current()) return;
      setDevices(listed);
    } catch (err) {
      if (!current()) return;
      setWho(null);
      setDevices(null);
      setError(
        err instanceof ApiError
          ? `${err.message}${err.detail === null ? "" : ` — ${err.detail}`}`
          : "could not reach the API",
      );
    } finally {
      if (current()) setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(key);
  }, [key, load, attempt]);

  // Live rather than polled. Any device event means the list on screen is out
  // of date, so it is refetched — the event says *that* something changed, and
  // the API remains the authority on what it changed to. docs/07: optimistic
  // UI for actions, SSE for truth.
  const streamState = useEventStream({
    apiKey: who === null ? "" : key,
    onEvent: (type) => {
      if (type.startsWith("device.")) void load(key);
      // Any event at all may have produced a delivery, including the
      // message.undelivered the housekeeper raises.
      setRevision((r) => r + 1);
    },
  });

  return (
    <main>
      <h1>bunwa console</h1>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          // Invalidated first, then cleared.
          //
          // Defensive: load() already bumps generation on entry, and React
          // flushes the effect before the submit handler returns, so no test
          // could reach the window this closes — two attempts passed with and
          // without it. Kept because it costs one line and because "no path
          // reaches this" has twice been wrong on this project, once
          // expensively.
          generation.current += 1;

          // Cleared before the new key is applied. Without this the previous
          // project stays on screen while the new key is being checked, and a
          // stalled request leaves it there indefinitely — showing one
          // project's data under another project's credential.
          setWho(null);
          setDevices(null);
          setError(null);
          storeKey(draft);
          setKey(draft);
          setAttempt((a) => a + 1);
        }}
      >
        <label htmlFor="apikey">API key</label>
        <input
          id="apikey"
          type="password"
          value={draft}
          placeholder="bw_live_…"
          onChange={(e) => setDraft(e.target.value)}
          autoComplete="off"
        />
        <button type="submit" disabled={busy}>
          {busy ? "checking…" : "connect"}
        </button>
      </form>

      {error !== null && <p role="alert">{error}</p>}

      {who !== null && (
        <section aria-labelledby="ctx">
          <h2 id="ctx">
            {who.projectId} / {who.environmentId}
          </h2>
          <p>{who.scopes.length} scope(s)</p>
          {/* Shown, not assumed. A dead EventSource that leaves stale data on
              screen looking live is worse than an error banner. */}
          <p>
            live updates:{" "}
            <strong>
              {streamState === "live"
                ? "connected"
                : streamState === "connecting"
                  ? "connecting…"
                  : streamState === "stale"
                    ? "disconnected — this page may be out of date"
                    : "off"}
            </strong>
          </p>
        </section>
      )}

      {who !== null && <ClaimScreen apiKey={key} onClaimed={() => void load(key)} />}

      {who !== null && <Deliveries apiKey={key} revision={revision} />}

      {devices !== null && (
        <section aria-labelledby="devices">
          <h2 id="devices">Virtual devices</h2>
          {devices.length === 0 ? (
            <p>None yet. Claim one above.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th scope="col">Alias</th>
                  <th scope="col">Status</th>
                  <th scope="col">Number</th>
                </tr>
              </thead>
              <tbody>
                {devices.map((d) => (
                  <tr key={d.virtualDeviceId}>
                    <td>{d.alias}</td>
                    <td>{d.status}</td>
                    <td>{d.msisdn ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
    </main>
  );
}
