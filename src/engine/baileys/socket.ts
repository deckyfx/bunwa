/**
 * The only module permitted to import from `@whiskeysockets/baileys`.
 *
 * Baileys is unofficial and moves quickly, so the requirement from
 * [ADR-0009](../../../docs/adr/0009-baileys-version-and-isolation.md) is that a
 * breaking change upstream lands in one file. Everything above this depends on
 * the types declared here and never on library types — the moment a Baileys
 * type reaches a `DeviceEngine` signature, every other engine has to satisfy a
 * Baileys-shaped contract and the abstraction is gone.
 *
 * A test asserts the import rule so a violation fails a run rather than being
 * noticed in review.
 */
import makeWASocket, {
  BufferJSON,
  DisconnectReason,
  fetchLatestBaileysVersion,
  initAuthCreds,
  makeCacheableSignalKeyStore,
  proto,
  type AuthenticationCreds,
  type SignalDataTypeMap,
  type SignalKeyStore,
  type WAMessage,
  type WASocket,
} from "@whiskeysockets/baileys";

import { AuthStateStore } from "../../stores/auth-state-store";
import { log } from "../../observability/logger";

/**
 * Why a socket went away, in terms the control plane already understands.
 *
 * This translation is the point of the module. Baileys reports numeric codes
 * whose consequences differ enormously, and treating them alike is how a
 * reconnect loop becomes either a ban or a permanently dead device:
 *
 * - `logged_out` — the phone unlinked us. Credentials are void; reconnecting
 *   with them cannot succeed and re-trying looks like an attack.
 * - `replaced` — another client took the session. Baileys' 440, the same
 *   condition that makes gowa exit its whole process (ADR-0003). Reconnecting
 *   fights the other client for the slot.
 * - `restart_required` — expected, not a failure. Baileys asks for exactly one
 *   reconnect after pairing completes, and a caller that treats it as an error
 *   never finishes pairing at all.
 * - `transient` — timeouts, closes, service blips. Reconnect with backoff.
 * - `bad_session` — the stored credentials are corrupt. A human must re-pair;
 *   looping here achieves nothing.
 */
export type DisconnectKind =
  | "logged_out"
  | "replaced"
  | "restart_required"
  | "transient"
  | "bad_session";

/**
 * An inbound message, flattened.
 *
 * Baileys hands over a protobuf with a dozen possible content shapes nested
 * inside it. Flattening here rather than in the adapter is the point of the
 * port: the adapter deals in `kind` and `body`, so a change to how Baileys
 * nests a caption is one edit in this file.
 */
export interface SocketMessage {
  id: string;
  chatJid: string | null;
  senderJid: string | null;
  pushName: string | null;
  fromMe: boolean;
  timestamp: Date;
  kind: "text" | "image" | "video" | "audio" | "document" | "unsupported";
  body: string | null;
  mimeType: string | null;
}

/** What the adapter sees. No Baileys types cross this line. */
export interface SocketEvent {
  kind:
    | "qr"
    | "pair_code"
    | "connecting"
    | "connected"
    | "disconnected"
    | "credentials_updated"
    | "message"
    | "ack";
  /** The QR payload, for `qr`. */
  qr?: string;
  /** The pairing code, for `pair_code`. */
  pairCode?: string;
  /** The device's own JID once known, for `connected`. */
  jid?: string;
  /** Why, for `disconnected`. */
  reason?: DisconnectKind;
  /** Whether reconnecting could plausibly work, for `disconnected`. */
  recoverable?: boolean;
  /** The message, for `message`. */
  message?: SocketMessage;
  /** The provider id and new state, for `ack`. */
  ackFor?: string;
  ackStatus?: "delivered" | "read";
}

/**
 * Media to send.
 *
 * A URL is preferred and passed straight through: Baileys streams it, so a
 * 50MB video never sits in this process's heap. Bytes are accepted because the
 * API allows base64, but they are the slower path by construction.
 */
export interface OutboundMedia {
  kind: "image" | "video" | "audio" | "document";
  url?: string;
  bytes?: Buffer;
  mimeType?: string;
  caption?: string;
  fileName?: string;
  /** Audio only. A voice note renders as one in WhatsApp; a file does not. */
  voiceNote?: boolean;
}

export interface SocketHandle {
  /** Events, oldest first. Ends when the socket is closed. */
  events: AsyncIterable<SocketEvent>;
  /** Request a pairing code for a number, instead of scanning a QR. */
  requestPairingCode(msisdn: string): Promise<string>;
  /** Send plain text. Returns the provider's message id. */
  sendText(toJid: string, body: string): Promise<string>;
  /** Send media. Returns the provider's message id. */
  sendMedia(toJid: string, media: OutboundMedia): Promise<string>;
  /** Unlink from the phone. The credentials become void. */
  logout(): Promise<void>;
  /** Stop, without unlinking. Safe to call twice. */
  close(): Promise<void>;
}

