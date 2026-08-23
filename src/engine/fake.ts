/**
 * An in-memory engine.
 *
 * Two jobs. It lets the control plane be built and tested end to end without
 * gowa, a container or a phone — the claim flow could reach `pending_pairing`
 * and no further until this existed. And it is the first implementation the
 * conformance suite runs against, so the suite is exercised before the adapter
 * it will judge is written.
 *
 * It is not a simulation of WhatsApp. It models the state machine and the
 * event stream, nothing else.
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
} from "./types";

interface FakeDevice {
  provisioned: boolean;
  connected: boolean;
  loggedIn: boolean;
  jid: string | null;
  pushName: string | null;
}

export interface FakeEngineOptions {
  /** How long a pairing session lasts. */
  pairingTtlMs?: number;
  /** Fail every send, to exercise the caller's error handling. */
  failSends?: boolean;
}

export class FakeEngine implements DeviceEngine {
  readonly kind = "fake" as const;

  private readonly devices = new Map<string, FakeDevice>();
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private closed = false;

  constructor(private readonly options: FakeEngineOptions = {}) {}

  async provision(deviceId: string): Promise<void> {
    this.assertOpen();
    // Idempotent: provisioning twice must not reset a paired device.
    if (!this.devices.has(deviceId)) {
      this.devices.set(deviceId, { provisioned: true, connected: false, loggedIn: false, jid: null, pushName: null });
    }
  }

  async startPairing(deviceId: string, method: PairingMethod): Promise<PairingSession> {
    const device = this.require(deviceId);
    if (device.loggedIn) throw new EngineError(`device ${deviceId} is already paired`, false);

    const expiresAt = new Date(Date.now() + (this.options.pairingTtlMs ?? 30_000));
    if (method === "qr") {
      const qr = `fake-qr:${deviceId}:${crypto.randomUUID()}`;
      this.emit({ type: "device.qr", deviceId, qr, expiresAt });
      return { method, qr, expiresAt };
    }
    const pairCode = "ABCD-1234";
    this.emit({ type: "device.pair_code", deviceId, code: pairCode, expiresAt });
    return { method, pairCode, expiresAt };
  }

  /**
   * Complete a pairing. Test-only: the real thing happens on a phone.
   *
   * Named so it is obvious in a stack trace that a test drove this, not a user.
   */
  completePairing(deviceId: string, jid: string, pushName: string | null = null): void {
    const device = this.require(deviceId);
    device.connected = true;
    device.loggedIn = true;
    device.jid = jid;
    device.pushName = pushName;
    this.emit({ type: "device.connected", deviceId, jid, pushName });
  }

  /** Test-only: simulate the socket dropping without a logout. */
  dropConnection(deviceId: string, reason = "network", willRetry = true): void {
    const device = this.require(deviceId);
    device.connected = false;
    this.emit({ type: "device.disconnected", deviceId, reason, willRetry });
  }

  /** Test-only: simulate the phone holder unlinking. */
  remoteLogout(deviceId: string): void {
    const device = this.require(deviceId);
    device.connected = false;
    device.loggedIn = false;
    // The JID is cleared but the slot survives — keep-slot semantics, matching
    // what gowa was measured doing (docs/12).
    device.jid = null;
    this.emit({ type: "device.logged_out", deviceId, reason: "remote_logout" });
  }

  /** Test-only: push an arbitrary event, for exercising downstream handling. */
  inject(event: EngineEvent): void {
    this.emit(event);
  }

  async logout(deviceId: string): Promise<void> {
    const device = this.require(deviceId);
    device.connected = false;
    device.loggedIn = false;
    device.jid = null;
    this.emit({ type: "device.logged_out", deviceId, reason: "api" });
  }

  async purge(deviceId: string): Promise<void> {
    this.assertOpen();
    this.devices.delete(deviceId);
  }

  async status(deviceId: string): Promise<DeviceStatus> {
    const device = this.require(deviceId);
    return {
      connected: device.connected,
      loggedIn: device.loggedIn,
      jid: device.jid,
      pushName: device.pushName,
    };
  }

  async send(deviceId: string, action: SendAction): Promise<SendResult> {
    const device = this.require(deviceId);
    if (this.options.failSends === true) throw new EngineError("send failed", true);
    // Acceptance requires a usable socket; the caller still must not treat this
    // as delivery.
    if (!device.connected || !device.loggedIn) {
      throw new EngineError(`device ${deviceId} is not connected`, true);
    }
    if (action.to.trim() === "") throw new EngineError("recipient is required", false);
    return { messageId: `fake-${crypto.randomUUID()}`, acceptedAt: new Date() };
  }

  async *subscribe(): AsyncIterable<EngineEvent> {
    // Buffered rather than dropped: an event emitted between iterations must
    // still arrive, or a consumer misses exactly the events it was waiting for.
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
    for (const listener of [...this.listeners]) listener({ type: "device.degraded", deviceId: "", attempts: 0, lastError: "closed" });
    this.listeners.clear();
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private require(deviceId: string): FakeDevice {
    this.assertOpen();
    const device = this.devices.get(deviceId);
    if (device === undefined) throw new EngineError(`device ${deviceId} is not provisioned`, false);
    return device;
  }

  private assertOpen(): void {
    if (this.closed) throw new EngineError("engine is closed", false);
  }
}
