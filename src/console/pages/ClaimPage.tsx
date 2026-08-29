/**
 * Claiming a number.
 *
 * Three outcomes that must feel like one flow (docs/07). The hard one is the
 * third: the number belongs to another project, so a real person has been
 * messaged and is deciding. A developer who reads that as a system fault will
 * retry, and every retry messages that person again — which is why the API
 * rate-limits claims per environment, and why this screen says plainly that
 * the wait is human.
 */
import { useEffect } from "react";
import { PlusCircle } from "lucide-react";

import { Card } from "../components/Card";
import { Field } from "../components/Field";
import { Qr } from "../components/Qr";
import { useClaim, type ClaimResult } from "../store/claim";
import { useDevices } from "../store/devices";
import { useNotice } from "../store/notice";
import { useRoute } from "../store/route";
import { useSession } from "../store/session";

export function ClaimPage() {
  const { msisdn, alias, result, error, busy, setMsisdn, setAlias, submit, pairing, settled } =
    useClaim();
  const revision = useSession((s) => s.revision);
  const devices = useDevices((s) => s.devices);
  const loadDevices = useDevices((s) => s.load);
  const navigate = useRoute((s) => s.navigate);
  const showNotice = useNotice((s) => s.show);

  // Refetch while a scan is outstanding.
  //
  // `device.connected` bumps the revision, but only the device list reacts to
  // it — so with the claim screen open nothing asked the server anything and
  // the QR sat there after it had been used. Scoped to a pending pairing so
  // this screen is not fetching devices the rest of the time.
  useEffect(() => {
    if (pairing === null) return;
    void loadDevices();
  }, [pairing, revision, loadDevices]);

  // The scan landed: say so, and go where the answer is.
  //
  // The device list is the screen that can show state, last seen and the
  // actions available now; this one has done its job and cannot say anything
  // further. `settled()` first, so the watch stops before the navigation and a
  // second render cannot fire it twice.
  useEffect(() => {
    if (pairing === null || devices === null) return;
    const paired = devices.find((d) => d.virtualDeviceId === pairing.virtualDeviceId);
    if (paired === undefined || paired.deviceState !== "connected") return;

    settled();
    showNotice(`${pairing.alias} is connected.`);
    navigate("devices");
  }, [pairing, devices, settled, showNotice, navigate]);

  return (
    <Card id="claim" title="Claim a number" icon={PlusCircle}>

      <form
        className="flex flex-col gap-3 sm:max-w-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field id="msisdn" label="Phone number" value={msisdn} onChange={setMsisdn} placeholder="+628123456789" />
        <Field id="alias" label="Alias" value={alias} onChange={setAlias} placeholder="otp-sender" />

        <button
          type="submit"
          disabled={busy || msisdn.trim() === "" || alias.trim() === ""}
          className="self-start rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? "claiming…" : "claim"}
        </button>
      </form>

      {error !== null && (
        <p role="alert" className="mt-3 text-sm text-rose-700 dark:text-rose-400">
          {error}
        </p>
      )}

      {result !== null && <Outcome result={result} />}

      {/* Said while the code is on screen, because a QR that has been scanned
          looks exactly like one that has not. Without this the operator scans,
          nothing visibly changes, and the reasonable next move is to claim
          again — which starts a second pairing for a device already pairing. */}
      {pairing !== null && (
        <p className="mt-3 text-sm text-slate-600 dark:text-slate-400">
          Waiting for the scan. This page moves to Devices on its own once
          {" "}
          {pairing.alias} connects.
        </p>
      )}
    </Card>
  );
}

/** The three outcomes, each said in the terms its reader needs. */
function Outcome({ result }: { result: ClaimResult }) {
  if (!("outcome" in result)) return null;

  if (result.outcome === "active") {
    return (
      <div role="status" className="mt-4 rounded-md bg-emerald-50 p-3 dark:bg-emerald-950/40">
        <h3 className="font-medium">Already yours</h3>
        <p className="text-sm">Active. Nothing to do.</p>
      </div>
    );
  }

  if (result.outcome === "awaiting_confirmation") {
    return (
      <div role="status" className="mt-4 rounded-md bg-amber-50 p-3 dark:bg-amber-950/40">
        <h3 className="font-medium">Used by another project</h3>
        {/* Deliberately names who is being waited on. "Pending" reads as a
            queue, and the developer retries — messaging that person again. */}
        <p className="text-sm">
          {/* The fallback must not out-claim the route. It used to read "The
              phone holder has been asked to confirm", which the route stopped
              saying precisely because nothing sends that message — so the
              sentence the API retired could still reach the screen from here. */}
          {"message" in result && typeof result.message === "string"
            ? result.message
            : "This number belongs to another project. Consent has not been requested yet."}
        </p>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
          This waits on a person, not on us. There is nothing to retry.
        </p>
      </div>
    );
  }

  const pairing = "pairing" in result ? result.pairing : undefined;
  return (
    <div role="status" className="mt-4">
      <h3 className="font-medium">New number</h3>
      {pairing === undefined ? (
        <p className="text-sm">Pairing is starting.</p>
      ) : (
        <div className="mt-2 flex flex-col gap-2">
          {/* Each instruction belongs to the thing above it. "Scan this" was
              printed unconditionally, so a claim made with pairingMethod
              "code" — which returns a pairCode and no QR — told the operator
              to scan something that was not on the screen, and then offered
              the code as an alternative to it. */}
          {pairing.qr !== undefined && (
            <>
              <Qr payload={pairing.qr} />
              <p className="text-sm text-slate-600 dark:text-slate-400">
                Scan this in WhatsApp → Linked devices.
              </p>
            </>
          )}
          {pairing.pairCode !== undefined && (
            <p className="text-sm">
              {pairing.qr === undefined ? "Enter code " : "Or enter code "}
              <strong className="font-mono">{pairing.pairCode}</strong>
              {pairing.qr === undefined ? " in WhatsApp → Linked devices." : ""}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
