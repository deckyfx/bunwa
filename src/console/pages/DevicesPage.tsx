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
import { useSession } from "../store/session";

export function DevicesPage() {
  const revision = useSession((s) => s.revision);
  const { devices, error, load } = useDevices();

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
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}
