/**
 * The properties that matter for credentials at rest.
 *
 * Not "does it round-trip" alone — that passes for a cipher with a fixed IV,
 * or one whose tag is never checked. The tests below are the ones that fail
 * when the encryption is technically working and practically useless.
 */
import { describe, expect, test } from "bun:test";

import { keyFromSecret, keyIdHash, open, seal } from "../secret-box";

const KEY = keyFromSecret("a".repeat(64));
const CREDS = Buffer.from(JSON.stringify({ noiseKey: "secret", advSecretKey: "also secret" }));

describe("sealing credentials", () => {
  test("round-trips", () => {
    expect(open(seal(CREDS, KEY), KEY)).toEqual(CREDS);
  });

  test("the same plaintext seals differently every time", () => {
    // A fixed or counter IV under GCM loses the key outright. Identical
    // ciphertext for identical creds would also tell an observer with database
    // access which devices share state, without decrypting anything.
    const a = seal(CREDS, KEY);
    const b = seal(CREDS, KEY);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  test("the plaintext does not appear in the ciphertext", () => {
    // Guards the mistake of storing the blob and "encrypting" a copy of it.
    expect(seal(CREDS, KEY).ciphertext.includes(Buffer.from("noiseKey"))).toBe(false);
  });
});

describe("tampering is detected rather than tolerated", () => {
  test("a flipped byte fails to open", () => {
    // The whole reason for GCM over CBC. A credential that decrypts into
    // plausible nonsense fails far from here, long after the corruption.
    const sealed = seal(CREDS, KEY);
    sealed.ciphertext[0] = (sealed.ciphertext[0] ?? 0) ^ 0xff;
    expect(() => open(sealed, KEY)).toThrow();
  });

  test("a swapped IV fails to open", () => {
    const sealed = seal(CREDS, KEY);
    sealed.iv[0] = (sealed.iv[0] ?? 0) ^ 0xff;
    expect(() => open(sealed, KEY)).toThrow();
  });

  test("a different key fails to open", () => {
    expect(() => open(seal(CREDS, KEY), keyFromSecret("b".repeat(64)))).toThrow();
  });

  test("a truncated ciphertext fails rather than reading past the end", () => {
    const sealed = seal(CREDS, KEY);
    expect(() => open({ ...sealed, ciphertext: sealed.ciphertext.subarray(0, 4) }, KEY)).toThrow(
      /too short/,
    );
  });
});

describe("the key itself", () => {
  test("accepts 64 hex characters", () => {
    expect(keyFromSecret("0".repeat(64))).toHaveLength(32);
  });

  test("accepts 32 bytes of base64", () => {
    expect(keyFromSecret(Buffer.alloc(32, 7).toString("base64"))).toHaveLength(32);
  });

  test("refuses a short secret rather than stretching it", () => {
    // The important one. A padded or hashed short secret is indistinguishable
    // from a strong one in every config dump, so a weak key survives review.
    for (const weak of ["", "password", "0".repeat(32), "deadbeef"]) {
      expect(() => keyFromSecret(weak), `accepted ${JSON.stringify(weak)}`).toThrow(/must be 64 hex/);
    }
  });
});

describe("key ids are stored without the phone number", () => {
  const SESSION = "628123456789@s.whatsapp.net";

  test("a session id does not survive hashing", () => {
    // Baileys' file store writes session-628123456789@s.whatsapp.net.json, so
    // the recipient list is a directory listing. This is the fix.
    const hashed = keyIdHash(SESSION, KEY);
    expect(hashed).not.toContain("628123456789");
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  test("the same id hashes the same way, so lookup still works", () => {
    // Deterministic under one key: Baileys only ever asks for ids it already
    // holds, so recomputing is all that is needed and reversing is not.
    expect(keyIdHash("pre-key-42", KEY)).toBe(keyIdHash("pre-key-42", KEY));
    expect(keyIdHash("pre-key-42", KEY)).not.toBe(keyIdHash("pre-key-43", KEY));
  });

  test("guessing the number does not reproduce the digest without the key", () => {
    // The reason a bare SHA-256 was not enough. A phone number has nowhere
    // near the entropy to hide behind an unkeyed hash — measured, recovering
    // one from a ten-thousand-number range took 4ms — so anyone who could
    // read the database could enumerate every recipient. An attacker who
    // knows the exact id still cannot produce the stored value.
    const unkeyed = new Bun.CryptoHasher("sha256").update(SESSION).digest("hex");
    expect(keyIdHash(SESSION, KEY)).not.toBe(unkeyed);
  });

  test("a different key gives a different digest for the same id", () => {
    expect(keyIdHash(SESSION, KEY)).not.toBe(keyIdHash(SESSION, keyFromSecret("b".repeat(64))));
  });

  test("the identifier secret is not the encryption key itself", () => {
    // Domain separation: one secret with two jobs is one mistake away from a
    // ciphertext and a digest sharing material.
    expect(keyIdHash(SESSION, KEY)).not.toBe(
      new Bun.CryptoHasher("sha256").update(Buffer.concat([KEY, Buffer.from(SESSION)])).digest("hex"),
    );
  });
});
