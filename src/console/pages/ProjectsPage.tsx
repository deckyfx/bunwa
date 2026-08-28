/**
 * Projects, and the keys that reach them.
 *
 * The operator's screen. A project is a tenant: it has environments, and each
 * environment has keys that sign in to this same console with nothing but that
 * project's devices and conversations visible.
 *
 * The scope that guards this is what separates the two kinds of credential, so
 * this page is the one place in the console where another tenant's existence
 * is visible at all.
 */
import { useEffect, useState } from "react";
import { Check, ChevronRight, Copy, FolderKanban, KeyRound, Plus, ShieldCheck, Trash2 } from "lucide-react";

import { Card, Note } from "../components/Card";
import { Field } from "../components/Field";
import { BOOTSTRAP_PROJECT_SLUG, PROJECT_SCOPE_NAMES } from "../lib/scopes";
import { useProjects } from "../store/projects";
import { useServerTimezone } from "../store/session";
import { renderDateTime } from "../../time/render";

/** The key, shown once, with nothing else competing for attention. */
function MintedKey({ plaintext, label, onDismiss }: { plaintext: string; label: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="mb-4 flex flex-col gap-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950/60">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <ShieldCheck aria-hidden size={16} className="text-emerald-600 dark:text-emerald-500" />
        Key for “{label}”
      </h3>
      <p className="text-sm">
        The only time it will be shown. Send it to whoever needs it before dismissing this — it cannot be
        recovered, only replaced.
      </p>
      <code className="block break-all rounded-md bg-white p-3 font-mono text-sm dark:bg-slate-900">
        {plaintext}
      </code>
      <div className="flex gap-2">
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white dark:bg-slate-100 dark:text-slate-900"
          onClick={() => {
            void navigator.clipboard?.writeText(plaintext).then(
              () => {
                setCopied(true);
              },
              () => {
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
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
        >
          I have sent it
        </button>
      </div>
    </div>
  );
}

/** Create a project. Two fields, because a tenant is not a complicated thing. */
function NewProject() {
  const { busy, createProject } = useProjects();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setOpen(true);
        }}
        className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
      >
        <Plus aria-hidden size={14} />
        New project
      </button>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
      onSubmit={(e) => {
        e.preventDefault();
        void createProject(slug, displayName).then((ok) => {
          if (!ok) return;
          setSlug("");
          setDisplayName("");
          setOpen(false);
        });
      }}
    >
      <Field
        id="project-slug"
        label="Slug"
        value={slug}
        onChange={setSlug}
        mono
        placeholder="acme"
        hint="Appears in every key this project issues, as bw_live_<slug>_… — so a leaked key names its owner at a glance."
      />
      <Field
        id="project-name"
        label="Display name"
        value={displayName}
        onChange={setDisplayName}
        placeholder="Acme Corp"
      />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? "creating…" : "create"}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm dark:border-slate-700"
        >
          cancel
        </button>
      </div>
    </form>
  );
}