/**
 * The HTTP-ish status Baileys hides inside a Boom error.
 *
 * Read structurally rather than by importing `@hapi/boom`. Boom is Baileys'
 * transitive dependency, not ours, so importing its type would put a second
 * upstream package in the one file that exists to contain exactly one — and
 * would break on a Baileys release that swapped its error library.
 */
function statusCodeOf(error: unknown): number | undefined {
  const output = (error as { output?: { statusCode?: unknown } } | null | undefined)?.output;
  return typeof output?.statusCode === "number" ? output.statusCode : undefined;
}

/**
 * Flatten one Baileys message into the shape the adapter uses.
 *
 * WhatsApp nests content a dozen ways and wraps some of it again in
 * `ephemeralMessage` or `viewOnceMessage`. Unwrapping here keeps that
 * knowledge in the one file allowed to hold it.
 *
 * Anything unrecognised becomes `unsupported` with a null body rather than
 * being dropped: a message the customer can see on their phone and cannot see
 * in the console is a support ticket, and "we received something we could not
 * render" is a better answer than silence.
 */
function flattenMessage(raw: WAMessage): SocketMessage | null {
  const id = raw.key.id;
  if (id === null || id === undefined) return null;

  // Unwrap the containers before looking at content, or every ephemeral
  // message reads as unsupported.
  let content = raw.message ?? null;
  content = content?.ephemeralMessage?.message ?? content;
  content = content?.viewOnceMessage?.message ?? content;
  content = content?.viewOnceMessageV2?.message ?? content;

  const timestamp = new Date(Number(raw.messageTimestamp ?? 0) * 1000);

  let kind: SocketMessage["kind"] = "unsupported";
  let body: string | null = null;
  let mimeType: string | null = null;

  if (content?.conversation !== undefined && content.conversation !== null) {
    kind = "text";
    body = content.conversation;
  } else if (content?.extendedTextMessage?.text != null) {
    // Links with previews arrive as extendedText, so this is also how a URL
    // send comes back.
    kind = "text";
    body = content.extendedTextMessage.text;
  } else if (content?.imageMessage != null) {
    kind = "image";
    body = content.imageMessage.caption ?? null;
    mimeType = content.imageMessage.mimetype ?? null;
  } else if (content?.videoMessage != null) {
    kind = "video";
    body = content.videoMessage.caption ?? null;
    mimeType = content.videoMessage.mimetype ?? null;
  } else if (content?.audioMessage != null) {
    kind = "audio";
    mimeType = content.audioMessage.mimetype ?? null;
  } else if (content?.documentMessage != null) {
    kind = "document";
    body = content.documentMessage.fileName ?? null;
    mimeType = content.documentMessage.mimetype ?? null;
  }

  return {
    id,
    chatJid: raw.key.remoteJid ?? null,
    senderJid: raw.key.participant ?? raw.key.remoteJid ?? null,
    pushName: raw.pushName ?? null,
    fromMe: raw.key.fromMe === true,
    timestamp,
    kind,
    body,
    mimeType,
  };
}

/**
 * Classify a disconnect.
 *
 * Exported for its own tests: the mapping is the highest-consequence logic in
 * this file and the hardest to notice being wrong, because every branch
 * "works" — it just reconnects when it should stop, or stops when it should
 * reconnect.
 */
export function classifyDisconnect(statusCode: number | undefined): {
  reason: DisconnectKind;
  recoverable: boolean;
} {
  switch (statusCode) {
    case DisconnectReason.loggedOut:
      return { reason: "logged_out", recoverable: false };
    case DisconnectReason.connectionReplaced:
      return { reason: "replaced", recoverable: false };
    case DisconnectReason.restartRequired:
      return { reason: "restart_required", recoverable: true };
    case DisconnectReason.badSession:
      return { reason: "bad_session", recoverable: false };
    case DisconnectReason.multideviceMismatch:
      // Not recoverable by reconnecting: the phone must re-link.
      return { reason: "bad_session", recoverable: false };
    case DisconnectReason.forbidden:
      // The account is blocked. Retrying is the worst available response.
      return { reason: "logged_out", recoverable: false };
    default:
      // Timeouts, closes, service blips, and anything new upstream adds.
      // Defaulting to recoverable is deliberate: an unknown code that is
      // actually transient must not strand a working device, and the
      // non-recoverable cases above are the ones with teeth.
      return { reason: "transient", recoverable: true };
  }
}

