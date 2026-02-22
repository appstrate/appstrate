import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

let encryptionKey: Buffer | null = null;

function getKey(): Buffer {
  if (encryptionKey) return encryptionKey;

  const keyEnv = process.env.CONNECTION_ENCRYPTION_KEY;
  if (!keyEnv) {
    throw new Error("CONNECTION_ENCRYPTION_KEY is not set");
  }

  const keyBuffer = Buffer.from(keyEnv, "base64");
  if (keyBuffer.length !== 32) {
    throw new Error(
      `CONNECTION_ENCRYPTION_KEY must be 32 bytes (256-bit) base64-encoded. Got ${keyBuffer.length} bytes.`,
    );
  }

  encryptionKey = keyBuffer;
  return keyBuffer;
}

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Returns base64(iv + authTag + ciphertext).
 */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: iv (12) + authTag (16) + ciphertext
  const packed = Buffer.concat([iv, authTag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64(iv + authTag + ciphertext) string.
 */
export function decrypt(ciphertext: string): string {
  const key = getKey();
  const packed = Buffer.from(ciphertext, "base64");

  if (packed.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error("Invalid encrypted data: too short");
  }

  const iv = packed.subarray(0, IV_LENGTH);
  const authTag = packed.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = packed.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
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
