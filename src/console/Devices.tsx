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
import { useEffect, useRef, useState } from "react";

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

  /**
   * Whether this component is still mounted and still on the same credential.
   *
   * `act` awaits two round trips and then writes state and calls `onChanged`.
   * Neither was guarded, so a logout that resolved after the operator switched
   * keys reported success against the new project and asked it to refetch, and
   * one that resolved after the screen unmounted wrote to a component that is
   * gone. The key is captured per call rather than read from props at the end,
   * because props are what changed.
   */
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  async function act(alias: string, what: "logout" | "repair") {
    const usedKey = apiKey;
    /** Still the same screen, on the same credential, as when this started. */
    const current = () => live.current && usedKey === apiKey;

    setBusy(`${alias}:${what}`);
    setError(null);
    try {
      if (what === "logout") {
        await api.logoutDevice(usedKey, alias);
        if (!current()) return;
        setRepair(null);
      } else {
        const result = await api.repairDevice(usedKey, alias);
        if (!current()) return;
        // A pairing code is a credential for the number it pairs. Showing one
        // minted under the previous key on a screen now signed in as someone
        // else is the reason this guard is not merely tidiness.
        setRepair({ alias, ...result.pairing });
      }
      onChanged();
    } catch (err) {
      if (!current()) return;
      setError(
        err instanceof ApiError
          ? `${err.message}${err.detail === null ? "" : ` — ${err.detail}`}`
          : "could not reach the API",
      );
    } finally {
      // Cleared even when the guards above bailed out: `busy` disables the
      // buttons, so leaving it set on a still-mounted screen locks the row.
      if (live.current) setBusy(null);
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
