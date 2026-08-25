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