/**
 * Build Baileys' auth state on top of the encrypted store.
 *
 * Replaces `useMultiFileAuthState`, which writes one plaintext file per key
 * and puts `<msisdn>@s.whatsapp.net` in the filenames — so an OTP sender's
 * recipient list becomes a directory listing ([13](../../../docs/13-owning-the-data.md)).
 *
 * `BufferJSON` rather than plain JSON, and not as a style choice: credentials
 * are full of Buffers, and `JSON.stringify` turns them into
 * `{type:"Buffer",data:[…]}` objects Baileys will not accept back. The device
 * would save and load without complaint, then fail cryptographically somewhere
 * far from here. Verified before relying on it.
 */
async function loadAuthState(deviceId: string): Promise<{
  state: { creds: AuthenticationCreds; keys: SignalKeyStore };
  saveCreds: () => Promise<void>;
}> {
  const stored = await AuthStateStore.loadCreds(deviceId);
  const creds: AuthenticationCreds =
    stored === null
      ? initAuthCreds()
      : (JSON.parse(stored.toString("utf8"), BufferJSON.reviver) as AuthenticationCreds);

  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const found = await AuthStateStore.loadKeys(deviceId, type, ids);
      const out: { [id: string]: SignalDataTypeMap[T] } = {};

      for (const [id, bytes] of found) {
        let value: unknown = JSON.parse(bytes.toString("utf8"), BufferJSON.reviver);
        // Baileys' own store does exactly this. An app-state-sync-key handed
        // back as a plain object rather than the protobuf type fails later,
        // during app state sync, with an error that names neither this
        // function nor the key.
        if (type === "app-state-sync-key" && value !== null) {
          value = proto.Message.AppStateSyncKeyData.fromObject(value as Record<string, unknown>);
        }
        out[id] = value as SignalDataTypeMap[T];
      }
      return out;
    },

    async set(data) {
      const entries: { keyType: string; id: string; value: Buffer | null }[] = [];

      for (const [keyType, byId] of Object.entries(data)) {
        for (const [id, value] of Object.entries(byId ?? {})) {
          entries.push({
            keyType,
            id,
            // null and undefined both mean delete — that is how a consumed
            // pre-key is expired, and dropping the distinction would leave
            // spent keys behind for ever.
            value:
              value === null || value === undefined
                ? null
                : Buffer.from(JSON.stringify(value, BufferJSON.replacer), "utf8"),
          });
        }
      }

      await AuthStateStore.saveKeys(deviceId, entries);
    },

    async clear() {
      await AuthStateStore.forget(deviceId);
    },
  };

  return {
    state: { creds, keys },
    saveCreds: async () => {
      await AuthStateStore.saveCreds(
        deviceId,
        Buffer.from(JSON.stringify(creds, BufferJSON.replacer), "utf8"),
      );
    },
  };
}

/**
 * The auth state, exposed for tests.
 *
 * Serialisation is the part of this module most likely to be silently wrong,
 * and driving it through a real socket would need a WhatsApp connection to
 * find out. Named for what it is rather than dressed up as public API.
 */
export const loadAuthStateForTests = loadAuthState;

/**
 * A logger Baileys will actually accept.
 *
 * It calls `trace`, `debug`, `info`, `warn`, `error` and `child` on whatever
 * it is handed. The first version of this supplied only `level` and `child`,
 * and Baileys failed to load its tctoken index with "logger?.trace is not a
 * function" — visible only because a test happened to print its output. Its
 * own logs go nowhere by design: they are verbose, and they contain pairing
 * material.
 */
const SILENT_LOGGER = {
  level: "silent",
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  fatal: () => undefined,
  child: () => SILENT_LOGGER,
} as never;

/** Which device this socket is for. Credentials come from the database. */
export interface SocketOptions {
  deviceId: string;
}

/**
 * Open a socket for one device.
 *
 * Credentials come from the encrypted store, so they are captured by the same
 * `VACUUM INTO` snapshot as everything else and a restore is internally
 * consistent. The previous version kept them in a directory beside the
 * database, where a backup could catch the two at different moments — and a
 * backup whose credentials do not match its rows is not a restore point.
 */
