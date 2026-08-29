/**
 * Webhook deliveries.
 *
 * Answers "did it fire, and what did they say" — the question docs/06 says a
 * customer eventually asks in anger.
 */
import { useEffect } from "react";

import { Send } from "lucide-react";

import { Card } from "../components/Card";

import { StatusPill } from "../components/StatusPill";
import { useDeliveries } from "../store/deliveries";
import { useSession } from "../store/session";

export function DeliveriesPage() {
  const revision = useSession((s) => s.revision);
  const { deliveries, replaying, error, load, replay } = useDeliveries();

  useEffect(() => {
    void load();
  }, [load, revision]);

  return (
    <Card id="deliveries" title="Deliveries" icon={Send}>

      {error !== null && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
          {error}
        </p>
      )}

      {deliveries === null ? (
        <p className="text-sm text-slate-500">loading…</p>
      ) : deliveries.length === 0 ? (
        <p className="text-sm text-slate-500">Nothing delivered yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th scope="col" className="py-2">Event</th>
              <th scope="col">State</th>
              <th scope="col">Attempts</th>
              <th scope="col"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {deliveries.map((delivery) => (
              <tr key={delivery.id} className="border-t border-slate-100 dark:border-slate-900">
                <td className="py-2 font-mono text-xs">{delivery.eventType}</td>
                <td><StatusPill state={delivery.state} /></td>
                <td>{delivery.attemptCount}</td>
                <td className="text-right">
                  <button
                    type="button"
                    onClick={() => void replay(delivery.id)}
                    disabled={replaying.has(delivery.id)}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs disabled:opacity-40 dark:border-slate-700"
                  >
                    {replaying.has(delivery.id) ? "replaying…" : "replay"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
