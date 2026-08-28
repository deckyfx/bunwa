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

import { client } from "../lib/api";
import { useSession } from "./session";

export interface Project {
  id: string;
  slug: string;
  displayName: string;
  status: string;
}

export interface Environment {
  id: string;
  slug: string;
  kind: string;
  status: string;
}

export interface KeySummary {
  id: string;
  label: string;
  keyPrefix: string;
  scopes: string[];
  revokedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

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
    if (error !== null || data === null) {
      set({ error: messageFrom(error), projects: null });
      return;
    }
    set({ projects: data as Project[], error: null });
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
    if (error !== null || data === null) {
      set({ error: messageFrom(error) });
      return;
    }

    const environments = data as Environment[];
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

    if (error !== null || data === null) {
      set({ error: messageFrom(error) });
      return;
    }
    set({ keys: data as unknown as KeySummary[], error: null });
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

    const minted = data as unknown as { key: string; label: string };
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
