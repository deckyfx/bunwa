/**
 * Baileys as a `DeviceEngine`.
 *
 * Holds one socket per device and translates the port's events into the
 * normalised ones the control plane consumes. Imports no Baileys types — only
 * the port's — which is what ADR-0009 is protecting and what lets this be
 * swapped for gowa or a successor without touching anything above it.
 *
 * The sockets live in this process, so this class owns their lifecycle —
 * connect, reconnect, backoff, and knowing when to stop. That is the whole
 * shape of it: there is no server to ask, and nothing else to blame when a
 * device is down.
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
import { log } from "../../observability/logger";
import { openSocket, type DisconnectKind, type OutboundMedia, type SocketHandle } from "./socket";

/**
 * How long a QR stays valid.
 *
 * WhatsApp rotates it about every twenty seconds and Baileys emits a fresh one
 * each time. This is what the console shows as an expiry, so it is deliberately
 * the conservative end of that.
 */
const QR_TTL_MS = 20_000;

/** Backoff between reconnects, capped. Doubles on each consecutive failure. */
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * How many consecutive failures before a device is called degraded.
 *
 * Not zero, because a single blip is not news, and not large, because the
 * whole point of the signal is to say "a human should look" before the
 * customer notices.
 */
const DEGRADED_AFTER = 3;

interface Session {
  handle: SocketHandle | null;
  /** Consecutive failed reconnects. Reset by a successful connection. */
  failures: number;
  /** When the device last went down, for reporting recovery time. */
  downSince: Date | null;
  jid: string | null;
  pushName: string | null;
  /**
   * The most recent QR, held per session rather than read from the event queue.
   *
   * startPairing used to scan `pending` for one, which put it in competition
   * with every subscriber: a console watching the stream drained the QR first
   * and startPairing then blocked until its own deadline. One queue cannot
   * have two consumers with different needs.
   */
  lastQr: string | null;
  connected: boolean;
  loggedIn: boolean;
  /** Set while a deliberate stop is in progress, so it is not fought. */
  stopping: boolean;
  pump: Promise<void> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * How a socket is opened.
 *
 * Injectable so tests can supply one that does not dial WhatsApp. The first
 * conformance run against this adapter connected to WhatsApp for real,
 * attempted registration, and reconnect-looped — from a unit test. The gowa
 * adapter's suite already runs stubbed by default and goes live behind an
 * environment variable; this follows it.
 */
export type SocketOpener = (options: { deviceId: string }) => Promise<SocketHandle>;

export class BaileysAdapter implements DeviceEngine {
  readonly kind = "baileys" as const;

  private readonly open: SocketOpener;

  constructor(options: { openSocket?: SocketOpener } = {}) {
    this.open = options.openSocket ?? openSocket;
  }

  private readonly sessions = new Map<string, Session>();
  private readonly pending: EngineEvent[] = [];

  /**
   * Everyone parked waiting for the next event.
   *
   * A set rather than one slot: a single `notify` meant a second subscriber
   * silently replaced the first, and the displaced one waited for ever.
   */
  private readonly wakers = new Set<() => void>();
  private closed = false;

  /**
   * Provision a slot.
   *
   * Deliberately does not connect. A device that has never paired has no
   * credentials, and dialling WhatsApp without them produces a QR nobody is
   * looking at — which then expires, rotates, and repeats. Connecting is what
   * `startPairing` is for, and what `resume` does for devices that already
   * have credentials.
   */
  async provision(deviceId: string): Promise<void> {
    if (!this.sessions.has(deviceId)) {
      this.sessions.set(deviceId, {
        handle: null,
        failures: 0,
        downSince: null,
        jid: null,
        pushName: null,
        connected: false,
        loggedIn: false,
        lastQr: null,
        stopping: false,
        pump: null,
        reconnectTimer: null,
      });
    }
    return Promise.resolve();
  }

