// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes, createCipheriv } from "node:crypto";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  encrypt,
  decrypt,
  encryptCredentials,
  decryptCredentials,
  encryptCredentialEnvelope,
  decryptCredentialEnvelope,
  _resetKeyringForTesting,
} from "../src/encryption.ts";

const PRIMARY_KEY_B64 = randomBytes(32).toString("base64");

// Snapshot the only env keys this file mutates, so other tests are unaffected.
const MUTATED_KEYS = [
  "CONNECTION_ENCRYPTION_KEY",
  "CONNECTION_ENCRYPTION_KEY_ID",
  "CONNECTION_ENCRYPTION_KEYS",
] as const;

let savedEnv: Partial<Record<(typeof MUTATED_KEYS)[number], string>> = {};

function snapshotEnv(): void {
  savedEnv = {};
  for (const k of MUTATED_KEYS) {
    if (k in process.env) savedEnv[k] = process.env[k];
  }
}

function restoreEnv(): void {
  for (const k of MUTATED_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  _resetCacheForTesting();
  _resetKeyringForTesting();
}

function setRotationEnv(overrides: Partial<Record<(typeof MUTATED_KEYS)[number], string>>): void {
  // Always start from a clean baseline so prior test state cannot leak.
  process.env.CONNECTION_ENCRYPTION_KEY = PRIMARY_KEY_B64;
  delete process.env.CONNECTION_ENCRYPTION_KEY_ID;
  delete process.env.CONNECTION_ENCRYPTION_KEYS;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k as (typeof MUTATED_KEYS)[number]];
    else process.env[k as (typeof MUTATED_KEYS)[number]] = v;
  }
  _resetCacheForTesting();
  _resetKeyringForTesting();
}

beforeEach(() => {
  snapshotEnv();
  setRotationEnv({});
});

afterEach(() => {
  restoreEnv();
});

describe("encryption — v1 versioned envelope", () => {
  it("round-trips plaintext through the active key", () => {
    const ciphertext = encrypt("hello world");
    expect(ciphertext.startsWith("v1:k1:")).toBe(true);
    expect(decrypt(ciphertext)).toBe("hello world");
  });

  it("emits the configured active kid in the envelope", () => {
    setRotationEnv({ CONNECTION_ENCRYPTION_KEY_ID: "k2" });
    const ciphertext = encrypt("payload");
    expect(ciphertext.startsWith("v1:k2:")).toBe(true);
  });
});

describe("encryption — keyring resolution during rotation", () => {
  it("decrypts a blob written with the primary key (active kid)", () => {
    const ciphertext = encrypt("secret");
    expect(decrypt(ciphertext)).toBe("secret");
  });

  it("decrypts a blob whose kid lives in CONNECTION_ENCRYPTION_KEYS (retired key)", () => {
    // Step 1: encrypt with what is currently the active key (kid = "k1").
    const oldCiphertext = encrypt("retired payload");
    expect(oldCiphertext.startsWith("v1:k1:")).toBe(true);

    // Step 2: rotate — promote a new active kid, retire the old one.
    setRotationEnv({
      CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      CONNECTION_ENCRYPTION_KEY_ID: "k2",
      CONNECTION_ENCRYPTION_KEYS: JSON.stringify({ k1: PRIMARY_KEY_B64 }),
    });

    // Step 3: blob still readable via the retired-keys map.
    expect(decrypt(oldCiphertext)).toBe("retired payload");

    // Step 4: new writes use the new active kid.
    const newCiphertext = encrypt("fresh payload");
    expect(newCiphertext.startsWith("v1:k2:")).toBe(true);
    expect(decrypt(newCiphertext)).toBe("fresh payload");
  });

  it("rejects a retired key map that aliases the active kid", () => {
    const retiredKey = randomBytes(32).toString("base64");
    setRotationEnv({
      CONNECTION_ENCRYPTION_KEY_ID: "k1",
      CONNECTION_ENCRYPTION_KEYS: JSON.stringify({ k1: retiredKey }),
    });
    expect(() => encrypt("anything")).toThrow(/active kid/);
  });

  it("rejects a retired key with the wrong byte length", () => {
    setRotationEnv({
      CONNECTION_ENCRYPTION_KEYS: JSON.stringify({
        old: Buffer.from("too-short").toString("base64"),
      }),
    });
    expect(() => encrypt("anything")).toThrow(/32 bytes/);
  });

  it("throws a clear error when decrypting a blob whose kid is unknown", () => {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(PRIMARY_KEY_B64, "base64"), iv);
    const enc = Buffer.concat([cipher.update("x", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, enc]).toString("base64");
    const forged = `v1:unknown:${packed}`;
    expect(() => decrypt(forged)).toThrow(/No encryption key registered/);
  });
});

