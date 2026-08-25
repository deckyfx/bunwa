/**
 * The one place that knows bunwa's HTTP shape.
 *
 * docs/07 specifies Eden Treaty, so the dashboard gets typed calls with no code
 * generation. That is deferred until the console has screens worth typing:
 * pulling Elysia's client into an empty app buys type safety over calls nobody
 * makes yet. Confined here so adopting it later is one file, which is the same
 * discipline the Baileys port module is under.
 */

/** What the console is allowed to do, from the key it was given. */
export interface Whoami {
  project: { id: string; slug: string };
  environment: { id: string; slug: string };
  scopes: string[];
}

export interface VirtualDevice {
  id: string;
  alias: string;
  status: string;
  phoneNumber: string | null;
  lastSeenAt: string | null;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * One fetch wrapper, so failures arrive as a type rather than as a surprise.
 *
 * The API answers errors as RFC 9457 problem details. Reading `title` and
 * `detail` from them is the difference between a console that says "the key is
 * not valid" and one that says "Failed to fetch".
 */
async function call<T>(path: string, key: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...init.headers, "x-api-key": key },
  });

  if (!response.ok) {
    let title = response.statusText;
    let detail: string | null = null;
    try {
      const problem = (await response.json()) as { title?: string; detail?: string };
      title = problem.title ?? title;
      detail = problem.detail ?? null;
    } catch {
      // Not a problem document. The status is still the useful part, and
      // throwing here would replace a real error with a parse error.
    }
    throw new ApiError(title, response.status, detail);
  }

  return (await response.json()) as T;
}

export const api = {
  whoami: (key: string) => call<Whoami>("/v1/whoami", key),
  devices: (key: string) => call<VirtualDevice[]>("/v1/devices", key),
};