  /**
   * Open a socket and wait for the first QR.
   *
   * Waits rather than returning immediately: the caller needs something to put
   * in front of a customer, and a session with no QR would leave the console
   * polling for one. The QR is read from the session rather than the event
   * queue so a subscriber cannot consume it first.
   */
  async startPairing(deviceId: string, method: PairingMethod): Promise<PairingSession> {
    await this.provision(deviceId);

    if (method === "code") {
      // Refused before anything is opened. Rejecting after connect() left a
      // live WhatsApp socket and a rotating QR for a device nobody was
      // pairing, held in session.handle with nothing to close it.
      throw new EngineError(
        "pairing by code needs the device msisdn, which the engine does not hold; use startPairingWithCode",
        false,
      );
    }

    const session = this.sessions.get(deviceId)!;

    if (session.handle === null) await this.connect(deviceId);
    const handle = this.sessions.get(deviceId)?.handle;
    if (handle === undefined || handle === null) {
      throw new EngineError(`could not open a socket for ${deviceId}`, true);
    }

    const expiresAt = new Date(Date.now() + QR_TTL_MS);

    // The QR arrives asynchronously on the event stream. Waiting for the first
    // one here means the caller gets something to display rather than an empty
    // session it has to poll for.
    const qr = await this.firstQr(deviceId, QR_TTL_MS);
    if (qr === null) throw new EngineError(`no QR arrived for ${deviceId}`, true);

    return { method: "qr", qr, expiresAt };
  }

  /**
   * Pair by code rather than QR.
   *
   * Separate from `startPairing` because it needs the device's own number,
   * which is not on the `DeviceEngine` interface — and putting it there would
   * make every engine accept a parameter only this one uses.
   */
  async startPairingWithCode(deviceId: string, msisdn: string): Promise<PairingSession> {
    await this.provision(deviceId);
    if (this.sessions.get(deviceId)?.handle === null) await this.connect(deviceId);

    const handle = this.sessions.get(deviceId)?.handle;
    if (handle === undefined || handle === null) {
      throw new EngineError(`could not open a socket for ${deviceId}`, true);
    }

    const code = await handle.requestPairingCode(msisdn);
    return { method: "code", pairCode: code, expiresAt: new Date(Date.now() + QR_TTL_MS) };
  }

  /**
   * Unlink from WhatsApp, keeping the slot.
   *
   * The binding and its consent survive, so re-pairing needs no fresh
   * confirmation from the phone holder. The identity is cleared because
   * reporting a jid for a logged-out device tells the control plane it still
   * knows who this is.
   */
  async logout(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (session === undefined) return;

    session.stopping = true;
    this.clearReconnect(session);
    await session.handle?.logout().catch((err: unknown) => {
      // The socket may already be gone. The credentials still have to be
      // dropped, and the caller asked for a logout, so this is not fatal.
      log.warn("logout on a socket that was already gone", { deviceId, error: String(err) });
    });

    session.handle = null;
    session.connected = false;
    session.loggedIn = false;
    // Cleared, or the device can never be paired again.
    //
    // `stopping` exists to keep a reconnect from fighting a deliberate stop.
    // Leaving it set made connect() return early for ever, so a later
    // startPairing found no handle, could not create one, and threw — the
    // logout-then-re-pair workflow this engine ships with, broken by its own
    // logout. purge is unaffected because it deletes the session entirely.
    session.stopping = false;
    // The identity goes with the login. The slot stays, so re-pairing needs no
    // new consent — but reporting the old jid on a logged-out device would let
    // the control plane believe it still knows who this is.
    session.jid = null;
    session.pushName = null;
    session.lastQr = null;
    this.emit({ type: "device.logged_out", deviceId, reason: "api" });
  }