describe("encryption — envelope format guard", () => {
  it("rejects a non-v1 ciphertext", () => {
    const rawBase64 = randomBytes(32).toString("base64");
    expect(() => decrypt(rawBase64)).toThrow(/expected 'v1:' prefix/);
  });

  it("rejects a v1 envelope with no kid separator", () => {
    expect(() => decrypt("v1:abcdef")).toThrow(/missing kid separator/);
  });

  it("rejects a v1 envelope whose embedded kid is malformed (KID_PATTERN wire-parse)", () => {
    // The loader rejects malformed kids at boot, but the parser must
    // also defend the read path so a forged blob with a kid containing
    // delimiters or > 32 chars can't smuggle past wire parsing.
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(PRIMARY_KEY_B64, "base64"), iv);
    const enc = Buffer.concat([cipher.update("x", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const packed = Buffer.concat([iv, tag, enc]).toString("base64");

    // (a) Whitespace in kid → reject before key lookup.
    expect(() => decrypt(`v1:bad kid:${packed}`)).toThrow(/does not match/);
    // (b) Over the 32-char limit.
    expect(() => decrypt(`v1:${"x".repeat(33)}:${packed}`)).toThrow(/does not match/);
    // (c) Empty kid.
    expect(() => decrypt(`v1::${packed}`)).toThrow(/does not match/);
  });

  it("v1 blobs still resolve via their explicit kid after rotation (no regression)", () => {
    // Encrypt under k1.
    const v1Blob = encrypt("explicit-kid payload");
    expect(v1Blob.startsWith("v1:k1:")).toBe(true);

    // Rotate: k1 retired, k2 active.
    setRotationEnv({
      CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      CONNECTION_ENCRYPTION_KEY_ID: "k2",
      CONNECTION_ENCRYPTION_KEYS: JSON.stringify({ k1: PRIMARY_KEY_B64 }),
    });

    // The v1 path looks up k1 directly via the embedded kid.
    expect(decrypt(v1Blob)).toBe("explicit-kid payload");
  });
});

describe("encryption — credentials helpers", () => {
  it("round-trips a credentials object", () => {
    const creds = { access_token: "at_123", refresh_token: "rt_456" };
    const encrypted = encryptCredentials(creds);
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(decryptCredentials<typeof creds>(encrypted)).toEqual(creds);
  });
});

describe("encryption — AES-GCM tamper detection (authTag)", () => {
  // The whole point of AES-GCM over CBC is authenticated encryption:
  // any tampering of the ciphertext, the IV, or the auth tag MUST fail
  // decryption. A future refactor that drops `decipher.setAuthTag(...)`
  // or weakens the algorithm would silently break this invariant —
  // these tests pin it.

  /** Decode a v1 envelope, mutate the packed payload via `mutate`, re-pack. */
  function tamperBlob(ciphertext: string, mutate: (packed: Buffer) => void): string {
    const [v, kid, b64] = ciphertext.split(":");
    expect(v).toBe("v1");
    const packed = Buffer.from(b64!, "base64");
    mutate(packed);
    return `${v}:${kid}:${packed.toString("base64")}`;
  }

  it("rejects a ciphertext whose body byte has been flipped (authTag mismatch)", () => {
    const original = encrypt("the quick brown fox");
    // Flip a byte in the encrypted body (after the 12-byte IV + 16-byte tag).
    const tampered = tamperBlob(original, (p) => {
      const bodyStart = 12 + 16;
      p[bodyStart] = p[bodyStart]! ^ 0xff;
    });
    // Sanity: same envelope shape, just one byte different.
    expect(tampered.startsWith("v1:k1:")).toBe(true);
    expect(tampered).not.toBe(original);
    // GCM must refuse.
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects a ciphertext whose authTag byte has been flipped", () => {
    const original = encrypt("auth-tag-tamper");
    // Flip the first byte of the 16-byte auth tag (offset 12..27).
    const tampered = tamperBlob(original, (p) => {
      const tagStart = 12;
      p[tagStart] = p[tagStart]! ^ 0xff;
    });
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects a ciphertext whose IV byte has been flipped", () => {
    const original = encrypt("iv-tamper-payload");
    const tampered = tamperBlob(original, (p) => {
      // Flip byte 0 of the IV.
      p[0] = p[0]! ^ 0xff;
    });
    expect(() => decrypt(tampered)).toThrow();
  });

  it("rejects a ciphertext encrypted under one key but tagged with another kid (wrong-key+right-kid)", () => {
    // Encrypt with the primary key (kid k1).
    const original = encrypt("cross-key payload");
    expect(original.startsWith("v1:k1:")).toBe(true);
    const packed = original.slice("v1:k1:".length);

    // Rotate: k1 is RETIRED with a DIFFERENT byte sequence, k2 is the new active.
    // A retired key under the same kid name but with the wrong bytes will fail
    // the GCM auth tag check — even though the kid lookup succeeds, the key
    // itself can't produce the original tag. This catches a regression where
    // an operator rotates by reusing kid names with new bytes.
    const wrongKeyForK1 = randomBytes(32).toString("base64");
    setRotationEnv({
      CONNECTION_ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      CONNECTION_ENCRYPTION_KEY_ID: "k2",
      CONNECTION_ENCRYPTION_KEYS: JSON.stringify({ k1: wrongKeyForK1 }),
    });

    // Same blob (kid k1 in envelope) — but the k1 retired-key bytes are now wrong.
    expect(() => decrypt(`v1:k1:${packed}`)).toThrow();
  });
});

describe("encryption — structured credential envelope (v2, spec §4.6)", () => {
  it("round-trips outputs + inputs through the v2 envelope", () => {
    const blob = encryptCredentialEnvelope({
      outputs: { access_token: "TOK", JSESSIONID: "abc" },
      inputs: { mot_de_passe: "s3cr3t" },
    });
    expect(blob.startsWith("v1:")).toBe(true); // crypto envelope unchanged
    const env = decryptCredentialEnvelope(blob);
    expect(env.outputs).toEqual({ access_token: "TOK", JSESSIONID: "abc" });
    expect(env.inputs).toEqual({ mot_de_passe: "s3cr3t" });
  });

  it("omits an empty inputs plane on write", () => {
    const blob = encryptCredentialEnvelope({ outputs: { api_key: "k" } });
    // The plaintext carries no `inputs` key, and reads back as {}.
    expect(JSON.parse(decrypt(blob))).toEqual({ v: 2, outputs: { api_key: "k" } });
    expect(decryptCredentialEnvelope(blob).inputs).toEqual({});
  });

  it("rejects a flat encrypted blob", () => {
    const flat = encryptCredentials({ access_token: "at_123", refresh_token: "rt_456" });
    expect(() => decryptCredentialEnvelope(flat)).toThrow(
      "Credential blob is not a structured v2 envelope",
    );
  });

  it("never leaks an input into the outputs plane", () => {
    const blob = encryptCredentialEnvelope({
      outputs: { access_token: "TOK" },
      inputs: { password: "s3cr3t" },
    });
    expect(JSON.stringify(decryptCredentialEnvelope(blob).outputs)).not.toContain("s3cr3t");
  });
});
