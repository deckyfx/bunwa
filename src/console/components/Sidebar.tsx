/**
 * The left panel.
 *
 * Every screen used to be stacked down one column, so finding the deliveries
 * table meant scrolling past three other sections and the conversation list
 * had whatever height was left over. Navigation turns them into places rather
 * than a pile, and gives the chat view the full height it actually needs.
 *
 * A real `<nav>` with `aria-current`, not a row of styled divs: this is the
 * primary way around the console, and it has to be reachable by keyboard and
 * announced as navigation.
 */
import type { LucideIcon } from "lucide-react";
import {
  FolderKanban,
  LogOut,
  MessagesSquare,
  PlusCircle,
  Send,
  SlidersHorizontal,
  Smartphone,
} from "lucide-react";

import { ThemeToggle } from "./ThemeToggle";

export type SectionId = "claim" | "devices" | "chats" | "deliveries" | "projects" | "settings";

/**
 * Every section, and the scope that makes it worth showing.
 *
 * A section whose scope the key lacks is hidden rather than shown and refused.
 * Both are honest, but one wastes a click and reports a 403 for something the
 * operator was invited to press — and this console is now used by two very
 * different credentials, so the difference is most of the experience for one
 * of them.
 *
 * Hiding is not the security boundary. Every route checks the scope itself;
 * this only decides what is offered.
 */
/**
 * Which credential a section belongs to.
 *
 * The two are not a hierarchy — an admin key cannot read a project's
 * conversations and a project key cannot rename the instance — so they are
 * shown as separate groups rather than one list with some entries greyed out.
 * A single list implied the operator was one grant away from everything on it,
 * which was true when level was a scope and is not true now.
 */
export type SectionLevel = "admin" | "tenant";

export interface Section {
  id: SectionId;
  label: string;
  icon: LucideIcon;
  level: SectionLevel;
  scope?: string;
}

export const SECTIONS: Section[] = [
  // Instance-level. What an operator manages: who the tenants are, what
  // credentials exist, and the values shared by every project on the box.
  { id: "projects", label: "Projects", icon: FolderKanban, level: "admin", scope: "manage:projects" },
  { id: "settings", label: "Settings", icon: SlidersHorizontal, level: "admin", scope: "manage:instance" },

  // Project-level. What a tenant does with the number it holds.
  { id: "devices", label: "Devices", icon: Smartphone, level: "tenant" },
  { id: "claim", label: "Claim a number", icon: PlusCircle, level: "tenant", scope: "manage:devices" },
  { id: "chats", label: "Conversations", icon: MessagesSquare, level: "tenant" },
  { id: "deliveries", label: "Deliveries", icon: Send, level: "tenant" },
];

/** What each group is called where it is shown. */
/**
 * What each group is called on screen.
 *
 * "tenant" is the credential's word and "Project" is the operator's. The type
 * uses the former so it cannot drift from the level a key actually has; this
 * maps it to the latter, because nobody signing in thinks of themselves as a
 * tenant.
 */
export const LEVEL_LABEL: Record<SectionLevel, string> = {
  admin: "Instance",
  tenant: "Project",
};

/**
 * The sections this credential should be offered.
 *
 * Filtered by level first and scope second, because they answer different
 * questions: the level is what the key *is* and cannot be granted around, the
 * scope is what it may do. An admin key with every scope still gets no
 * Conversations, because there is no project whose conversations they would
 * be.
 *
 * Hiding is not the security boundary — every route checks for itself. This
 * only decides what is worth offering.
 */
export const sectionsFor = (level: SectionLevel, scopes: string[]): Section[] =>
  SECTIONS.filter(
    (section) => section.level === level && (section.scope === undefined || scopes.includes(section.scope)),
  );

export function Sidebar({
  active,
  onSelect,
  onSignOut,
  identity,
  level,
  scopes,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
  onSignOut: () => void;
  level: SectionLevel;
  scopes: string[];
  identity: {
    projectId: string;
    environmentId: string;
    projectName: string;
    environmentSlug: string;
  } | null;
}) {
  const sections = sectionsFor(level, scopes);

  return (
    <aside className="flex w-56 shrink-0 flex-col justify-between border-r border-slate-200 bg-white/50 dark:border-slate-800 dark:bg-slate-900/30">
      <nav aria-label="Sections" className="flex flex-col gap-0.5 p-2">
        {/* Headed even though only one group is ever shown, because which one
            is the thing an operator most needs to know: the same console with
            the same layout does very different things depending on which key
            opened it, and an unlabelled list gives no clue which. */}
        <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
          {LEVEL_LABEL[level]}
        </p>
        {sections.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            // aria-current rather than only a background colour: "which page
            // am I on" must be answerable without seeing the styling.
            aria-current={active === id ? "page" : undefined}
            onClick={() => {
              onSelect(id);
            }}
            className="flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm text-slate-600 hover:bg-slate-100 aria-[current=page]:bg-slate-900 aria-[current=page]:font-medium aria-[current=page]:text-white dark:text-slate-400 dark:hover:bg-slate-800 dark:aria-[current=page]:bg-slate-100 dark:aria-[current=page]:text-slate-900"
          >
            <Icon aria-hidden size={16} />
            {label}
          </button>
        ))}
      </nav>

      <div className="flex flex-col gap-1 border-t border-slate-200 p-2 dark:border-slate-800">
        {identity !== null && (
          // The name for reading, the ids on hover for quoting. A bare UUID
          // here answered a question nobody was asking; the id still has to be
          // recoverable, because it is what a support ticket or an API call
          // needs.
          <p
            className="truncate px-2 pb-1 text-[11px] text-slate-400"
            title={`project ${identity.projectId}\nenvironment ${identity.environmentId}`}
          >
            {identity.projectName} / {identity.environmentSlug}
          </p>
        )}

        <ThemeToggle withLabel />

        <button
          type="button"
          onClick={onSignOut}
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-slate-600 hover:bg-rose-50 hover:text-rose-700 dark:text-slate-400 dark:hover:bg-rose-950 dark:hover:text-rose-400"
        >
          <LogOut aria-hidden size={15} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
