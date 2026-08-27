/**
 * A device or message state, coloured and marked.
 *
 * The one thing worth distinguishing at a glance on an operator screen, so it
 * gets the only strong colours in the console. Everything unrecognised is grey
 * rather than hidden: a state we have not styled is still a state, and
 * dropping it would make an unknown device look like no device.
 *
 * The icon is not decoration. Colour was carrying the whole distinction, and
 * three of these four tones are the red/green pair that the commonest form of
 * colour blindness cannot separate — on a screen whose entire job is telling
 * `delivered` from `failed` at a glance. A shape alongside the colour is what
 * WCAG 1.4.1 asks for and what docs/07 already committed this console to.
 */
import { Circle, CircleCheck, Clock, TriangleAlert } from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface Tone {
  className: string;
  Icon: LucideIcon;
}

const OK: Tone = {
  className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300",
  Icon: CircleCheck,
};
const WAITING: Tone = {
  className: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  Icon: Clock,
};
const BAD: Tone = {
  className: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-300",
  Icon: TriangleAlert,
};
const UNKNOWN: Tone = {
  className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  Icon: Circle,
};

const TONE: Record<string, Tone> = {
  connected: OK,
  active: OK,
  delivered: OK,
  read: OK,
  pairing: WAITING,
  pending: WAITING,
  pending_pairing: WAITING,
  pending_consent: WAITING,
  disconnected: BAD,
  logged_out: BAD,
  failed: BAD,
  undelivered: BAD,
};

export function StatusPill({ state }: { state: string }) {
  const { className, Icon } = TONE[state] ?? UNKNOWN;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}
    >
      {/* Hidden from the accessibility tree: the state is already the text
          beside it, and announcing "circle check, delivered" reads the same
          fact twice. The icon is here for the eye, not the screen reader. */}
      <Icon aria-hidden size={12} strokeWidth={2.5} />
      {state}
    </span>
  );
}
