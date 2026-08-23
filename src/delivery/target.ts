/**
 * Validation of tenant-supplied webhook URLs.
 *
 * Projects choose where their events go, which makes every delivery an
 * outbound request to an address a customer controls. Unvalidated, that turns
 * bunwa into a request proxy pointed at its own network: `http://localhost`,
 * a database on the container network, or `http://169.254.169.254/` for cloud
 * credentials.
 *
 * This is not theoretical here. gowa's /send/link was measured fetching an
 * arbitrary caller-supplied URL server-side (docs/12), which is the same hole
 * reached from the other direction.
 */
import { isIP } from "node:net";

import { ValidationError } from "../stores/errors";

/** Schemes that may be used. Everything else — file:, gopher: — is refused. */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * IPv4 ranges that must never be reached.
 *
 * Loopback, link-local (which is where cloud metadata lives), the RFC 1918
 * private ranges, carrier-grade NAT, and the reserved blocks that some stacks
 * route oddly.
 */
function isBlockedIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a = 0, b = 0] = parts;
  if (a === 0) return true;                        // "this network"
  if (a === 10) return true;                       // private
  if (a === 127) return true;                      // loopback
  if (a === 169 && b === 254) return true;         // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private
  if (a === 192 && b === 168) return true;         // private
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 192 && b === 0) return true;           // IETF protocol assignments
  if (a >= 224) return true;                       // multicast and reserved
  return false;
}

/** IPv6 equivalents, including IPv4-mapped forms that smuggle a blocked v4 in. */
function isBlockedIPv6(address: string): boolean {
  const lower = address.toLowerCase().replace(/^\[|\]$/g, "");
  if (lower === "::1" || lower === "::") return true;      // loopback, unspecified
  if (lower.startsWith("fe80:")) return true;              // link-local
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;       // unique local
  if (lower.startsWith("ff")) return true;                 // multicast
  // An IPv4 address wearing an IPv6 hat, in either spelling. WHATWG URL parsing
  // rewrites ::ffff:127.0.0.1 to ::ffff:7f00:1, so checking only the dotted
  // form lets the hex one straight through — which is the bypass this whole
  // function exists to prevent.
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (dotted?.[1] !== undefined) return isBlockedIPv4(dotted[1]);

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex?.[1] !== undefined && hex[2] !== undefined) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    const octets = [high >> 8, high & 0xff, low >> 8, low & 0xff];
    return isBlockedIPv4(octets.join("."));
  }

  // Anything else mapped-looking is refused rather than guessed at: an
  // unrecognised form is not evidence that it is safe.
  if (lower.startsWith("::ffff:")) return true;
  return false;
}

export interface TargetPolicy {
  /** Permit http:// and private addresses. Development only. */
  allowInsecure?: boolean;
}

/**
 * Validate a webhook target, returning the normalised URL.
 *
 * Literal addresses are checked here. A hostname that *resolves* to a blocked
 * address is not caught at this layer — DNS can answer differently between this
 * check and the request (a rebinding attack), so the sender resolves once and
 * pins the address it validated. This function is the first gate, not the only
 * one.
 *
 * @throws ValidationError
 */
export function validateWebhookTarget(raw: string, policy: TargetPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ValidationError("webhook url is not a valid URL", "url");
  }

  if (!ALLOWED_SCHEMES.has(url.protocol)) {
    throw new ValidationError(`webhook url must use http or https, got "${url.protocol}"`, "url");
  }
  if (url.protocol === "http:" && policy.allowInsecure !== true) {
    throw new ValidationError("webhook url must use https", "url");
  }
  if (url.username !== "" || url.password !== "") {
    // Credentials in the URL would be stored in our database and echoed in
    // dashboards; and they are a classic way to disguise the real host.
    throw new ValidationError("webhook url must not contain credentials", "url");
  }

  const host = url.hostname;
  if (host === "") throw new ValidationError("webhook url has no host", "url");

  if (policy.allowInsecure !== true) {
    const version = isIP(host.replace(/^\[|\]$/g, ""));
    if (version === 4 && isBlockedIPv4(host)) {
      throw new ValidationError("webhook url must not point at a private or loopback address", "url");
    }
    if (version === 6 && isBlockedIPv6(host)) {
      throw new ValidationError("webhook url must not point at a private or loopback address", "url");
    }
    // Names that resolve locally by convention, before DNS is consulted at all.
    if (version === 0 && /^(localhost|.*\.localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) {
      throw new ValidationError("webhook url must not point at a local host name", "url");
    }
  }

  return url;
}

/** Whether a resolved address may be connected to. Used after DNS, before the socket. */
export function isAddressAllowed(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return !isBlockedIPv4(address);
  if (version === 6) return !isBlockedIPv6(address);
  return false;
}