export async function openSocket(options: SocketOptions): Promise<SocketHandle> {
  const { state, saveCreds } = await loadAuthState(options.deviceId);
  const { version } = await fetchLatestBaileysVersion();

  const socket: WASocket = makeWASocket({
    version,
    // Same reason as the key store: Baileys logs pairing material at info.
    logger: SILENT_LOGGER,
    auth: {
      creds: state.creds,
      // Cached, because the signal key store is read constantly during a
      // session and every miss is a disk read.
      keys: makeCacheableSignalKeyStore(state.keys, SILENT_LOGGER),
    },
    // Never true: printing a QR to stdout puts a takeover credential in the
    // process logs.
    printQRInTerminal: false,
    // We are a service, not a phone. Marking online would make WhatsApp
    // deliver presence and receipts we do not consume.
    markOnlineOnConnect: false,
  });

  const pending: SocketEvent[] = [];
  let notify: (() => void) | null = null;
  let closed = false;

  const emit = (event: SocketEvent) => {
    pending.push(event);
    notify?.();
    notify = null;
  };

  socket.ev.on("creds.update", () => {
    void saveCreds();
    emit({ kind: "credentials_updated" });
  });

  socket.ev.on("messages.upsert", ({ messages, type }) => {
    // "notify" is a live message. "append" is history being backfilled, which
    // would replay a customer's entire past into the console as if it had just
    // arrived.
    if (type !== "notify") return;
    for (const raw of messages) {
      const flat = flattenMessage(raw);
      if (flat !== null) emit({ kind: "message", message: flat });
    }
  });

  socket.ev.on("messages.update", (updates) => {
    for (const update of updates) {
      const id = update.key.id;
      const status = update.update.status;
      if (id === null || id === undefined || status === null || status === undefined) continue;

      // Baileys reports status as an ascending enum; only the two that mean
      // something to a caller are surfaced. DELIVERY_ACK is 3, READ is 4.
      if (status >= 4) emit({ kind: "ack", ackFor: id, ackStatus: "read" });
      else if (status === 3) emit({ kind: "ack", ackFor: id, ackStatus: "delivered" });
    }
  });

  socket.ev.on("connection.update", (update) => {
    if (update.qr !== undefined) emit({ kind: "qr", qr: update.qr });

    if (update.connection === "connecting") emit({ kind: "connecting" });

    if (update.connection === "open") {
      emit({ kind: "connected", jid: socket.user?.id });
    }

    if (update.connection === "close") {
      const statusCode = statusCodeOf(update.lastDisconnect?.error);
      const { reason, recoverable } = classifyDisconnect(statusCode);
      log.info("baileys socket closed", { deviceId: options.deviceId, statusCode, reason });
      emit({ kind: "disconnected", reason, recoverable });
      closed = true;
      notify?.();
      notify = null;
    }
  });

  return {
    events: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (pending.length > 0) yield pending.shift()!;
          if (closed) return;
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
      },
    },

    async requestPairingCode(msisdn: string): Promise<string> {
      // Baileys wants digits only; the control plane stores E.164.
      const code = await socket.requestPairingCode(msisdn.replace(/[^0-9]/g, ""));
      emit({ kind: "pair_code", pairCode: code });
      return code;
    },

    async sendText(toJid: string, body: string): Promise<string> {
      const sent = await socket.sendMessage(toJid, { text: body });
      const id = sent?.key.id;
      if (id === undefined || id === null) {
        // Without an id there is nothing to correlate an ack against, and the
        // control plane's whole delivery story rests on acks rather than on
        // send acceptance (docs/12).
        throw new Error("baileys accepted the message without returning an id");
      }
      return id;
    },

    async sendMedia(toJid: string, media: OutboundMedia): Promise<string> {
      // Either a stream Baileys fetches itself, or bytes we already hold.
      // Passing the URL through matters: buffering a video here to hand
      // Baileys the same bytes doubles peak memory for no benefit.
      const source = media.url !== undefined ? { url: media.url } : media.bytes;
      if (source === undefined) throw new Error("media needs either a url or bytes");

      const content =
        media.kind === "image"
          ? { image: source, caption: media.caption }
          : media.kind === "video"
            ? { video: source, caption: media.caption }
            : media.kind === "audio"
              ? { audio: source, mimetype: media.mimeType ?? "audio/ogg; codecs=opus", ptt: media.voiceNote === true }
              : {
                  document: source,
                  mimetype: media.mimeType ?? "application/octet-stream",
                  fileName: media.fileName ?? "file",
                  caption: media.caption,
                };

      const sent = await socket.sendMessage(toJid, content as never);
      const id = sent?.key.id;
      if (id === undefined || id === null) {
        throw new Error("baileys accepted the media without returning an id");
      }
      return id;
    },

    async logout(): Promise<void> {
      await socket.logout();
      closed = true;
      notify?.();
      notify = null;
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      // end() rather than logout(): this must not void the credentials, or a
      // restart would make every customer re-pair.
      socket.end(undefined);
      notify?.();
      notify = null;
    },
  };
}
