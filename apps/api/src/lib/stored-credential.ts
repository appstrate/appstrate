// SPDX-License-Identifier: Apache-2.0

import { CredentialDecryptError, UnknownKeyIdError } from "@appstrate/connect";
import { ApiError } from "./errors.ts";
import { logger } from "./logger.ts";

/** A stored credential is encrypted under a key id this process's keyring lacks. */
export class EncryptionKeyUnavailableError extends ApiError {
  constructor(cause?: UnknownKeyIdError) {
    super({
      status: 503,
      code: "encryption_key_unavailable",
      title: "Service Unavailable",
      detail:
        "A stored credential is encrypted with a key this server does not hold. Contact your administrator.",
      cause,
    });
  }
}

/** Logs the missing key (an operator error, kid when known) and builds the 503. */
export function encryptionKeyUnavailable(
  err: UnknownKeyIdError | null,
  logContext: Record<string, unknown>,
): EncryptionKeyUnavailableError {
  logger.error("Stored credential encrypted under a key id missing from the keyring", {
    ...logContext,
    ...(err ? { kid: err.kid } : {}),
    remedy: "add the missing key to CONNECTION_ENCRYPTION_KEYS and restart",
  });
  return new EncryptionKeyUnavailableError(err ?? undefined);
}

/** Unknown kid → the 503, never a dead credential. Unreadable blob → `null`. */
export function decryptStoredCredential<T>(
  decryptFn: () => T,
  logContext: Record<string, unknown>,
): T | null {
  try {
    return decryptFn();
  } catch (err) {
    if (err instanceof UnknownKeyIdError) throw encryptionKeyUnavailable(err, logContext);
    return unreadable(err, logContext);
  }
}

/** What {@link decryptForDisplay} answers for a row under a missing key. */
export const KEY_UNAVAILABLE = Symbol("encryption key unavailable");

/** For reads that only render a row: a missing key is not logged here — the action needing it is. */
export function decryptForDisplay<T>(
  decryptFn: () => T,
  logContext: Record<string, unknown>,
): T | null | typeof KEY_UNAVAILABLE {
  try {
    return decryptFn();
  } catch (err) {
    if (err instanceof UnknownKeyIdError) return KEY_UNAVAILABLE;
    return unreadable(err, logContext);
  }
}

function unreadable(err: unknown, logContext: Record<string, unknown>): null {
  if (!(err instanceof CredentialDecryptError)) throw err;
  logger.warn("Stored credential could not be decrypted", { ...logContext, error: err.message });
  return null;
}
