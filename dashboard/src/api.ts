/**
 * The one place that knows bunwa's HTTP shape.
 *
 * docs/07 specifies Eden Treaty, so the dashboard gets typed calls with no code
 * generation. That is deferred until the console has screens worth typing:
 * pulling Elysia's client into an empty app buys type safety over calls nobody
 * makes yet. Confined here so adopting it later is one file, which is the same
 * discipline the Baileys port module is under.
 */

/**
 * What the console is allowed to do, from the key it was given.
 *
 * Both of these were first written from imagination and both were wrong:
 * Whoami had nested project/environment objects with slugs, and VirtualDevice
 * had `id`, `phoneNumber` and a `lastSeenAt` that does not exist. The console
 * rendered "undefined / undefined" against a live API.
 *
 * That is precisely the drift Eden Treaty exists to make impossible, and
 * deferring it produced the bug inside one commit. Until the api-types build
 * artefact docs/07 describes exists, these are transcribed from the routes and
 * pinned by a contract test in the API suite, so drift fails there rather than
 * in a browser.
 */
export interface Whoami {
  projectId: string;
  environmentId: string;
  scopes: string[];
}

export interface VirtualDevice {
  virtualDeviceId: string;
  alias: string;
  status: string;
  scopes: string[];
  msisdn: string | null;
  deviceState: string;
}

/**
 * What claiming a number can produce.
 *
 * Three outcomes, and docs/07 is explicit that they must feel like one flow.
 * The third is the one that matters: the delay is a person deciding, not a
 * system being slow, and a UI that renders it as a spinner teaches the wrong
 * thing.
 */
export type ClaimOutcome = "pending_pairing" | "active" | "awaiting_confirmation";

export interface ClaimResult {
  outcome: ClaimOutcome;
  virtualDevice: { id: string; alias: string };
  pairing?: {
    method: string;
    qr?: string;
    pairCode?: string;
    expiresAt: string;
  };
  message?: string;
}

/**
 * A queued webhook delivery.
 *
 * Transcribed from a live response, not from the schema and not from memory —
 * the first two types in this file were invented and both were wrong. Pinned by
 * the contract test in the API suite.
 */
export interface Delivery {
  id: string;
  eventId: string;
  eventType: string;
  state: "pending" | "delivered" | "failed" | "dead";
  attemptCount: number;
  nextAttemptAt: string;
  deliveredAt: string | null;
  createdAt: string;
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

/** A conversation, as the console lists it. */
export interface ChatThread {
  id: string;
  deviceId: string;
  alias: string;
  peerJid: string;
  displayName: string | null;
  lastMessageAt: string | null;
  unreadCount: number;
}

/** One message in a conversation. */
export interface ChatMessage {
  id: string;
  direction: "inbound" | "outbound";
  kind: string;
  body: string | null;
  mediaId: string | null;
  status: string | null;
  occurredAt: string;
}

export const api = {
  whoami: (key: string) => call<Whoami>("/v1/whoami", key),
  devices: (key: string) => call<VirtualDevice[]>("/v1/devices", key),
  deliveries: (key: string, limit = 20) =>
    call<Delivery[]>(`/v1/deliveries?limit=${String(limit)}`, key),
  replay: (key: string, id: string) =>
    call<unknown>(`/v1/deliveries/${encodeURIComponent(id)}/replay`, key, { method: "POST" }),
  chats: (key: string) => call<ChatThread[]>("/v1/chats", key),
  chatMessages: (key: string, threadId: string) =>
    call<ChatMessage[]>(`/v1/chats/${encodeURIComponent(threadId)}/messages`, key),
  markChatRead: (key: string, threadId: string) =>
    call<null>(`/v1/chats/${encodeURIComponent(threadId)}/read`, key, { method: "POST" }),
  reply: (key: string, threadId: string, text: string) =>
    call<{ id: string | null; status: string }>(
      `/v1/chats/${encodeURIComponent(threadId)}/messages`,
      key,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      },
    ),
  claim: (key: string, msisdn: string, alias: string) =>
    call<ClaimResult>("/v1/devices/claim", key, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ msisdn, alias }),
    }),
};
