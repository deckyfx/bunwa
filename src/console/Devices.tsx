/**
 * Device management.
 *
 * The list was read-only until now: alias, status, number, and nothing an
 * operator could actually do. The two things they need when a device stops
 * working are to log it out and to pair it again, and both were API-only.
 *
 * Re-pairing shows the QR inline rather than sending the operator back to the
 * claim screen — the number is already theirs, so re-claiming it would be the
 * wrong flow and would reopen a consent question that is already answered.
 */
import { useState } from "react";

import { api, ApiError, type VirtualDevice } from "./api";
import { Qr } from "./Qr";

interface Props {
  apiKey: string;
  devices: VirtualDevice[];
  onChanged: () => void;
}

interface Repair {
  alias: string;
  qr?: string;
  pairCode?: string;
  expiresAt: string;
}

export function Devices({ apiKey, devices, onChanged }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repair, setRepair] = useState<Repair | null>(null);

  async function act(alias: string, what: "logout" | "repair") {
    setBusy(`${alias}:${what}`);
    setError(null);
    try {
      if (what === "logout") {
        await api.logoutDevice(apiKey, alias);
        setRepair(null);
      } else {
        const result = await api.repairDevice(apiKey, alias);
        setRepair({ alias, ...result.pairing });
      }
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message}${err.detail === null ? "" : ` — ${err.detail}`}`
          : "could not reach the API",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <section aria-labelledby="devices">
      <h2 id="devices">Devices</h2>
      {error !== null && <p role="alert">{error}</p>}

      {devices.length === 0 ? (
        <p>None yet. Claim one above.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Alias</th>
              <th>Number</th>
              <th>Status</th>
              <th>Connection</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((device) => (
              <tr key={device.virtualDeviceId}>
                <td>{device.alias}</td>
                <td>{device.msisdn ?? "—"}</td>
                <td>{device.status}</td>
                {/* Both are shown because they answer different questions:
                    status is what the binding believes, deviceState is what
                    the socket last reported. They disagree exactly when
                    something is wrong, which is when an operator is looking. */}
                <td>{device.deviceState}</td>
                <td>
                  <button
                    type="button"
                    onClick={() => void act(device.alias, "logout")}
                    disabled={busy !== null}
                  >
                    {busy === `${device.alias}:logout` ? "logging out…" : "log out"}
                  </button>
                  <button
                    type="button"
                    onClick={() => void act(device.alias, "repair")}
                    disabled={busy !== null}
                  >
                    {busy === `${device.alias}:repair` ? "starting…" : "re-pair"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {repair !== null && (
        <div role="status">
          <h3>Re-pair {repair.alias}</h3>
          {repair.qr !== undefined && <Qr payload={repair.qr} />}
          {repair.pairCode !== undefined && (
            <p>
              Or enter code <strong>{repair.pairCode}</strong>
            </p>
          )}
          <p>
            Expires <time dateTime={repair.expiresAt}>{repair.expiresAt}</time>
          </p>
        </div>
      )}
    </section>
  );
}
