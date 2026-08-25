/**
 * Webhook deliveries.
 *
 * The last piece of stage 3's exit criteria: a developer watches a delivery
 * succeed without leaving the console. It is also the screen docs/07 says is
 * asked for "eventually, in anger" — the question is always "did you send it?",
 * and answering it from logs is archaeology.
 *
 * State and attempt count are shown together on purpose. `pending` with three
 * attempts is a very different situation from `pending` with none: the first is
 * a failing endpoint backing off, the second is work that has not started.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api, ApiError, type Delivery } from "./api";

interface Props {
  apiKey: string;
  /** Bumped by the caller when an event says something changed. */
  revision: number;
}

export function Deliveries({ apiKey, revision }: Props) {
  const [rows, setRows] = useState<Delivery[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A set, not the most recent id. Tracking one meant clicking replay on a
  // second row re-enabled the first while its request was still in flight, so
  // the same delivery could be replayed twice — and a replay is a webhook the
  // consumer receives again.
  const [replaying, setReplaying] = useState<ReadonlySet<string>>(new Set());

  // Only the newest request may commit, for the same reason as the console
  // above: revision is bumped by every event, events arrive in bursts, and
  // whichever response resolves last would otherwise win — replacing a current
  // list with an older snapshot, or an error from a request already superseded.
  const generation = useRef(0);

  const load = useCallback(async () => {
    const mine = ++generation.current;
    try {
      const listed = await api.deliveries(apiKey);
      if (generation.current !== mine) return;
      setRows(listed);
      setError(null);
    } catch (err) {
      if (generation.current !== mine) return;
      setError(err instanceof ApiError ? err.message : "could not load deliveries");
    }
  }, [apiKey]);

  useEffect(() => {
    void load();
  }, [load, revision]);

  async function replay(id: string) {
    // Refused rather than queued. A second click on a row already in flight is
    // a double send, not a retry.
    if (replaying.has(id)) return;
    setReplaying((current) => new Set(current).add(id));
    try {
      await api.replay(apiKey, id);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "could not replay");
    } finally {
      setReplaying((current) => {
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    }
  }

  return (
    <section aria-labelledby="deliveries">
      <h2 id="deliveries">Webhook deliveries</h2>

      {error !== null && <p role="alert">{error}</p>}

      {rows === null ? (
        <p>Loading…</p>
      ) : rows.length === 0 ? (
        <p>Nothing delivered yet. Events appear here once a webhook is configured.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Event</th>
              <th scope="col">State</th>
              <th scope="col">Attempts</th>
              <th scope="col">Next / delivered</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id}>
                <td>{d.eventType}</td>
                <td>{d.state}</td>
                {/* Attempts beside state, because "pending, 3 attempts" and
                    "pending, 0 attempts" mean opposite things. */}
                <td>{d.attemptCount}</td>
                <td>
                  <time dateTime={d.deliveredAt ?? d.nextAttemptAt}>
                    {d.deliveredAt ?? d.nextAttemptAt}
                  </time>
                </td>
                <td>
                  {/* Offered only where it can help. Replaying a delivered
                      event sends it twice, and replaying one still backing off
                      does nothing the worker was not already going to do. */}
                  {(d.state === "failed" || d.state === "dead") && (
                    <button type="button" onClick={() => void replay(d.id)} disabled={replaying.has(d.id)}>
                      {replaying.has(d.id) ? "replaying…" : "replay"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
