/**
 * Choosing a timezone.
 *
 * A free-text box was wrong: IANA names are exact, `Asia/Jakarta` and
 * `Asia/Jakata` look identical in a hurry, and the only feedback for a typo
 * was a rejected save. The list comes from `Intl.supportedValuesOf`, so it is
 * whatever this browser actually knows rather than a hardcoded set that drifts
 * from the runtime validating it.
 *
 * A `datalist` rather than a `select` because there are several hundred zones:
 * typing "jak" to narrow is the only usable interaction at that size, and it
 * still accepts a value the browser does not list — the server validates
 * either way, and a browser that knows fewer zones than the server should not
 * be able to stop an operator setting one.
 */
import { useEffect, useMemo, useState } from "react";
import { LocateFixed } from "lucide-react";

import { renderDateTime } from "../../time/render";

/**
 * Every zone this runtime knows, or a small fallback.
 *
 * `Intl.supportedValuesOf` is recent enough to be missing somewhere. The
 * fallback is deliberately short — enough to be useful, not a second list
 * pretending to be complete — because the field still accepts free text.
 */
function knownZones(): string[] {
  const intl = Intl as { supportedValuesOf?: (key: string) => string[] };
  try {
    const zones = intl.supportedValuesOf?.("timeZone");
    if (zones !== undefined && zones.length > 0) return zones;
  } catch {
    // Older engine, or a locked-down one. Fall through.
  }
  return ["UTC", "Asia/Jakarta", "Asia/Singapore", "Asia/Tokyo", "Europe/London", "America/New_York"];
}

/**
 * The zone this browser is set to.
 *
 * Offered rather than applied. It is a good guess — an operator usually runs
 * the console from somewhere near the deployment — but only a guess: a server
 * in Jakarta administered from London wants Jakarta, and silently filling in
 * London would be wrong in a way nobody notices until a timestamp is read.
 */
function browserZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** Whether the runtime can actually format in this zone. */
function usable(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export function TimezoneField({
  id,
  value,
  onChange,
  disabled = false,
  hint,
}: {
  id: string;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  hint?: string;
}) {
  const zones = useMemo(knownZones, []);
  const [now, setNow] = useState(() => new Date());

  // The clock is the confirmation. An operator picking a zone is really asking
  // "will the logs read the way I expect?", and the name alone does not answer
  // that — Asia/Jakarta and Asia/Bangkok are the same offset, and a wrong
  // continent is obvious the moment the hour is shown.
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(new Date());
    }, 1_000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const valid = value.trim() !== "" && usable(value.trim());
  const detected = browserZone();
  const offerDetected = !disabled && detected !== null && detected !== value.trim();

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <label htmlFor={id} className="text-sm font-medium text-slate-700 dark:text-slate-300">
          Server timezone
        </label>

        {offerDetected && (
          <button
            type="button"
            onClick={() => {
              onChange(detected);
            }}
            className="inline-flex items-center gap-1 text-xs text-sky-700 hover:underline dark:text-sky-400"
          >
            <LocateFixed aria-hidden size={12} />
            use {detected}
          </button>
        )}
      </div>

      <input
        id={id}
        list={`${id}-zones`}
        value={value}
        disabled={disabled}
        placeholder="Asia/Jakarta"
        aria-describedby={`${id}-hint`}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 font-mono text-sm outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:disabled:bg-slate-800"
      />

      <datalist id={`${id}-zones`}>
        {zones.map((zone) => (
          <option key={zone} value={zone} />
        ))}
      </datalist>

      <p id={`${id}-hint`} className="text-xs text-slate-500">
        {valid ? (
          <>
            <span className="font-mono text-slate-600 dark:text-slate-400">{renderDateTime(now, value.trim())}</span>
            {" — "}
          </>
        ) : value.trim() === "" ? null : (
          <span className="text-amber-700 dark:text-amber-500">not a zone this browser knows — </span>
        )}
        {hint}
      </p>
    </div>
  );
}
