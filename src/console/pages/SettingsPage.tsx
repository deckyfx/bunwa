/**
 * Instance settings, after setup.
 *
 * The same two values the setup screen collects, reachable once the instance
 * has a credential. Without this the instance name could only ever be chosen
 * during first run: the setup token is spent the moment it is used.
 *
 * A change to the instance name only reaches WhatsApp on the next pairing —
 * the phone fixed the label when the device was linked — so the screen says so
 * rather than leaving someone waiting for a list entry to rename itself.
 */
import { useEffect, useState } from "react";

import { Field } from "../components/Field";
import { useSettings } from "../store/settings";

export function SettingsPage() {
  const { settings, busy, error, saved, load, save } = useSettings();

  const [instanceName, setInstanceName] = useState("");
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (settings === null) return;
    setInstanceName(settings.instanceName.value);
    setTimezone(settings.serverTimezone.value);
  }, [settings]);

  if (settings === null) {
    return (
      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-semibold">Settings</h2>
        <p className="text-sm text-slate-500">loading…</p>
      </section>
    );
  }

  const nameLocked = settings.instanceName.source === "environment";
  const zoneLocked = settings.serverTimezone.source === "environment";

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-lg font-semibold">Settings</h2>

      <form
        className="flex max-w-md flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save({
            instanceName: nameLocked ? undefined : instanceName,
            serverTimezone: zoneLocked ? undefined : timezone,
          });
        }}
      >
        <Field
          id="settings-instance-name"
          label="Instance name"
          value={instanceName}
          onChange={setInstanceName}
          disabled={nameLocked}
          hint="Shown in WhatsApp under Linked Devices. It applies the next time a device is paired — an already-linked device keeps the name it was paired under."
        />

        <Field
          id="settings-timezone"
          label="Server timezone"
          value={timezone}
          onChange={setTimezone}
          disabled={zoneLocked}
          hint={
            zoneLocked
              ? "Set by SERVER_TIMEZONE in the environment, which takes precedence over anything set here."
              : "Every timestamp on these screens and in the logs is rendered in this zone."
          }
        />

        {error !== null && (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
            {error}
          </p>
        )}
        {saved && error === null && <p className="text-sm text-emerald-700 dark:text-emerald-400">saved</p>}

        <button
          type="submit"
          disabled={busy || (nameLocked && zoneLocked)}
          className="self-start rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? "saving…" : "save"}
        </button>
      </form>
    </section>
  );
}
