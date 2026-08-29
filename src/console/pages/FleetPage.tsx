/**
 * Devices, as the operator sees them.
 *
 * The same phones the project screen shows, with the part a tenant cannot be
 * told: which other projects hold the same number. That is the only thing that
 * makes retiring one an informed act — the difference between ending a number
 * nobody uses and cutting off three tenants who never asked.
 *
 * Retiring here is unconditional, unlike releasing on the project screen. An
 * operator can see the holders before pressing it, so a button that quietly
 * declined because someone still had a binding would be a button that does
 * nothing in exactly the case it exists for.
 */
import { useEffect } from "react";
import { Smartphone } from "lucide-react";

import { Card } from "../components/Card";
import { StatusPill } from "../components/StatusPill";
import { useFleet } from "../store/fleet";
import { useNotice } from "../store/notice";
import { useSession } from "../store/session";

/**
 * The fleet screen.
 *
 * Reads `useFleet` rather than `useDevices`: the two stores answer to
 * different credentials, and this one is the only view whose rows carry the
 * holding projects. Rendering it from the tenant store would show an operator
 * their own project's numbers and call it the instance.
 */
export function FleetPage() {
  const revision = useSession((s) => s.revision);
  const { devices, error, busy, load, retire } = useFleet();
  const showNotice = useNotice((s) => s.show);

  useEffect(() => {
    void load();
  }, [load, revision]);

  return (
    <Card id="fleet" title="Devices" icon={Smartphone}>
      {error !== null && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
          {error}
        </p>
      )}

      {devices === null ? (
        <p className="text-sm text-slate-500">loading…</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-slate-500">No devices on this instance yet.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th scope="col" className="py-2">Number</th>
              <th scope="col">State</th>
              <th scope="col">Used by</th>
              <th scope="col" className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.deviceId} className="border-t border-slate-100 align-top dark:border-slate-900">
                <td className="py-2 font-mono text-xs">{device.msisdn}</td>
                <td><StatusPill state={device.state} /></td>
                <td className="py-2">
                  {device.heldBy.length === 0 ? (
                    // Worth saying rather than leaving blank: a paired device
                    // no project holds is the one most worth retiring, and an
                    // empty cell reads as missing data.
                    <span className="text-xs text-slate-500">nobody</span>
                  ) : (
                    <ul className="flex flex-col gap-0.5">
                      {device.heldBy.map((holder) => (
                        <li key={`${holder.projectId}-${holder.alias}`} className="text-xs">
                          {holder.projectName}
                          <span className="mx-1 text-slate-400">/</span>
                          {holder.environmentSlug}
                          <span className="ml-1.5 font-mono text-[11px] text-slate-500">{holder.alias}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      // Confirmed, because this one is not recoverable: the
                      // credentials are destroyed and the number has to be
                      // paired again from the phone. The project screen's
                      // release can be undone by claiming; this cannot.
                      const holders = device.heldBy.length;
                      const warning =
                        holders === 0
                          ? `Retire ${device.msisdn}? Its credentials and history will be destroyed and it must be paired again.`
                          : `Retire ${device.msisdn}? It is still used by ${String(holders)} project(s). They will lose it, its credentials and history will be destroyed, and it must be paired again.`;
                      if (!confirm(warning)) return;

                      void retire(device.deviceId).then((ok) => {
                        if (ok) showNotice(`${device.msisdn} retired.`);
                      });
                    }}
                    className="rounded-md border border-rose-300 px-2 py-1 text-xs font-medium text-rose-700 hover:bg-rose-50 disabled:opacity-40 dark:border-rose-900 dark:text-rose-400 dark:hover:bg-rose-950"
                  >
                    retire
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
