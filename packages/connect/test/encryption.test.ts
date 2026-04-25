// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { randomBytes, createCipheriv } from "node:crypto";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  encrypt,
  decrypt,
  encryptCredentials,
  decryptCredentials,
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

describe("encryption — backward compatibility with v0 (legacy unprefixed)", () => {
  it("decrypts legacy raw-base64 blobs with the active key", () => {
    // Build a v0 blob the same way the old encrypt() did: raw base64 of
    // `iv|authTag|ciphertext`, no version prefix, no kid.
    const key = Buffer.from(PRIMARY_KEY_B64, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update("legacy payload", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const v0Blob = Buffer.concat([iv, tag, enc]).toString("base64");
    expect(v0Blob.startsWith("v1:")).toBe(false);

    expect(decrypt(v0Blob)).toBe("legacy payload");
  });

  it("re-encrypts a v0 blob into a v1 envelope (in-place rotation primitive)", () => {
    const key = Buffer.from(PRIMARY_KEY_B64, "base64");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const enc = Buffer.concat([cipher.update("payload", "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    const v0Blob = Buffer.concat([iv, tag, enc]).toString("base64");

    const plaintext = decrypt(v0Blob);
    const reEncrypted = encrypt(plaintext);
    expect(reEncrypted.startsWith("v1:k1:")).toBe(true);
    expect(decrypt(reEncrypted)).toBe(plaintext);
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
