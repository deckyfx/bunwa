/**
 * First run.
 *
 * The screen an operator sees when the instance has no credential yet. It has
 * one job beyond collecting two values: make the minted key impossible to
 * miss, because it is shown exactly once and there is no way to recover it.
 *
 * The instance name is previewed as WhatsApp will render it, normalisation and
 * all. Someone typing "Grande POS" should learn here that the phone will show
 * "Grande-POS", rather than after pairing a device and wondering why.
 */
import { useEffect, useState } from "react";

import { Check, Copy, LoaderCircle, Rocket, ShieldCheck, Wand2 } from "lucide-react";

import { Card, Note } from "../components/Card";
import { Field } from "../components/Field";
import { TimezoneField } from "../components/TimezoneField";
import { suggestInstanceName } from "../lib/suggest";
import { useSetup } from "../store/setup";

/**
 * Mirror of the server's normalisation, for the preview only.
 *
 * Duplicated deliberately and never trusted: the server normalises again on
 * write, so this being wrong costs a misleading preview rather than a bad
 * value in the database. The alternative — importing the store — would drag
 * configuration and database code into the browser bundle.
 */
function previewName(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
}

/** The key, shown once, with nothing else on screen competing for attention. */
function MintedKey({ apiKey, onDismiss }: { apiKey: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <section className="flex flex-col gap-3 rounded-xl border border-emerald-300 bg-emerald-50 p-5 shadow-sm dark:border-emerald-800 dark:bg-emerald-950/60">
      <h2 className="flex items-center gap-2 text-base font-semibold">
        <ShieldCheck aria-hidden size={18} className="text-emerald-600 dark:text-emerald-500" />
        Your API key
      </h2>
      <p className="text-sm">
        This is the only time it will be shown. Store it somewhere safe before continuing — it cannot be
        recovered, only replaced.
      </p>

      <code className="block break-all rounded-md bg-white p-3 font-mono text-sm dark:bg-slate-900">{apiKey}</code>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 dark:bg-slate-100 dark:text-slate-900"
          onClick={() => {
            void navigator.clipboard?.writeText(apiKey).then(
              () => {
                setCopied(true);
              },
              () => {
                // Clipboard access can be refused. Saying nothing would look
                // like the button is broken; the key is on screen regardless.
                setCopied(false);
              },
            );
          }}
        >
          {copied ? <Check aria-hidden size={14} /> : <Copy aria-hidden size={14} />}
          {copied ? "copied" : "copy"}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="rounded-md border border-slate-300 px-4 py-2 text-sm dark:border-slate-700"
        >
          I have saved it
        </button>
      </div>
    </section>
  );
}

export function SetupPage() {
  const { configured, canMintKey, apiKeySource, settings, busy, error, mintedKey, refresh, submit, dismissKey } =
    useSetup();

  const [token, setToken] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [timezone, setTimezone] = useState("");

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Seed the fields from what the server already has, once it has answered.
  useEffect(() => {
    if (settings === null) return;
    setInstanceName((current) => (current === "" ? settings.instanceName.value : current));
    setTimezone((current) => (current === "" ? settings.serverTimezone.value : current));
  }, [settings]);

  if (mintedKey !== null) return <MintedKey apiKey={mintedKey} onDismiss={dismissKey} />;

  // Null means the status call has not answered. Showing the form would be a
  // guess, and guessing wrong shows a setup screen to a configured instance.
  if (configured === null || settings === null) {
    return (
      <Card id="setup" title="Set up this instance" icon={Rocket}>
        <Note>checking this instance…</Note>
      </Card>
    );
  }

  // Driven by what the server says about each key rather than by which key it
  // is. No environment variable currently backs the instance name — only
  // SERVER_TIMEZONE does — so this is false today. It is written this way
  // because both routes refuse *any* environment-sourced key in one generic
  // loop, and a screen that special-cases the zone would silently stop
  // matching the rule the moment a second variable is added: the operator
  // would type a value, submit, and be refused by the server with no warning
  // the field was never theirs to set.
  const nameLocked = settings.instanceName.source === "environment";
  const timezoneLocked = settings.serverTimezone.source === "environment";
  const preview = previewName(instanceName);

  return (
    <Card id="setup" title="Set up this instance" icon={Rocket}>
      <div className="flex flex-col gap-4">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {canMintKey
            ? "No API key exists yet. Finishing here creates one."
            : apiKeySource === "environment"
              ? "The API key comes from API_KEY in the environment, so none will be created here."
              : "This instance already has an API key."}
        </p>

      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(token, {
            instanceName: nameLocked ? undefined : instanceName,
            serverTimezone: timezoneLocked ? undefined : timezone,
          });
        }}
      >
        <Field
          id="setup-token"
          label="Setup token"
          type="password"
          value={token}
          onChange={setToken}
          placeholder="from the server log"
          hint="Printed to the server log at startup. It changes every restart and is spent once setup completes."
        />

        <Field
          id="setup-instance-name"
          label="Instance name"
          value={instanceName}
          onChange={setInstanceName}
          placeholder="grande-pos"
          disabled={nameLocked}
          action={
            // No suggest button on a locked field: offering to fill in a value
            // that cannot be submitted is worse than offering nothing.
            nameLocked ? undefined : (
              <button
                type="button"
                onClick={() => {
                  setInstanceName(suggestInstanceName());
                }}
                className="inline-flex items-center gap-1 text-xs text-sky-700 hover:underline dark:text-sky-400"
              >
                <Wand2 aria-hidden size={12} />
                suggest
              </button>
            )
          }
          hint={
            nameLocked
              ? "Set in the environment, which takes precedence over anything set here."
              : preview === ""
                ? "Shown in WhatsApp under Linked Devices. Letters and digits only."
                : `WhatsApp will show this as "Google Chrome (${preview})". Pairing by code always shows Ubuntu instead — WhatsApp will not complete that handshake otherwise.`
          }
        />

        <TimezoneField
          id="setup-timezone"
          value={timezone}
          onChange={setTimezone}
          disabled={timezoneLocked}
          hint={
            timezoneLocked
              ? "Set by SERVER_TIMEZONE in the environment, which takes precedence over anything set here."
              : "Every timestamp on these screens and in the logs is rendered in this zone."
          }
        />

        {error !== null && (
          <p role="alert" className="text-sm text-rose-700 dark:text-rose-400">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="inline-flex items-center gap-1.5 self-start rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? <LoaderCircle aria-hidden size={14} className="animate-spin" /> : <Rocket aria-hidden size={14} />}
          {busy ? "saving…" : canMintKey ? "finish setup and create a key" : "save settings"}
        </button>
      </form>
      </div>
    </Card>
  );
}
