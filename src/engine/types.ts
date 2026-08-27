/**
 * The contract every WhatsApp engine implements.
 *
 * Deliberately constrained to what an HTTP client talking to gowa and an
 * in-process Baileys socket can *both* express. That constraint is the point:
 * it stops gowa-shaped assumptions leaking into the control plane, which is
 * what makes the eventual native engine a swap rather than a rewrite
 * (ADR-0002).
 *
 * Nothing here mentions projects, environments or consent. An engine holds
 * sockets and knows nothing about tenancy; the control plane knows about
 * tenancy and holds no sockets.
 */

/**
 * Which implementation backs a pool.
 *
 * "baileys" is the engine stage 4 exists to add: bunwa speaking WhatsApp
 * directly rather than proxying gowa. "native" predates it and meant the same
 * intention before the library was chosen; it stays because deployed rows may
 * carry it, and ADR-0002 keeps gowa permanently as the failover rather than
 * removing it once Baileys works.
 */
export type EngineKind = "gowa" | "baileys" | "native" | "fake";

/**
 * The kind as stored on a device row.
 *
 * Identical to EngineKind today, and written out rather than aliased to it on
 * purpose: the persisted set is a data format that outlives any one build, so
 * widening it is a migration question while widening EngineKind is not. As an
 * alias, a new engine kind would cross this boundary silently; spelled out,
 * persistedKind fails to compile until someone decides what to store. The pairing route previously
 * collapsed everything that was not "native" into "gowa" at this boundary,
 * which recorded the wrong engine against every device a fake pool held.
 */
export type PersistedEngineKind = "gowa" | "baileys" | "native" | "fake";

/** The kind to record for a pool. Explicit so the mapping has one home. */
export function persistedKind(kind: EngineKind): PersistedEngineKind {
  return kind;
}

/** How a device is being paired. */
export type PairingMethod = "qr" | "code";

/**
 * Device state as the engine sees it.
 *
 * Two booleans rather than one string, because gowa's `/devices` list `state`
 * was measured disagreeing with `/devices/{id}/status` — reporting "connected"
 * for a slot that had never been paired (docs/12). The pair is unambiguous:
 * (true,false) is pairing, (false,true) is a recoverable drop, (false,false)
 * with a known JID is a logout.
 */
export interface DeviceStatus {
  connected: boolean;
  loggedIn: boolean;
  jid: string | null;
  pushName: string | null;
}

/** A pairing attempt in progress. */
export interface PairingSession {
  method: PairingMethod;
  /** Present for `qr`: a data URI or URL the customer scans. */
  qr?: string;
  /** Present for `code`: the digits the customer types into WhatsApp. */
  pairCode?: string;
  expiresAt: Date;
}

/** The six v1 message types, as a discriminated union. */
export type SendAction =
  | { type: "text"; to: string; text: string }
  | { type: "image"; to: string; media: MediaRef; caption?: string }
  | { type: "document"; to: string; media: MediaRef; filename: string; caption?: string }
  | { type: "link"; to: string; url: string; caption?: string }
  | { type: "audio"; to: string; media: MediaRef; voiceNote?: boolean }
  | { type: "video"; to: string; media: MediaRef; caption?: string };

/** Where media comes from. A URL is preferred: it avoids buffering twice. */
export type MediaRef = { url: string } | { base64: string; mimeType: string };

export interface SendResult {
  messageId: string;
  /**
   * Acceptance is not delivery.
   *
   * gowa reported `is_connected: true` for 203 seconds after a silent drop
   * (docs/12), during which sends are accepted and go nowhere. Callers must
   * confirm with a `message.ack` and treat its absence as failure.
   */
  acceptedAt: Date;
}

/** Normalised events. The engine adapter, not the control plane, produces these. */
export type EngineEvent =
  | { type: "device.qr"; deviceId: string; qr: string; expiresAt: Date }
  | { type: "device.pair_code"; deviceId: string; code: string; expiresAt: Date }
  | { type: "device.connected"; deviceId: string; jid: string; pushName: string | null }
  | { type: "device.disconnected"; deviceId: string; reason: string; willRetry: boolean }
  | { type: "device.logged_out"; deviceId: string; reason: "remote_logout" | "api" }
  | { type: "device.degraded"; deviceId: string; attempts: number; lastError: string }
  | { type: "device.recovered"; deviceId: string; downtimeMs: number }
  | { type: "message.received"; deviceId: string; message: InboundMessage }
  | { type: "message.ack"; deviceId: string; messageId: string; status: "delivered" | "read" }
  | { type: "call.offer"; deviceId: string; from: string; callId: string };

/**
 * An inbound message, normalised.
 *
 * `senderDisplayName` is deliberately absent. gowa forwards it, and it is the
 * *device owner's* private contact naming — how they saved that person in their
 * own phone — not the sender's published name (docs/12). Forwarding it to a
 * tenant leaks the phone holder's address book, so the engine contract has no
 * field to carry it.
 */
export interface InboundMessage {
  id: string;
  /** Phone JID. May be absent as WhatsApp migrates toward LIDs. */
  from: string | null;
  /** The privacy-preserving identifier WhatsApp is moving to. Prefer this. */
  fromLid: string | null;
  chatId: string | null;
  chatLid: string | null;
  /** The sender's own published push name. Safe: they chose to publish it. */
  pushName: string | null;
  /** True for anything the phone holder sent from their own handset. */
  isFromMe: boolean;
  timestamp: Date;
  body: string | null;
  media: InboundMedia | null;
}

export interface InboundMedia {
  kind: "image" | "document" | "audio" | "video";
  /**
   * A URL bunwa can fetch, or null when the engine holds the bytes itself.
   *
   * gowa re-serves engine-local paths behind a URL because it is a separate
   * process. An in-process engine has no such URL until something downloads
   * the media, so null means "this is an image and we have not fetched it",
   * which is a true statement. A placeholder URL would be a false one, and the
   * console would render a broken link rather than an honest pending state.
   */
  url: string | null;
  mimeType: string | null;
  filename: string | null;
  caption: string | null;
  sizeBytes: number | null;
}

/** Raised by an engine for anything the control plane may need to distinguish. */
export class EngineError extends Error {
  override readonly name = "EngineError";
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

/**
 * One WhatsApp identity as the control plane sees it.
 *
 * Every method takes the engine's own device id, which is not bunwa's — the
 * mapping lives in `devices.engine_device_id` so a device can move between
 * engines without any project noticing.
 */
export interface DeviceEngine {
  readonly kind: EngineKind;

  /** Provision a slot. Idempotent on deviceId. */
  provision(deviceId: string): Promise<void>;

  /** Begin pairing. Progress also arrives on subscribe(). */
  startPairing(deviceId: string, method: PairingMethod): Promise<PairingSession>;

  /** Log out, keeping the slot and any engine-side history. */
  logout(deviceId: string): Promise<void>;

  /** Destroy the slot and its credentials. Irreversible. */
  purge(deviceId: string): Promise<void>;

  /** Current state. Cheap enough to poll on a health interval. */
  status(deviceId: string): Promise<DeviceStatus>;

  /** Perform an outbound action. One method, discriminated payload. */
  send(deviceId: string, action: SendAction): Promise<SendResult>;

  /**
   * Hot stream of already-normalised events for every device this engine owns.
   *
   * Adapters synthesise what their implementation does not emit natively: gowa
   * publishes no lifecycle events at all over its webhook, so its adapter
   * derives them from polling and its internal socket.
   */
  subscribe(): AsyncIterable<EngineEvent>;

  /** Release resources. Safe to call twice. */
  close(): Promise<void>;
}