  /**
   * Destroy the slot.
   *
   * Credentials are removed by the control plane through the store — this
   * ends the socket and forgets the in-memory session. Splitting it that way
   * keeps the engine free of the database.
   */
  async purge(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (session === undefined) return;

    session.stopping = true;
    this.clearReconnect(session);
    await session.handle?.close().catch(() => undefined);
    this.sessions.delete(deviceId);
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- the contract
  // is a rejected promise, not a synchronous throw: callers use .rejects, and
  // a synchronous throw escapes an await chain in a different place.
  async status(deviceId: string): Promise<DeviceStatus> {
    const session = this.sessions.get(deviceId);
    if (session === undefined) {
      // Not a blank status. The conformance suite requires this and the reason
      // is in its comment: a blank one lets the control plane treat a typo as
      // a disconnected device and wait for ever for it to come up.
      throw new EngineError(`device ${deviceId} is not provisioned on this engine`, false);
    }

    return {
      connected: session.connected,
      loggedIn: session.loggedIn,
      jid: session.jid,
      pushName: session.pushName,
    };
  }

  /**
   * Send, and report acceptance rather than delivery.
   *
   * A disconnected device is a retryable failure — usually a moment from
   * reconnecting — while a missing recipient is not, because requeueing a
   * malformed request for ever drains nothing. The returned time is when the
   * socket took it, not when it arrived: acceptance meant nothing for 203
   * measured seconds (docs/12), so callers wait for an ack.
   */
  async send(deviceId: string, action: SendAction): Promise<SendResult> {
    const session = this.sessions.get(deviceId);
    const handle = session?.handle;

    if (handle === undefined || handle === null || session?.connected !== true) {
      // Retryable: the caller should back off rather than treat it as a bad
      // request. A disconnected device is usually a moment away from being
      // connected again.
      throw new EngineError(`device ${deviceId} is not connected`, true);
    }

    if (action.to.trim() === "") {
      // Not retryable. A malformed request requeued for ever is a queue that
      // never drains and a caller that never learns it sent nonsense.
      throw new EngineError("a message needs a recipient", false);
    }

    const messageId = await this.dispatch(handle, action);

    // Accepted, not delivered. The 203-second blind window measured against
    // gowa (docs/12) is a property of WhatsApp rather than of gowa, so the
    // ack-or-nothing rule still applies here.
    return { messageId, acceptedAt: new Date() };
  }

  /**
   * Turn a `SendAction` into a call on the port.
   *
   * Kept apart from `send` so the guard clauses there stay readable, and
   * because this is the part that grows as WhatsApp adds content types.
   */
  private async dispatch(handle: SocketHandle, action: SendAction): Promise<string> {
    if (action.type === "text") return handle.sendText(action.to, action.text);

    if (action.type === "link") {
      // A link is text. WhatsApp builds the preview from the URL in the body,
      // so sending it any other way loses the preview the caller asked for.
      const body = action.caption === undefined ? action.url : `${action.url}\n${action.caption}`;
      return handle.sendText(action.to, body);
    }

    const media = toOutboundMedia(action);
    return handle.sendMedia(action.to, media);
  }

  /**
   * Every device's events, as one stream.
   *
   * One stream rather than one per device because the control plane consumes
   * them centrally and a per-device iterator would make it manage
   * subscriptions it has no reason to know about.
   */
  subscribe(): AsyncIterable<EngineEvent> {
    // An explicit iterator rather than a generator, so `return()` can wake it.
    //
    // A generator parked at `await` does not resume when return() is called —
    // the request queues until that await settles. This one parked on a
    // promise only `emit` or `close` resolves, and shutdown stops consumers
    // before closing engines: the consumer waited for the iterator, the
    // iterator waited for close, and the process could not be killed with
    // three Ctrl-C. Reproduced against a live engine; the conformance suite
    // never saw it because it closes the engine rather than returning the
    // iterator.
    let done = false;
    let wake: (() => void) | null = null;

    const wakeUp = () => {
      wake?.();
      wake = null;
    };
    this.wakers.add(wakeUp);

    const finish = (): Promise<IteratorResult<EngineEvent>> => {
      done = true;
      this.wakers.delete(wakeUp);
      wakeUp();
      return Promise.resolve({ value: undefined, done: true });
    };

    return {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<EngineEvent>> => {
          for (;;) {
            if (done) return { value: undefined, done: true };
            const event = this.pending.shift();
            if (event !== undefined) return { value: event, done: false };
            if (this.closed) return finish();
            await new Promise<void>((resolve) => {
              wake = resolve;
            });
          }
        },
        return: finish,
        throw: finish,
      }),
    };
  }

