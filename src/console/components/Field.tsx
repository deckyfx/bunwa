/**
 * A labelled input.
 *
 * Exists so every form in the console has its label wired to its control the
 * same way. The tests query by label text, which only works when that
 * association is real rather than visual.
 */
export function Field({
  id,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  disabled = false,
  hint,
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
}) {
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-slate-700 dark:text-slate-300">
        {label}
      </label>
      <input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(e) => {
          onChange(e.target.value);
        }}
        className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-slate-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:disabled:bg-slate-800"
      />
      {hint !== undefined && (
        <p id={`${id}-hint`} className="text-xs text-slate-500">
          {hint}
        </p>
      )}
    </div>
  );
}
