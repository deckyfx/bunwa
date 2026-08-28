/**
 * A titled panel.
 *
 * Every screen was a bordered box with an `<h2>` inside it, written out five
 * times with five slightly different paddings and heading sizes. Nothing was
 * wrong with any of them individually; together they made the page read as a
 * stack of unrelated fragments rather than one console.
 *
 * The icon is not decoration. These sections are scanned rather than read —
 * an operator is looking for the devices table, not reading the page top to
 * bottom — and a shape is found faster than a word. It is `aria-hidden`
 * because the heading beside it already says the same thing, and announcing
 * both is noise for anyone listening rather than looking.
 */
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

export function Card({
  id,
  title,
  icon: Icon,
  action,
  children,
  className = "",
}: {
  /** Also the heading's id, so the section can be labelled by it. */
  id: string;
  title: string;
  icon: LucideIcon;
  /** A control belonging to the section, shown in its header. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      aria-labelledby={id}
      className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/40 ${className}`}
    >
      <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 dark:border-slate-800">
        <h2 id={id} className="flex items-center gap-2 text-sm font-semibold tracking-tight">
          <Icon aria-hidden size={16} className="text-slate-400" />
          {title}
        </h2>
        {action}
      </header>

      <div className="p-4">{children}</div>
    </section>
  );
}

/**
 * The empty, loading and error states, so they look the same everywhere.
 *
 * They were written per page and drifted: some said "loading…", one rendered
 * nothing at all while it loaded, and a failure looked different on every
 * screen. A console whose states are inconsistent teaches an operator to
 * distrust all of them.
 */
export function Note({ children, tone = "quiet" }: { children: ReactNode; tone?: "quiet" | "bad" }) {
  return (
    <p
      role={tone === "bad" ? "alert" : undefined}
      className={
        tone === "bad"
          ? "text-sm text-rose-700 dark:text-rose-400"
          : "text-sm text-slate-500 dark:text-slate-400"
      }
    >
      {children}
    </p>
  );
}
