/**
 * A labelled input.
 *
 * Exists so every form in the console has its label wired to its control the
 * same way. The tests query by label text, which only works when that
 * association is real rather than visual.
 */
import { useId, useState } from "react";
import { Eye, EyeOff } from "lucide-react";

export function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
  hint,
  mono = false,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  type?: string;
  /** A field the operator may read but not change — see `hint` for why. */
  disabled?: boolean;
  /** Why the field is as it is. Announced with the input, not merely near it. */
  hint?: string;
  /** For values read character by character: keys, ids, timezone names. */
  mono?: boolean;
}) {
  /*
   * A masked field must be readable on demand.
   *
   * The API key input is restored from storage, so it arrives already filled
   * with a credential the operator did not just type — and with no way to see
   * it, a key left over from a replaced database is indistinguishable from the
   * right one. That is not hypothetical: it cost an afternoon. Connecting
   * failed, the field looked filled, and the only way to find out that the
   * dots were the wrong key was to clear them and start again.
   *
   * Default hidden, because the common case is a credential on a screen
   * somebody else can see.
   */
  const [revealed, setRevealed] = useState(false);
  const maskable = type === "password";
  const effectiveType = maskable && revealed ? "text" : type;

  const hintId = useId();

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>

      <div className="relative flex items-center">
        <input
          id={id}
          type={effectiveType}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          aria-describedby={hint === undefined ? undefined : hintId}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          className={`w-full rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:disabled:bg-slate-800 ${
            maskable ? "pr-10" : ""
          } ${mono || (maskable && revealed) ? "font-mono" : ""}`}
        />

        {maskable && (
          <button
            type="button"
            // The label says what pressing it will do, not what the state is:
            // a screen reader user needs the action, and "hidden" alone does
            // not say whether pressing changes that.
            aria-label={revealed ? `hide ${label}` : `show ${label}`}
            aria-pressed={revealed}
            onClick={() => {
              setRevealed((current) => !current);
            }}
            className="absolute right-1 grid size-8 place-items-center rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
          >
            {revealed ? <EyeOff aria-hidden size={15} /> : <Eye aria-hidden size={15} />}
          </button>
        )}
      </div>

      {hint !== undefined && (
        <p id={hintId} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
    </div>
  );
}
