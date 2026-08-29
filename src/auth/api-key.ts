/**
 * API key generation and verification.
 *
 * A key is `bw_{live|test}_{project-slug}_{secret}`. The readable part is
 * deliberate: a leaked key is identifiable at a glance, greppable in logs, and
 * impossible to mistake for a different environment's — `bw_test_` and
 * `bw_live_` do not look alike in a hurry.
 *
 * Only a hash is stored. The plaintext exists for the duration of the response
 * that creates it and is never recoverable afterwards.
 */

import { config, MIN_API_KEY_LENGTH } from "../config/env";

/** Bytes of randomness in the secret portion. 32 bytes is 256 bits. */
const SECRET_BYTES = 32;

/**
 * How much of the key is stored in the clear for identification.
 *
 * Covers the scheme, environment kind, project slug and the first few secret
 * characters. Those extra characters matter: verification looks candidates up
 * by prefix, and without them every key in an environment would share one.
 */
const PREFIX_SECRET_CHARS = 6;

export interface GeneratedKey {
  /** Shown once, at creation. Never stored, never logged. */
  plaintext: string;
  /** Argon2id hash, stored for verification. */
  hash: string;
  /** Stored in the clear for identification and lookup. */
  prefix: string;
}

/**
 * The slug shape a key prefix can carry.
 *
 * Exported so the project store validates against exactly this: a slug that
 * passes there but not here mints keys `prefixOf` cannot parse, and every
 * request with one would fail authentication for no visible reason.
 */
export const KEY_SAFE_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

/** Base62 avoids `+`, `/` and `=`, so a key survives a URL or a shell unescaped. */
const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function randomSecret(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  let out = "";
  // Rejection-free: 62 does not divide 256, so a plain modulo is very slightly
  // biased. With 256 bits of input the bias is far below any practical concern,
  // and the alternative costs a loop for no security gain at this size.
  for (const byte of buffer) out += ALPHABET[byte % ALPHABET.length];
  return out;
}

/**
 * Mint a key for an environment.
 *
 * Hashing with Argon2id rather than a fast hash is belt and braces: the secret
 * already carries 256 bits of entropy, so guessing is not the threat. It costs
 * one hash per authenticated request, which the prefix lookup keeps to exactly
 * one candidate.
 */
export async function generateApiKey(input: {
  projectSlug: string;
  kind: "live" | "test";
}): Promise<GeneratedKey> {
  const secret = randomSecret(SECRET_BYTES);
  const plaintext = `bw_${input.kind}_${input.projectSlug}_${secret}`;
  const prefix = `bw_${input.kind}_${input.projectSlug}_${secret.slice(0, PREFIX_SECRET_CHARS)}`;
  const hash = await Bun.password.hash(plaintext, { algorithm: "argon2id" });
  return { plaintext, hash, prefix };
}

/**
 * The identifying prefix of a presented key.
 *
 * Returns null for anything that is not shaped like one of ours, so a malformed
 * credential is rejected before it reaches the database rather than causing a
 * lookup on attacker-controlled text.
 */
export function prefixOf(presented: string): string | null {
  const match = /^bw_(live|test)_([a-z0-9][a-z0-9-]{1,38}[a-z0-9])_([0-9A-Za-z]{16,})$/.exec(presented);
  if (match === null) return null;
  const [, kind, slug, secret] = match;
  return `bw_${kind}_${slug}_${secret!.slice(0, PREFIX_SECRET_CHARS)}`;
}

/**
 * A hash of a key that does not exist, for equalising timing.
 *
 * An unknown prefix returns without hashing while a known one pays for Argon2id,
 * and that difference is measurable — it tells an attacker when a prefix guess
 * is right, which is the expensive half of finding a key. Verifying against
 * this makes both paths cost the same.
 *
 * Computed once at module load rather than per request.
 */
export const DUMMY_KEY_HASH: Promise<string> = Bun.password.hash(
  "bw_live_nonexistent_0000000000000000000000000000000000000000",
  { algorithm: "argon2id" },
);

/**
 * Verify a presented key against a stored hash.
 *
 * Bun.password.verify is constant-time for the comparison and deliberately slow
 * for the derivation, so this must never be short-circuited by a cheaper check
 * on the plaintext.
 */
export async function verifyApiKey(presented: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(presented, hash);
  } catch {
    // A malformed stored hash must fail closed, not throw into the request path.
    return false;
  }
}

/**
 * Longest an operator-supplied key may be before it is not a credential.
 *
 * A bound exists so a huge body cannot be turned into a hashing cost.
 */
const MAX_BOOTSTRAP_LENGTH = 512;

/**
 * The index prefix for a key this system did not mint.
 *
 * `API_KEY` is chosen by whoever writes the deployment, so it does not carry
 * our `bw_live_slug_secret` shape and `prefixOf` returns null for it. Rather
 * than relax that parser — its strictness is what keeps a malformed credential
 * from becoming a query on attacker text — such keys are indexed under a
 * derived, fixed-width value. The prefix is an index selector, never a secret:
 * the row it selects still verifies with Argon2id.
 *
 * **Keyed, because it sits in the same row as the Argon2id hash.** This was a
 * bare SHA-256 of the presented key. Argon2id is chosen precisely because it is
 * expensive to attack offline, and storing a fast unkeyed digest of the same
 * secret beside it hands an attacker who reaches the database a cheaper target
 * than the one the expensive hash exists to be. `API_KEY` is operator-written
 * and only length-checked, so it carries no guaranteed entropy — a 32-character
 * phrase someone composed is exactly what a dictionary attack is for.
 *
 * The HMAC key is the credential encryption secret, which lives in the
 * environment rather than the database, so a leaked database no longer contains
 * everything needed to attack the value. When it is unset the digest is
 * unkeyed, which is no worse than what this replaced and is stated here rather
 * than hidden: the deployment that most needs this — one holding WhatsApp
 * credentials — is required to set that variable anyway.
 *
 * Deterministic either way, which `registerEnvKey` depends on to recognise the
 * row it wrote for this key on the last start.
 */
export function bootstrapPrefix(presented: string): string {
  const secret = config().credentialEncryptionKey;
  const hasher =
    secret === null ? new Bun.CryptoHasher("sha256") : new Bun.CryptoHasher("sha256", secret);
  return `bw_boot_${hasher.update(presented).digest("hex").slice(0, 24)}`;
}

/**
 * Whether a presented value could be an operator-supplied key.
 *
 * Keeps the "reject shape before touching the database" property: junk and
 * oversized bodies are still turned away without a lookup.
 */
export function isBootstrapCandidate(presented: string): boolean {
  return presented.length >= MIN_API_KEY_LENGTH && presented.length <= MAX_BOOTSTRAP_LENGTH;
}
