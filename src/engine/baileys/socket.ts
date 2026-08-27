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
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  useMultiFileAuthState,
  type WASocket,
} from "@whiskeysockets/baileys";
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

/** What the adapter sees. No Baileys types cross this line. */
export interface SocketEvent {
  kind:
    | "qr"
    | "pair_code"
    | "connecting"
    | "connected"
    | "disconnected"
    | "credentials_updated";
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
}

export interface SocketHandle {
  /** Events, oldest first. Ends when the socket is closed. */
  events: AsyncIterable<SocketEvent>;
  /** Request a pairing code for a number, instead of scanning a QR. */
  requestPairingCode(msisdn: string): Promise<string>;
  /** Send plain text. Returns the provider's message id. */
  sendText(toJid: string, body: string): Promise<string>;
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

/** Where a device's credentials live. One directory per device. */
export interface SocketOptions {
  deviceId: string;
  authDir: string;
}

/**
 * Open a socket for one device.
 *
 * Credentials are read from and written to `authDir`, which the caller owns:
 * losing that directory means the customer re-pairs, so who holds it and how
 * it is backed up is a control-plane decision rather than this module's.
 */
export async function openSocket(options: SocketOptions): Promise<SocketHandle> {
  const { state, saveCreds } = await useMultiFileAuthState(options.authDir);
  const { version } = await fetchLatestBaileysVersion();

  const socket: WASocket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      // Cached, because the signal key store is read constantly during a
      // session and every miss is a disk read.
      keys: makeCacheableSignalKeyStore(state.keys, {
        level: "silent",
        child: () => ({ level: "silent" }) as never,
      } as never),
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
