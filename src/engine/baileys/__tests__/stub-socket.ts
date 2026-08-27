/**
 * A socket that behaves like Baileys without dialling WhatsApp.
 *
 * The conformance run and the adapter's own tests need a socket whose events
 * they control. Without this the first run connected to WhatsApp for real,
 * attempted registration, and reconnect-looped — from a unit test.
 *
 * Deliberately dumb: it emits what it is told to and records what it was
 * asked to send. Anything cleverer would start testing the stub.
 */
import type { OutboundMedia, SocketEvent, SocketHandle, SocketMessage } from "../socket";

export class StubSocket implements SocketHandle {
  readonly sent: { to: string; body: string }[] = [];
  readonly sentMedia: { to: string; kind: string }[] = [];
  readonly pairingCodesRequested: string[] = [];
  closed = false;
  loggedOut = false;

  private readonly pending: SocketEvent[] = [];
  private notify: (() => void) | null = null;
  private ended = false;

  /**
   * An unpaired socket produces a QR almost immediately, so the stub does too.
   *
   * Without this, startPairing waits for a QR that never arrives and the
   * conformance suite times out — which reads as an adapter bug rather than a
   * stub that does not behave like the thing it stands in for.
   */
  constructor(options: { emitQrOnOpen?: boolean } = {}) {
    if (options.emitQrOnOpen !== false) {
      this.pending.push({ kind: "qr", qr: "STUB-QR-PAYLOAD" });
    }
  }

  /** Push an event the adapter will see. */
  emit(event: SocketEvent): void {
    this.pending.push(event);
    this.notify?.();
    this.notify = null;
  }

  /** Convenience for the common sequence. */
  becomeConnected(jid = "628123456789@s.whatsapp.net"): void {
    this.emit({ kind: "connected", jid });
  }

  deliver(message: Partial<SocketMessage> = {}): void {
    this.emit({
      kind: "message",
      message: {
        id: "wa-1",
        chatJid: "628999@s.whatsapp.net",
        senderJid: "628999@s.whatsapp.net",
        pushName: "Someone",
        fromMe: false,
        timestamp: new Date(1_000),
        kind: "text",
        body: "hello",
        mimeType: null,
        ...message,
      },
    });
  }

  /** End the stream, as a real socket does when it closes for good. */
  end(): void {
    this.ended = true;
    this.notify?.();
    this.notify = null;
  }

  get events(): AsyncIterable<SocketEvent> {
    const self = this;
    return {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          while (self.pending.length > 0) yield self.pending.shift()!;
          if (self.ended) return;
          await new Promise<void>((resolve) => {
            self.notify = resolve;
          });
        }
      },
    };
  }

  requestPairingCode(msisdn: string): Promise<string> {
    this.pairingCodesRequested.push(msisdn);
    return Promise.resolve("ABCD-1234");
  }

  sendText(toJid: string, body: string): Promise<string> {
    this.sent.push({ to: toJid, body });
    return Promise.resolve(`sent-${String(this.sent.length)}`);
  }

  sendMedia(toJid: string, media: OutboundMedia): Promise<string> {
    this.sentMedia.push({ to: toJid, kind: media.kind });
    return Promise.resolve(`media-${String(this.sentMedia.length)}`);
  }

  logout(): Promise<void> {
    this.loggedOut = true;
    this.end();
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    this.end();
    return Promise.resolve();
  }
}