  /**
   * Stop every socket without unlinking any of them.
   *
   * Shutdown must not log devices out: credentials survive a restart, and
   * ending them here would make every customer re-pair after a deploy.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const [, session] of this.sessions) {
      session.stopping = true;
      this.clearReconnect(session);
      await session.handle?.close().catch(() => undefined);
    }
    this.sessions.clear();
    // Wake every subscriber so their loops see `closed` and finish, rather
    // than staying parked on a promise nothing else will resolve.
    for (const wake of [...this.wakers]) wake();
  }

  // ---- internals ----------------------------------------------------------

  private emit(event: EngineEvent): void {
    this.pending.push(event);
    for (const wake of [...this.wakers]) wake();
  }

  private clearReconnect(session: Session): void {
    if (session.reconnectTimer !== null) {
      clearTimeout(session.reconnectTimer);
      session.reconnectTimer = null;
    }
  }

  /** Open the socket and start draining its events. */
  private async connect(deviceId: string): Promise<void> {
    const session = this.sessions.get(deviceId);
    if (session === undefined || session.stopping || this.closed) return;

    const handle = await this.open({ deviceId });
    session.handle = handle;
    session.pump = this.pump(deviceId, handle);
  }

  /**
   * Drain one socket's events into the engine's stream.
   *
   * Runs until the socket ends, then decides whether to reconnect. Keeping
   * that decision here rather than in the port is deliberate: the port knows
   * *what* happened, this knows what the control plane should be told and
   * whether trying again is sensible.
   */
  private async pump(deviceId: string, handle: SocketHandle): Promise<void> {
    try {
      for await (const event of handle.events) {
        const session = this.sessions.get(deviceId);
        if (session === undefined) return;

        switch (event.kind) {
          case "qr":
            if (event.qr !== undefined) {
              session.lastQr = event.qr;
              this.emit({ type: "device.qr", deviceId, qr: event.qr, expiresAt: new Date(Date.now() + QR_TTL_MS) });
            }
            break;

          case "pair_code":
            if (event.pairCode !== undefined) {
              this.emit({
                type: "device.pair_code",
                deviceId,
                code: event.pairCode,
                expiresAt: new Date(Date.now() + QR_TTL_MS),
              });
            }
            break;

          case "connected": {
            const wasDown = session.downSince;
            session.connected = true;
            session.loggedIn = true;
            session.failures = 0;
            session.jid = event.jid ?? null;

            this.emit({
              type: "device.connected",
              deviceId,
              jid: event.jid ?? "",
              pushName: session.pushName,
            });

            // Reported only when it follows an outage, so an ordinary first
            // connection does not look like a recovery from nothing.
            if (wasDown !== null) {
              this.emit({ type: "device.recovered", deviceId, downtimeMs: Date.now() - wasDown.getTime() });
              session.downSince = null;
            }
            break;
          }

          case "message":
            if (event.message !== undefined) {
              const m = event.message;
              this.emit({
                type: "message.received",
                deviceId,
                message: {
                  id: m.id,
                  from: m.senderJid,
                  fromLid: null,
                  chatId: m.chatJid,
                  chatLid: null,
                  pushName: m.pushName,
                  isFromMe: m.fromMe,
                  timestamp: m.timestamp,
                  body: m.body,
                  // The kind and type are known from the envelope; the bytes
                  // are not fetched yet. Reporting null here recorded every
                  // inbound image, video and document as plain text and lost
                  // its MIME type entirely.
                  media:
                    m.kind === "text" || m.kind === "unsupported"
                      ? null
                      : {
                          kind: m.kind,
                          url: null,
                          mimeType: m.mimeType,
                          filename: m.kind === "document" ? m.body : null,
                          caption: m.kind === "document" ? null : m.body,
                          sizeBytes: null,
                        },
                },
              });
            }
            break;

          case "ack":
            if (event.ackFor !== undefined && event.ackStatus !== undefined) {
              this.emit({ type: "message.ack", deviceId, messageId: event.ackFor, status: event.ackStatus });
            }
            break;

          case "disconnected":
            this.onDisconnected(deviceId, session, event.reason ?? "transient", event.recoverable === true);
            break;

          case "connecting":
          case "credentials_updated":
            break;
        }
      }
    } catch (err) {
      log.error("baileys event pump failed", err, { deviceId });
    }
  }

