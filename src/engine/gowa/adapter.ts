/**
 * The gowa engine adapter.
 *
 * Speaks gowa's HTTP API over container loopback, against an unmodified image
 * (ADR-0007). Everything gowa does not provide, this manufactures:
 *
 * - **Lifecycle events.** gowa forwards none by webhook. A poller drives the
 *   reconciler, which emits the transitions (docs/12).
 * - **Media URLs.** Inbound media arrives as a path inside gowa's container;
 *   the adapter turns it into a URL bunwa can fetch.
 * - **Error classification.** gowa panics on error paths and the recovery
 *   middleware renders one opaque 500 with prose. Unrecognised failures are
 *   treated as retryable, because guessing "fatal" drops a message that a
 *   retry would have delivered.
 */
import {
  EngineError,
  type DeviceEngine,
  type DeviceStatus,
  type EngineEvent,
  type PairingMethod,
  type PairingSession,
  type SendAction,
  type SendResult,
} from "../types";
import { INITIAL_MEMORY, reconcile, type DeviceMemory } from "./reconciler";
import { log } from "../../observability/logger";

export interface GowaAdapterOptions {
  /** Base URL, e.g. http://127.0.0.1:3100 — loopback inside the container. */
  baseUrl: string;
  /** How often to poll each device's status. */
  pollIntervalMs?: number;
  /** Per-request timeout. */
  requestTimeoutMs?: number;
  /** Injected in tests so no socket is opened. */
  fetchImpl?: typeof fetch;
}

/** gowa's envelope. Every response carries it. */
interface GowaResponse<T> {
  code?: string;
  message?: string;
  results?: T;
}

/**
 * Messages gowa produces for conditions a retry cannot fix.
 *
 * Matched by text because gowa has no error taxonomy — recovered panics all
 * surface as 500 with a prose message. Anything unmatched defaults to
 * retryable, which is the safe direction: a needless retry costs a request, a
 * wrong "fatal" loses a customer's message.
 */
const FATAL_PATTERNS = [/not found/i, /already exists/i, /invalid/i, /malformed/i, /required/i];

export class GowaAdapter implements DeviceEngine {
  readonly kind = "gowa" as const;

  private readonly memories = new Map<string, DeviceMemory>();
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private poller: ReturnType<typeof setTimeout> | undefined;
  private closed = false;

  constructor(private readonly options: GowaAdapterOptions) {}

  async provision(deviceId: string): Promise<void> {
    // gowa returns an error when the slot exists; that is success here, because
    // provision must be idempotent for a retry after a timeout to be safe.
    const response = await this.request<{ id: string }>("POST", "/devices", { device_id: deviceId });
    if (response.code !== "SUCCESS" && !/already/i.test(response.message ?? "")) {
      throw this.toError(response.message ?? "failed to create device");
    }
    if (!this.memories.has(deviceId)) this.memories.set(deviceId, { ...INITIAL_MEMORY });
    this.ensurePolling();
  }

  async startPairing(deviceId: string, method: PairingMethod): Promise<PairingSession> {
    if (method === "code") {
      const result = await this.request<{ pair_code?: string }>(
        "POST",
        `/devices/${encodeURIComponent(deviceId)}/login/code`,
      );
      const code = result.results?.pair_code;
      if (code === undefined) throw this.toError(result.message ?? "no pairing code returned");
      const expiresAt = new Date(Date.now() + 60_000);
      this.emit({ type: "device.pair_code", deviceId, code, expiresAt });
      return { method, pairCode: code, expiresAt };
    }

    // QR arrives in the response body, not on gowa's socket — there is no
    // QRDATA broadcast, contrary to an earlier reading of the source (docs/12).
    const result = await this.request<{ qr_link?: string; qr_duration?: number }>(
      "GET",
      `/devices/${encodeURIComponent(deviceId)}/login`,
    );
    const qr = result.results?.qr_link;
    if (qr === undefined) throw this.toError(result.message ?? "no QR returned");
    const expiresAt = new Date(Date.now() + (result.results?.qr_duration ?? 30) * 1000);
    this.emit({ type: "device.qr", deviceId, qr, expiresAt });
    return { method, qr, expiresAt };
  }

  async logout(deviceId: string): Promise<void> {
    await this.request("POST", `/devices/${encodeURIComponent(deviceId)}/logout`);
  }

  async purge(deviceId: string): Promise<void> {
    await this.request("DELETE", `/devices/${encodeURIComponent(deviceId)}`);
    this.memories.delete(deviceId);
  }

  /**
   * JIDs for every known device, from the list endpoint.
   *
   * The status endpoint returns only the two booleans, so without this the
   * adapter never learns a device's JID — and the reconciler needs it to tell
   * a logout from a device that never paired. The headline event would simply
   * never fire. One call for all devices rather than one per device.
   */
  private async fetchJids(): Promise<Map<string, string | null>> {
    const jids = new Map<string, string | null>();
    try {
      const result = await this.request<Array<{ id?: string; jid?: string }>>("GET", "/devices");
      for (const row of result.results ?? []) {
        if (row.id !== undefined) jids.set(row.id, row.jid === undefined || row.jid === "" ? null : row.jid);
      }
    } catch {
      // A failed list is not fatal: the reconciler keeps the JID it remembers.
    }
    return jids;
  }

  async status(deviceId: string): Promise<DeviceStatus> {
    // /devices/{id}/status, never the /devices list: the list's `state` field
    // was measured reporting "connected" for a slot that had never been paired.
    const result = await this.request<{ is_connected?: boolean; is_logged_in?: boolean }>(
      "GET",
      `/devices/${encodeURIComponent(deviceId)}/status`,
    );
    if (result.results === undefined) throw this.toError(result.message ?? `device ${deviceId} not found`);

    const memory = this.memories.get(deviceId);
    return {
      connected: result.results.is_connected === true,
      loggedIn: result.results.is_logged_in === true,
      jid: memory?.lastKnownJid ?? null,
      pushName: null,
    };
  }

