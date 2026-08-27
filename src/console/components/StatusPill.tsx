/**
 * A device or message state, coloured.
 *
 * The one thing worth distinguishing at a glance on an operator screen, so it
 * gets the only strong colours in the console. Everything unrecognised is grey
 * rather than hidden: a state we have not styled is still a state, and
 * dropping it would make an unknown device look like no device.
 */
const TONE: Record<string, string> = {
  connected: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  active: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  delivered: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  read: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  pairing: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  pending_pairing: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  pending_consent: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  disconnected: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  logged_out: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  failed: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  undelivered: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
};

export function StatusPill({ state }: { state: string }) {
  const tone = TONE[state] ?? "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300";
  return (
    <span className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>
      {state}
    </span>
  );
}