  /**
   * Decide what a disconnect means.
   *
   * The classification comes from the port; the policy is here. A device that
   * cannot be recovered by reconnecting must not be reconnected — retrying a
   * logged-out or replaced session is how a number gets restricted rather than
   * how it comes back.
   */
  private onDisconnected(deviceId: string, session: Session, reason: DisconnectKind | string, recoverable: boolean): void {
    session.connected = false;
    session.handle = null;
    session.downSince ??= new Date();

    if (reason === "logged_out") {
      session.loggedIn = false;
      session.jid = null;
      session.pushName = null;
      this.emit({ type: "device.logged_out", deviceId, reason: "remote_logout" });
      return;
    }

    this.emit({ type: "device.disconnected", deviceId, reason: String(reason), willRetry: recoverable && !session.stopping });

    if (!recoverable || session.stopping || this.closed) return;

    session.failures += 1;
    if (session.failures === DEGRADED_AFTER) {
      this.emit({
        type: "device.degraded",
        deviceId,
        attempts: session.failures,
        lastError: String(reason),
      });
    }

    // Exponential, capped. A device that has been failing for an hour should
    // be retried once a minute, not thousands of times.
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** (session.failures - 1), RECONNECT_MAX_MS);
    session.reconnectTimer = setTimeout(() => {
      session.reconnectTimer = null;
      void this.connect(deviceId).catch((err: unknown) => {
        // Routed back through the policy rather than only logged. The timer
        // has already cleared itself, so a failed open ended the retries
        // permanently and left the device disconnected with nothing scheduled
        // — the one case where retrying is obviously right.
        log.warn("reconnect failed", { deviceId, error: String(err) });
        const current = this.sessions.get(deviceId);
        if (current !== undefined) this.onDisconnected(deviceId, current, "transient", true);
      });
    }, delay);
  }

  /**
   * Wait for the first QR this device produces, or give up.
   *
   * Reads the session's own copy rather than the shared event queue, so a
   * subscriber consuming events does not starve it.
   */
  private async firstQr(deviceId: string, timeoutMs: number): Promise<string | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const qr = this.sessions.get(deviceId)?.lastQr;
      if (qr !== undefined && qr !== null) return qr;
      if (Date.now() > deadline) return null;
      await Bun.sleep(10);
    }
  }
}

/**
 * Map a media action onto the port's shape.
 *
 * A URL passes straight through so Baileys streams it; base64 is decoded here
 * because that is the last point where the encoding is still the caller's
 * problem rather than the socket's.
 */
function toOutboundMedia(
  action: Extract<SendAction, { media: unknown }>,
): OutboundMedia {
  const kind = action.type === "image" ? "image" : action.type === "video" ? "video" : action.type === "audio" ? "audio" : "document";

  const base: OutboundMedia = { kind };
  if ("url" in action.media) base.url = action.media.url;
  else {
    base.bytes = Buffer.from(action.media.base64, "base64");
    base.mimeType = action.media.mimeType;
  }

  if ("caption" in action && action.caption !== undefined) base.caption = action.caption;
  if (action.type === "document") base.fileName = action.filename;
  if (action.type === "audio" && action.voiceNote === true) base.voiceNote = true;

  return base;
}