/** The keys in one environment, and the form that mints another. */
function Keys({ projectId, environmentId }: { projectId: string; environmentId: string }) {
  const { keys, busy, createKey, revokeKey } = useProjects();
  const zone = useServerTimezone();

  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["send:text", "receive:messages"]);

  if (keys === null) return <Note>loading keys…</Note>;

  return (
    <div className="flex flex-col gap-4">
      {keys.length === 0 ? (
        <Note>No keys yet. This project cannot sign in until one exists.</Note>
      ) : (
        <ul className="flex flex-col gap-1.5">
          {keys.map((key) => (
            <li
              key={key.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-2 text-sm dark:border-slate-800"
            >
              <div className="min-w-0">
                <p className="flex items-center gap-2">
                  <KeyRound aria-hidden size={13} className="shrink-0 text-slate-400" />
                  <span className="font-mono text-xs">{key.keyPrefix}…</span>
                  <span className="truncate text-slate-500">{key.label}</span>
                </p>
                <p className="mt-0.5 text-xs text-slate-400">
                  {key.revokedAt === null ? "active" : "revoked"} · {key.scopes.join(", ") || "no scopes"} ·{" "}
                  {renderDateTime(new Date(key.createdAt), zone)}
                </p>
              </div>

              {key.revokedAt === null && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    void revokeKey(projectId, environmentId, key.id);
                  }}
                  className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-slate-500 hover:bg-rose-50 hover:text-rose-700 disabled:opacity-40 dark:hover:bg-rose-950 dark:hover:text-rose-400"
                >
                  <Trash2 aria-hidden size={13} />
                  revoke
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      <form
        className="flex flex-col gap-3 rounded-lg border border-slate-200 p-3 dark:border-slate-800"
        onSubmit={(e) => {
          e.preventDefault();
          void createKey(projectId, environmentId, label, scopes);
          setLabel("");
        }}
      >
        <Field id="key-label" label="New key" value={label} onChange={setLabel} placeholder="acme production" />

        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-xs font-medium text-slate-600 dark:text-slate-400">Scopes</legend>
          {/* Only project scopes are offered, and the server refuses the rest
              anyway: a key created here must never be able to create further
              tenants or rename the deployment. */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {PROJECT_SCOPE_NAMES.map((scope) => (
              <label key={scope} className="flex items-center gap-1.5 text-xs">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  onChange={(e) => {
                    setScopes((current) =>
                      e.target.checked ? [...current, scope] : current.filter((s) => s !== scope),
                    );
                  }}
                />
                <span className="font-mono">{scope}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <button
          type="submit"
          disabled={busy || label.trim() === ""}
          className="self-start rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40 dark:bg-slate-100 dark:text-slate-900"
        >
          {busy ? "creating…" : "create key"}
        </button>
      </form>
    </div>
  );
}

export function ProjectsPage() {
  const { projects, openId, environments, keysFor, error, mintedKey, load, open, loadKeys, dismissKey } =
    useProjects();

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <Card id="projects" title="Projects" icon={FolderKanban} action={<NewProject />}>
      {mintedKey !== null && (
        <MintedKey plaintext={mintedKey.plaintext} label={mintedKey.label} onDismiss={dismissKey} />
      )}

      {error !== null && <Note tone="bad">{error}</Note>}

      {projects === null ? (
        error === null ? (
          <Note>loading…</Note>
        ) : null
      ) : projects.length === 0 ? (
        <Note>No projects yet.</Note>
      ) : (
        <ul className="flex flex-col gap-2">
          {projects.map((project) => (
            <li key={project.id} className="rounded-lg border border-slate-200 dark:border-slate-800">
              <button
                type="button"
                aria-expanded={openId === project.id}
                onClick={() => {
                  void open(openId === project.id ? null : project.id);
                }}
                className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50"
              >
                <ChevronRight
                  aria-hidden
                  size={14}
                  className={`shrink-0 text-slate-400 transition-transform ${openId === project.id ? "rotate-90" : ""}`}
                />
                <span className="font-medium">{project.displayName}</span>
                <span className="font-mono text-xs text-slate-500">{project.slug}</span>
                {project.slug === BOOTSTRAP_PROJECT_SLUG && (
                  // Marked, because it is not a tenant anyone created. Every
                  // instance has one: a key must belong to an environment, so
                  // one has to exist before setup can mint the operator's own.
                  <span
                    title="Created automatically. It holds the operator key, because a key must belong to an environment."
                    className="rounded bg-slate-100 px-1.5 py-px text-[10px] font-medium text-slate-600 dark:bg-slate-800 dark:text-slate-400"
                  >
                    instance
                  </span>
                )}
                {project.status !== "active" && (
                  <span className="rounded bg-amber-100 px-1.5 py-px text-[10px] text-amber-800 dark:bg-amber-950 dark:text-amber-300">
                    {project.status}
                  </span>
                )}
              </button>

              {openId === project.id && (
                <div className="border-t border-slate-100 p-3 dark:border-slate-800">
                  {environments === null ? (
                    <Note>loading environments…</Note>
                  ) : environments.length === 0 ? (
                    <Note>No environments. This project cannot issue keys until it has one.</Note>
                  ) : (
                    <div className="flex flex-col gap-3">
                      <div className="flex flex-wrap gap-1.5">
                        {environments.map((environment) => (
                          <button
                            key={environment.id}
                            type="button"
                            aria-current={keysFor === environment.id ? "true" : undefined}
                            onClick={() => {
                              void loadKeys(project.id, environment.id);
                            }}
                            className="rounded-md border border-slate-200 px-2.5 py-1 text-xs aria-[current=true]:border-slate-900 aria-[current=true]:bg-slate-900 aria-[current=true]:text-white dark:border-slate-700 dark:aria-[current=true]:border-slate-100 dark:aria-[current=true]:bg-slate-100 dark:aria-[current=true]:text-slate-900"
                          >
                            {environment.slug}
                            <span className="ml-1.5 opacity-60">{environment.kind}</span>
                          </button>
                        ))}
                      </div>

                      {keysFor !== null && <Keys projectId={project.id} environmentId={keysFor} />}
                    </div>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
