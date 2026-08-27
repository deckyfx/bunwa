/**
 * Authenticated encryption for data at rest.
 *
 * Exists for WhatsApp credentials: `creds` carries the noise key, signed
 * identity key and adv secret, and anyone who reads them owns the account.
 * Baileys' own file store writes them as plain JSON, which is fine on a
 * developer's laptop and not for a multi-tenant service holding other
 * people's numbers ([13](../../docs/13-owning-the-data.md)).
 *
 * AES-256-GCM rather than CBC or a bare cipher: the tag means an altered row
 * fails to open instead of decrypting into something plausible. Silent
 * corruption of a credential is worse than a loud failure — the loud one is a
 * restore, the silent one is a device behaving oddly for a week.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** 96 bits, the size GCM is specified for. Not a preference. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

export interface Sealed {
  /** Ciphertext with the GCM tag appended. */
  ciphertext: Buffer;
  iv: Buffer;
}

/**
 * Turn the configured secret into a key.
 *
 * Accepts 64 hex characters or 32 raw bytes of base64, and refuses anything
 * else rather than padding or hashing it into shape. A short secret silently
 * stretched looks exactly like a strong one in every log and config dump,
 * which is how a weak key survives review.
 */
export function keyFromSecret(secret: string): Buffer {
  const trimmed = secret.trim();

  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, "hex");

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === KEY_BYTES) return decoded;

  throw new Error(
    `credential encryption key must be 64 hex characters or 32 bytes of base64, got ${String(trimmed.length)} characters`,
  );
}

/** Encrypt. A fresh IV every time — reusing one under GCM loses the key. */
export function seal(plaintext: Buffer, key: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), iv };
}

/**
 * Decrypt, or throw.
 *
 * Never returns a partial or best-effort result: a credential that decrypts to
 * nonsense is indistinguishable from a correct one until the socket fails
 * somewhere far from here.
 */
export function open(sealed: Sealed, key: Buffer): Buffer {
  if (sealed.ciphertext.length < TAG_BYTES) {
    throw new Error("ciphertext is too short to contain an authentication tag");
  }

  const body = sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES);
  const tag = sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES);

  const decipher = createDecipheriv("aes-256-gcm", key, sealed.iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/**
 * The storage id for a Signal key.
 *
 * Baileys looks keys up by an id it already holds and never enumerates them,
 * so the id need not be recoverable — which matters because session ids are
 * `<msisdn>@s.whatsapp.net`. Baileys' file store puts that in a filename, so
 * an OTP sender ends up with one file per recipient and a contact list anyone
 * with directory access can read. Hashing keeps exact lookup and stores no
 * number.
 */
export function keyIdHash(id: string): string {
  return new Bun.CryptoHasher("sha256").update(id).digest("hex");
}