  async send(deviceId: string, action: SendAction): Promise<SendResult> {
    const { path, body, multipart } = this.toGowaSend(action);
    const result = await this.request<{ message_id?: string }>("POST", path, body, {
      deviceId,
      multipart,
    });
    const messageId = result.results?.message_id;
    if (messageId === undefined) throw this.toError(result.message ?? "send failed");
    return { messageId, acceptedAt: new Date() };
  }

  /** Map a SendAction onto gowa's endpoint and payload shape. */
  private toGowaSend(action: SendAction): { path: string; body: Record<string, string>; multipart: boolean } {
    const to = action.to;
    if (action.to.trim() === "") throw new EngineError("recipient is required", false);

    const mediaUrl = (ref: { url: string } | { base64: string; mimeType: string }): string => {
      if ("url" in ref) return ref.url;
      // gowa's *_url fields take a URL; base64 would need a multipart upload,
      // which is deferred rather than silently mishandled.
      throw new EngineError("base64 media is not supported by the gowa engine yet", false);
    };

    switch (action.type) {
      case "text":
        return { path: "/send/message", body: { phone: to, message: action.text }, multipart: false };
      case "link":
        return {
          path: "/send/link",
          body: { phone: to, link: action.url, ...(action.caption === undefined ? {} : { caption: action.caption }) },
          multipart: false,
        };
      case "image":
        return {
          path: "/send/image",
          body: { phone: to, image_url: mediaUrl(action.media), ...(action.caption === undefined ? {} : { caption: action.caption }) },
          multipart: true,
        };
      case "document":
        return {
          path: "/send/file",
          body: { phone: to, file_url: mediaUrl(action.media), ...(action.caption === undefined ? {} : { caption: action.caption }) },
          multipart: true,
        };
      case "audio":
        return { path: "/send/audio", body: { phone: to, audio_url: mediaUrl(action.media) }, multipart: true };
      case "video":
        return {
          path: "/send/video",
          body: { phone: to, video_url: mediaUrl(action.media), ...(action.caption === undefined ? {} : { caption: action.caption }) },
          multipart: true,
        };
    }
  }

  async *subscribe(): AsyncIterable<EngineEvent> {
    const queue: EngineEvent[] = [];
    let wake: (() => void) | null = null;
    const listener = (event: EngineEvent): void => {
      queue.push(event);
      wake?.();
    };
    this.listeners.add(listener);
    try {
      while (!this.closed) {
        while (queue.length > 0) yield queue.shift()!;
        if (this.closed) break;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    } finally {
      this.listeners.delete(listener);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.poller !== undefined) clearTimeout(this.poller);
    this.poller = undefined;
    this.listeners.clear();
  }

  /** One poll of every known device. Exposed so tests need no timer. */
  async pollOnce(now: Date = new Date()): Promise<void> {
    const jids = await this.fetchJids();

    for (const deviceId of [...this.memories.keys()]) {
      let observed: DeviceStatus | null = null;
      try {
        observed = await this.status(deviceId);
        // Overlay the JID from the list: status carries only the booleans, and
        // the reconciler cannot identify a logout without it.
        const known = jids.get(deviceId);
        if (known !== undefined) observed = { ...observed, jid: known };
      } catch {
        // Null means "no observation", not "disconnected" — the reconciler
        // distinguishes them.
        observed = null;
      }
      const memory = this.memories.get(deviceId) ?? { ...INITIAL_MEMORY };
      const { memory: next, events } = reconcile(deviceId, memory, observed, now);
      this.memories.set(deviceId, next);
      for (const event of events) this.emit(event);
    }
  }

  private ensurePolling(): void {
    if (this.poller !== undefined || this.closed) return;
    const interval = this.options.pollIntervalMs ?? 10_000;
    const tick = async (): Promise<void> => {
      if (this.closed) return;
      try {
        await this.pollOnce();
      } catch (err) {
        // A failed pass must not kill the poller: without it no tenant learns
        // anything about any device again.
        log.error("gowa poll failed", err);
      }
      if (!this.closed) this.poller = setTimeout(() => void tick(), interval);
    };
    this.poller = setTimeout(() => void tick(), interval);
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: Record<string, string>,
    options: { deviceId?: string; multipart?: boolean } = {},
  ): Promise<GowaResponse<T>> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const headers: Record<string, string> = {};
    if (options.deviceId !== undefined) headers["X-Device-Id"] = options.deviceId;

    let payload: string | FormData | undefined;
    if (body !== undefined) {
      if (options.multipart === true) {
        const form = new FormData();
        for (const [k, v] of Object.entries(body)) form.append(k, v);
        payload = form;
      } else {
        headers["content-type"] = "application/json";
        payload = JSON.stringify(body);
      }
    }

    try {
      const response = await doFetch(`${this.options.baseUrl}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(this.options.requestTimeoutMs ?? 30_000),
      });
      const text = await response.text();
      try {
        return JSON.parse(text) as GowaResponse<T>;
      } catch {
        // gowa returns bare text for some failures, e.g. "Method Not Allowed".
        throw new EngineError(`gowa returned a non-JSON response: ${text.slice(0, 120)}`, true);
      }
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError(`gowa request failed: ${err instanceof Error ? err.message : String(err)}`, true, {
        cause: err,
      });
    }
  }

  /** Classify a gowa message. Unrecognised means retryable, deliberately. */
  private toError(message: string): EngineError {
    const fatal = FATAL_PATTERNS.some((p) => p.test(message));
    return new EngineError(message, !fatal);
  }
}
