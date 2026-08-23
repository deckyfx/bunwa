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
import { lookup } from "node:dns/promises";

import { INITIAL_MEMORY, reconcile, type DeviceMemory } from "./reconciler";
import { config } from "../../config/env";
import { isAddressAllowed, validateWebhookTarget } from "../../delivery/target";
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
  /**
   * Injected in tests so no DNS query is made.
   *
   * Injected rather than skipped under a flag: the resolve-then-check is a
   * security control, and a suite that disabled it would assert against a
   * different code path than production runs.
   */
  lookupImpl?: (hostname: string) => Promise<Array<{ address: string }>>;
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
  /** Resolvers for parked subscribe() consumers, so close() can release them. */
  private readonly wakers = new Set<() => void>();
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
    // request() resolves for any parsable JSON, including {code:"ERROR"} with a
    // 500. Unchecked, a failed logout looked like success and the control plane
    // would record a device as logged out while its session was still live.
    this.assertOk(await this.request("POST", `/devices/${encodeURIComponent(deviceId)}/logout`), "logout failed");
  }

  async purge(deviceId: string): Promise<void> {
    this.assertOk(await this.request("DELETE", `/devices/${encodeURIComponent(deviceId)}`), "purge failed");
    // Only after gowa confirms. Dropping it on a failed purge would stop the
    // poller watching a slot that still exists.
    this.memories.delete(deviceId);
  }

  /** Raise unless gowa reported success. */
  private assertOk(response: GowaResponse<unknown>, context: string): void {
    // Requires SUCCESS rather than merely "not an error code". A response with
    // no code at all is not a success, and treating it as one is how a failed
    // logout was recorded as done while the session stayed live.
    if (response.code !== "SUCCESS") {
      throw this.toError(response.message ?? context);
    }
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
    const { path, body, multipart } = await this.toGowaSend(action);
    const result = await this.request<{ message_id?: string }>("POST", path, body, {
      deviceId,
      multipart,
    });
    const messageId = result.results?.message_id;
    if (messageId === undefined) throw this.toError(result.message ?? "send failed");
    return { messageId, acceptedAt: new Date() };
  }

  /** Map a SendAction onto gowa's endpoint and payload shape. */
  private async toGowaSend(
    action: SendAction,
  ): Promise<{ path: string; body: Record<string, string>; multipart: boolean }> {
    const to = action.to;
    if (action.to.trim() === "") throw new EngineError("recipient is required", false);

    const mediaUrl = async (ref: { url: string } | { base64: string; mimeType: string }): Promise<string> => {
      if ("url" in ref) return this.assertSafeUrl(ref.url);
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
          body: {
            phone: to,
            // gowa fetches this URL server-side to build the preview — measured
            // in docs/12. Handing it a caller-supplied address unchecked makes
            // gowa the SSRF vector instead of bunwa.
            link: await this.assertSafeUrl(action.url),
            ...(action.caption === undefined ? {} : { caption: action.caption }),
          },
          multipart: false,
        };
      case "image":
        return {
          path: "/send/image",
          body: { phone: to, image_url: await mediaUrl(action.media), ...(action.caption === undefined ? {} : { caption: action.caption }) },
          multipart: true,
        };
      case "document":
        return {
          path: "/send/file",
          body: {
            phone: to,
            file_url: await mediaUrl(action.media),
            // Without this the recipient sees gowa's generated storage name.
            // For the PDF requirement that is the whole point: an invoice must
            // arrive as invoice-2026-08.pdf, not 1787394484-6cdd….pdf.
            filename: action.filename,
            ...(action.caption === undefined ? {} : { caption: action.caption }),
          },
          multipart: true,
        };
      case "audio":
        return {
          path: "/send/audio",
          body: {
            phone: to,
            audio_url: await mediaUrl(action.media),
            // Forwarded rather than dropped. Silently sending a file when a
            // voice note was asked for is a different message in the chat.
            ...(action.voiceNote === true ? { ptt: "true" } : {}),
          },
          multipart: true,
        };
      case "video":
        return {
          path: "/send/video",
          body: { phone: to, video_url: await mediaUrl(action.media), ...(action.caption === undefined ? {} : { caption: action.caption }) },
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
    // Registered so close() can settle a parked consumer. Without it the
    // promise below never resolves, the finally never runs, and every consumer
    // hangs for the life of the process.
    const waker = (): void => wake?.();
    this.wakers.add(waker);
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
      this.wakers.delete(waker);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.poller !== undefined) clearTimeout(this.poller);
    this.poller = undefined;
    // Wake before clearing: a parked consumer must observe `closed` and run its
    // finally, rather than waiting on a promise nothing will ever settle.
    for (const wake of [...this.wakers]) wake();
    this.wakers.clear();
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
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        // gowa returns bare text for some failures, e.g. "Method Not Allowed".
        throw new EngineError(`gowa returned a non-JSON response (${response.status}): ${text.slice(0, 120)}`, true);
      }
      // #22: `null` and arrays parse fine and would then be read as an envelope
      // with no code, which assertOk now treats as failure — but a clearer
      // error here beats a confusing one there.
      if (parsed === null || typeof parsed !== "object") {
        throw new EngineError(`gowa returned an unexpected JSON body (${response.status})`, true);
      }
      const envelope = parsed as GowaResponse<T>;
      // A 5xx carrying a well-formed envelope is still a failure. Reading only
      // the body would let a 500 with {code:"SUCCESS"} through.
      if (!response.ok && envelope.code !== "SUCCESS") {
        throw this.toError(envelope.message ?? `gowa responded ${response.status}`);
      }
      return envelope;
    } catch (err) {
      if (err instanceof EngineError) throw err;
      throw new EngineError(`gowa request failed: ${err instanceof Error ? err.message : String(err)}`, true, {
        cause: err,
      });
    }
  }

  /**
   * Refuse a URL bunwa would not fetch itself.
   *
   * gowa resolves and fetches these inside the container, so validating only
   * bunwa's own outbound requests would leave the same hole reachable one hop
   * further along. Non-retryable: a private address will not become public.
   */
  private async assertSafeUrl(raw: string): Promise<string> {
    const allowInsecure = config().allowInsecureWebhookTargets;
    let url: URL;
    try {
      url = validateWebhookTarget(raw, { allowInsecure });
    } catch (err) {
      throw new EngineError(
        `refusing to pass an unsafe URL to the engine: ${err instanceof Error ? err.message : String(err)}`,
        false,
      );
    }

    // The normalised serialisation, not the raw string. Handing gowa the
    // original means it re-parses text we did not check — the two can differ.
    // Deliberately does *not* return early. The development switch relaxes the
    // https requirement, which is a transport concern; letting it also skip
    // address validation would make a local config the way to reach the cloud
    // metadata endpoint through gowa.

    // Resolve here too. Validation only inspects the literal, and gowa will
    // resolve the name itself inside the container — so a public-looking host
    // pointing at a private address would be fetched by gowa even though bunwa
    // would have refused it.
    //
    // KNOWN GAP, same as src/delivery/sender.ts: this narrows the rebinding
    // window, it cannot close it. gowa does its own DNS lookup and there is no
    // way to hand it a pinned address, so a resolver that answers differently
    // for gowa than for us is still followed. Closing it needs bunwa to fetch
    // the resource itself and pass gowa a URL it controls — tracked in docs/08.
    const resolve = this.options.lookupImpl ?? ((hostname: string) => lookup(hostname, { all: true }));
    let resolved: Array<{ address: string }>;
    try {
      resolved = await resolve(url.hostname);
    } catch {
      throw new EngineError(`refusing to pass a URL that does not resolve: ${url.hostname}`, false);
    }
    if (resolved.length === 0 || resolved.some((entry) => !isAddressAllowed(entry.address))) {
      throw new EngineError("refusing to pass a URL resolving to a private or loopback address", false);
    }
    return url.href;
  }

  /** Classify a gowa message. Unrecognised means retryable, deliberately. */
  private toError(message: string): EngineError {
    const fatal = FATAL_PATTERNS.some((p) => p.test(message));
    return new EngineError(message, !fatal);
  }
}
