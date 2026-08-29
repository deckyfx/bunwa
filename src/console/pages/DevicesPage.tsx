/**
 * The devices this environment can send through.
 *
 * A number is shown as the API returns it. The console does not reformat one:
 * an operator matching a row against a support ticket needs the same string
 * both places.
 */
import { useEffect } from "react";

import { Smartphone } from "lucide-react";

import { Card } from "../components/Card";

import { StatusPill } from "../components/StatusPill";
import { useDevices } from "../store/devices";
import { useNotice } from "../store/notice";
import { useSession } from "../store/session";

export function DevicesPage() {
  const revision = useSession((s) => s.revision);
  const { devices, error, busy, load, release } = useDevices();
  const showNotice = useNotice((s) => s.show);

  useEffect(() => {
    void load();
  }, [load, revision]);

  return (
    <Card id="devices" title="Devices" icon={Smartphone}>

      {error !== null && (
        <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
          {error}
        </p>
      )}

      {devices === null ? (
        <p className="text-sm text-slate-500">loading…</p>
      ) : devices.length === 0 ? (
        <p className="text-sm text-slate-500">None yet. Claim one above.</p>
      ) : (
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-500">
            <tr>
              <th scope="col" className="py-2">Alias</th>
              <th scope="col">Number</th>
              <th scope="col">Binding</th>
              <th scope="col">Device</th>
              <th scope="col" className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.virtualDeviceId} className="border-t border-slate-100 dark:border-slate-900">
                <td className="py-2 font-medium">{device.alias}</td>
                <td className="font-mono text-xs">{device.msisdn ?? "—"}</td>
                <td><StatusPill state={device.status} /></td>
                {/* Both states, because they answer different questions: the
                    binding is whether this project may use the number, and the
                    device is whether WhatsApp is connected at all. */}
                <td><StatusPill state={device.deviceState} /></td>
                <td className="py-2 text-right">
                  {/* "Release", not "disconnect". What this does depends on
                      whether anyone else holds the same number — it either
                      unsubscribes this project or ends the device entirely —
                      and a word that promised the second would be a lie half
                      the time. The notice afterwards says which happened. */}
                  <button
                    type="button"
                    disabled={busy || device.status === "revoked"}
                    onClick={() => {
                      void release(device.alias).then((outcome) => {
                        if (outcome === null) return;
                        showNotice(
                          outcome.outcome === "retired"
                            ? `${device.alias} was the last claim on that number, so it has been unlinked and its data erased.`
                            : `${device.alias} released. The number is still in use by ${String(outcome.stillHeldBy)} other project(s).`,
                        );
                      });
                    }}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                  >
                    release
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
