// SPDX-License-Identifier: Apache-2.0

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { getEnv } from "@appstrate/env";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

/**
 * Versioned envelope prefix.
 *
 * Wire format: `v1:<kid>:<base64(iv|authTag|ciphertext)>`
 *
 * The version tag + key id enable online key rotation: new writes embed the
 * active kid, reads dispatch decryption to the matching key in the keyring.
 *
 * `kid` MUST match `^[A-Za-z0-9_-]{1,32}$` so it can travel inside the
 * delimiter-based envelope without escaping.
 */
const ENVELOPE_VERSION = "v1";
const KID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Resolved keyring used by the in-process encryption layer.
 *
 * - `activeKid`: kid embedded in newly-encrypted blobs.
 * - `keys`: every kid the process can decrypt with — at minimum the active
 *   key, plus retired keys still in the rotation window.
 */
interface Keyring {
  activeKid: string;
  keys: Map<string, Buffer>;
}

let cachedKeyring: Keyring | null = null;

function loadKeyring(): Keyring {
  if (cachedKeyring) return cachedKeyring;

  const env = getEnv();
  const primaryKey = Buffer.from(env.CONNECTION_ENCRYPTION_KEY, "base64");

  const activeKid = env.CONNECTION_ENCRYPTION_KEY_ID;
  if (!KID_PATTERN.test(activeKid)) {
    throw new Error(
      `CONNECTION_ENCRYPTION_KEY_ID must match ${KID_PATTERN.source} (got: ${activeKid})`,
    );
  }

  const keys = new Map<string, Buffer>();
  keys.set(activeKid, primaryKey);

  // Retired keys map: { kid: base64 }. Used for decrypting old blobs during a
  // rotation window. Reject duplicates with the active kid to prevent silent
  // overrides.
  const retiredEntries = Object.entries(env.CONNECTION_ENCRYPTION_KEYS as Record<string, string>);
  for (const [kid, b64] of retiredEntries) {
    if (!KID_PATTERN.test(kid)) {
      throw new Error(
        `CONNECTION_ENCRYPTION_KEYS kid must match ${KID_PATTERN.source} (got: ${kid})`,
      );
    }
    if (kid === activeKid) {
      throw new Error(
        `CONNECTION_ENCRYPTION_KEYS contains the active kid '${kid}' — retired keys must use a different kid`,
      );
    }
    const buf = Buffer.from(b64, "base64");
    if (buf.length !== 32) {
      throw new Error(
        `CONNECTION_ENCRYPTION_KEYS['${kid}'] must be 32 bytes (256-bit) base64-encoded`,
      );
    }
    keys.set(kid, buf);
  }

  cachedKeyring = { activeKid, keys };
  return cachedKeyring;
}

/**
 * Reset the cached keyring. Test-only — production callers should never
 * mutate the keyring at runtime; rotation is a deploy-time operation.
 */
export function _resetKeyringForTesting(): void {
  cachedKeyring = null;
}

function getKey(kid: string): Buffer {
  const keyring = loadKeyring();
  const key = keyring.keys.get(kid);
  if (!key) {
    throw new Error(
      `No encryption key registered for kid '${kid}'. Add it to CONNECTION_ENCRYPTION_KEYS or set it as CONNECTION_ENCRYPTION_KEY.`,
    );
  }
  return key;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns a versioned envelope: `v1:<kid>:<base64(iv|authTag|ciphertext)>`.
 */
export function encrypt(plaintext: string): string {
  const keyring = loadKeyring();
  const key = getKey(keyring.activeKid);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  const packed = Buffer.concat([iv, authTag, encrypted]).toString("base64");
  return `${ENVELOPE_VERSION}:${keyring.activeKid}:${packed}`;
}

/**
 * Decrypt a v1 envelope (`v1:<kid>:<base64>`). The embedded kid drives key
 * lookup against the keyring (active + retired).
 */
export function decrypt(ciphertext: string): string {
  const parsed = parseEnvelope(ciphertext);

  if (parsed.packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }

  return decryptWithKey(parsed.packed, getKey(parsed.kid));
}

function decryptWithKey(packed: Buffer, key: Buffer): string {
  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

interface ParsedEnvelope {
  kid: string;
  packed: Buffer;
}

function parseEnvelope(ciphertext: string): ParsedEnvelope {
  if (!ciphertext.startsWith(`${ENVELOPE_VERSION}:`)) {
    throw new Error(`Invalid envelope: expected '${ENVELOPE_VERSION}:' prefix`);
  }
  const rest = ciphertext.slice(ENVELOPE_VERSION.length + 1);
  const sepIdx = rest.indexOf(":");
  if (sepIdx === -1) {
    throw new Error("Invalid v1 envelope: missing kid separator");
  }
  const kid = rest.slice(0, sepIdx);
  const payload = rest.slice(sepIdx + 1);
  if (!KID_PATTERN.test(kid)) {
    throw new Error(`Invalid v1 envelope: kid '${kid}' does not match ${KID_PATTERN.source}`);
  }
  return { kid, packed: Buffer.from(payload, "base64") };
}

/**
 * Encrypt a credentials object to a single encrypted string.
 */
export function encryptCredentials(credentials: Record<string, unknown>): string {
  return encrypt(JSON.stringify(credentials));
}

/**
 * Decrypt an encrypted credentials string back to an object.
 */
export function decryptCredentials<T = Record<string, string>>(encryptedStr: string): T {
  const json = decrypt(encryptedStr);
  return JSON.parse(json) as T;
}
