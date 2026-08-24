/**
 * Webhook signatures.
 *
 * `X-Bunwa-Signature: t=<unix>,v1=<hex hmac-sha256 of "t.body">`
 *
 * The timestamp is inside the signed material, not beside it. gowa signs the
 * body alone (verified in its webhook.go), which means anyone who captures one
 * payload can replay it forever — the signature stays valid because nothing in
 * it expires.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

/** How old a signature may be before it is refused. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export const SIGNATURE_HEADER = "x-bunwa-signature";

/** Sign a body for a point in time. */
export function sign(body: string, secret: string, at: Date = new Date()): string {
  const timestamp = Math.floor(at.getTime() / 1000);
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export interface VerifyResult {
  valid: boolean;
  /** Why not, for the receiver's logs. Never returned to a caller. */
  reason?: "malformed" | "stale" | "mismatch";
}

/**
 * Verify a signature header against a body.
 *
 * Published for consumers to copy: the point of a signing scheme is that the
 * other side implements it correctly, and a scheme nobody can verify easily is
 * one everybody skips.
 */
export function verify(
  body: string,
  header: string | null | undefined,
  secret: string,
  options: { toleranceSeconds?: number; now?: Date } = {},
): VerifyResult {
  if (header === null || header === undefined) return { valid: false, reason: "malformed" };

  const parts = new Map<string, string>();
  for (const segment of header.split(",")) {
    const [key, value] = segment.split("=", 2);
    if (key !== undefined && value !== undefined) parts.set(key.trim(), value.trim());
  }

  const timestamp = parts.get("t");
  const provided = parts.get("v1");
  if (timestamp === undefined || provided === undefined) return { valid: false, reason: "malformed" };
  if (!/^\d+$/.test(timestamp)) return { valid: false, reason: "malformed" };

  const tolerance = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const now = Math.floor((options.now ?? new Date()).getTime() / 1000);
  // Absolute difference: a timestamp from the future is as suspicious as an old
  // one, and clock skew cuts both ways.
  if (Math.abs(now - Number(timestamp)) > tolerance) return { valid: false, reason: "stale" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  if (expected.length !== provided.length) return { valid: false, reason: "mismatch" };
  const matches = timingSafeEqual(Buffer.from(expected), Buffer.from(provided));
  return matches ? { valid: true } : { valid: false, reason: "mismatch" };
}
