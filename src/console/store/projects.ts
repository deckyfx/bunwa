/**
 * Projects, their environments, and the keys that reach them.
 *
 * The operator's side of the tenant model. A key without `manage:projects`
 * cannot load any of this, and the section that shows it is not offered — but
 * the store still reports a refusal honestly rather than rendering an empty
 * list, because "no projects" and "you may not see the projects" are different
 * answers and only one of them is a reason to create one.
 */
import { create } from "zustand";

import { client, type RowOf } from "../lib/api";
import { useSession } from "./session";

type Api = ReturnType<typeof client>;
type Admin = Api["admin"]["v1"];

/**
 * Derived from the admin routes, not declared here.
 *
 * These were three hand-written interfaces read through `as` casts, which is
 * the arrangement that has now been wrong four times on this project — a cast
 * cannot notice the server dropping a field, so the console reads `undefined`
 * and renders a blank cell rather than failing to compile. Every one of them
 * is a compile error now if the route changes shape.
 */
export type Project = RowOf<Awaited<ReturnType<Admin["projects"]["get"]>>>;
export type Environment = RowOf<Awaited<ReturnType<ReturnType<Admin["projects"]>["environments"]["get"]>>>;
export type KeySummary = RowOf<
  Awaited<ReturnType<ReturnType<ReturnType<Admin["projects"]>["environments"]>["api-keys"]["get"]>>
>;

interface ProjectsState {
  projects: Project[] | null;
  /** The project whose detail is open, if any. */
  openId: string | null;
  environments: Environment[] | null;
  /** Keys for the environment currently being looked at. */
  keys: KeySummary[] | null;
  keysFor: string | null;
  busy: boolean;
  error: string | null;
  /** A freshly minted key, shown once and held in memory only. */
  mintedKey: { plaintext: string; label: string } | null;

  load: () => Promise<void>;
  createProject: (slug: string, displayName: string) => Promise<boolean>;
  open: (projectId: string | null) => Promise<void>;
  loadKeys: (projectId: string, environmentId: string) => Promise<void>;
  createKey: (projectId: string, environmentId: string, label: string, scopes: string[]) => Promise<void>;
  revokeKey: (projectId: string, environmentId: string, keyId: string) => Promise<void>;
  dismissKey: () => void;
}

const api = () => client(useSession.getState().apiKey);

/** Say what the server said, and name the one failure that has a specific fix. */
const messageFrom = (error: { status?: unknown; value?: unknown } | null): string => {
  const value = error?.value;
  if (typeof value === "object" && value !== null) {
    for (const field of ["detail", "message"] as const) {
      const text = (value as Record<string, unknown>)[field];
      if (typeof text === "string") return text;
    }
  }
  if (error?.status === 403) return "this key lacks the manage:projects scope";
  if (error?.status === 404) return "the admin API is not enabled on this deployment (ADMIN_API_ENABLED)";
  if (typeof error?.status !== "number") return "could not reach the server";
  return `the server rejected that (${String(error.status)})`;
};

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: null,
  openId: null,
  environments: null,
  keys: null,
  keysFor: null,
  busy: false,
  error: null,
  mintedKey: null,

  load: async () => {
    const { data, error } = await api().admin.v1.projects.get();
    // `Array.isArray` as well as the error check: Eden types `data` as the
    // union of the body and a raw Response, so narrowing is what makes the
    // derived row type mean anything.
    if (error !== null || !Array.isArray(data)) {
      set({ error: messageFrom(error), projects: null });
      return;
    }
    set({ projects: data, error: null });
  },

  createProject: async (slug, displayName) => {
    set({ busy: true, error: null });
    const { error } = await api().admin.v1.projects.post({ slug: slug.trim(), displayName: displayName.trim() });

    if (error !== null) {
      set({ busy: false, error: messageFrom(error) });
      return false;
    }

    set({ busy: false, error: null });
    await get().load();
    return true;
  },

  open: async (projectId) => {
    if (projectId === null) {
      set({ openId: null, environments: null, keys: null, keysFor: null });
      return;
    }

    set({ openId: projectId, environments: null, keys: null, keysFor: null, error: null });

    const { data, error } = await api().admin.v1.projects({ projectId }).environments.get();

    // Dropped if the operator has opened a different project since. The
    // request for A can settle after the request for B, and storing it then
    // put A's environments under B's name and went on to load A's keys.
    if (get().openId !== projectId) return;

    if (error !== null || !Array.isArray(data)) {
      set({ error: messageFrom(error) });
      return;
    }

    const environments = data;
    set({ environments });

    // Open the first environment's keys straight away. Every project has one
    // in practice, and making the operator click twice to see the thing they
    // came for is the kind of step that gets built and then never removed.
    const first = environments[0];
    if (first !== undefined) await get().loadKeys(projectId, first.id);
  },

  loadKeys: async (projectId, environmentId) => {
    set({ keys: null, keysFor: environmentId });

    const { data, error } = await api()
      .admin.v1.projects({ projectId })
      .environments({ environmentId })["api-keys"].get();

    // The environment the operator is looking at now, not the one this call
    // was made for — the same race one level down.
    if (get().keysFor !== environmentId) return;

    if (error !== null || !Array.isArray(data)) {
      set({ error: messageFrom(error) });
      return;
    }
    set({ keys: data, error: null });
  },

  createKey: async (projectId, environmentId, label, scopes) => {
    set({ busy: true, error: null });

    const { data, error } = await api()
      .admin.v1.projects({ projectId })
      .environments({ environmentId })
      ["api-keys"].post({ label: label.trim(), scopes });

    if (error !== null || data === null) {
      set({ busy: false, error: messageFrom(error) });
      return;
    }

    // Narrowed rather than asserted: the mint route answers with the key, and
    // a cast here would hide the server renaming that field — which the
    // operator would meet as an undefined credential in a "copy this now"
    // dialog they cannot get back.
    if (!("key" in data) || typeof data.key !== "string") {
      set({ busy: false, error: "the server did not return a key" });
      return;
    }
    const minted = data;
    // In memory only, and never written to storage: this is the operator
    // holding someone else's credential for as long as it takes to send it on.
    set({ busy: false, error: null, mintedKey: { plaintext: minted.key, label: minted.label } });
    await get().loadKeys(projectId, environmentId);
  },

  revokeKey: async (projectId, environmentId, keyId) => {
    set({ busy: true, error: null });

    const { error } = await api()
      .admin.v1.projects({ projectId })
      .environments({ environmentId })["api-keys"]({ keyId })
      .delete();

    if (error !== null) {
      set({ busy: false, error: messageFrom(error) });
      return;
    }

    set({ busy: false });
    await get().loadKeys(projectId, environmentId);
  },

  dismissKey: () => {
    set({ mintedKey: null });
  },
}));
