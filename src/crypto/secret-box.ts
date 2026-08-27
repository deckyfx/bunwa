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
import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

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
 * The storage id for a Signal key: keyed, not merely hashed.
 *
 * Session ids are `<msisdn>@s.whatsapp.net`, and Baileys' own store puts that
 * straight into a filename, so an OTP sender's recipient list is a directory
 * listing. Storing a digest instead was the fix — but the first version used
 * a bare SHA-256, and a phone number has nowhere near enough entropy for that
 * to hide anything. Measured: recovering one from a ten-thousand-number range
 * took 4ms. Anyone who could read the database could enumerate every
 * recipient, which is precisely what the digest was supposed to prevent.
 *
 * HMAC with a key derived from CREDENTIAL_ENCRYPTION_KEY makes the guess
 * useless without the secret. Lookup still works because Baileys only ever
 * asks for ids it already holds, so the value never needs to be reversed —
 * only recomputed.
 *
 * The key is domain-separated from the encryption key rather than reused
 * directly: one secret with two jobs is one mistake away from a ciphertext
 * and a digest sharing material.
 */
export function keyIdHash(id: string, key: Buffer): string {
  return createHmac("sha256", deriveKeyIdSecret(key)).update(id).digest("hex");
}

/** A distinct secret for identifiers, from the same configured key. */
function deriveKeyIdSecret(key: Buffer): Buffer {
  return createHmac("sha256", key).update("bunwa:signal-key-id:v1").digest();
}
