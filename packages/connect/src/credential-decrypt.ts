// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * Credential-envelope decryption helpers — the ONLY connect-side functions
 * that read the master encryption keyring (`./encryption.ts` → `@appstrate/env`
 * → `CONNECTION_ENCRYPTION_KEY`).
 *
 * Deliberately split out of `integration-credentials.ts`: the sidecar imports
 * only the pure delivery planners + types from that module, so keeping these
 * decryptors here means the sidecar's runtime graph never references
 * `encryption.ts`/`@appstrate/env` and never carries code that reads the master
 * key. Platform-only — credentials are decrypted on the host and served to the
 * sidecar already rendered.
 */

import { decryptCredentialEnvelope } from "./encryption.ts";
import { projectToStringMap } from "./integration-credentials.ts";

/**
 * Decrypt a `credentials_encrypted` blob and project its **injectable
 * outputs** to a flat `Record<string, string>` — non-string values are
 * silently dropped.
 *
 * Used by both the live credentials resolver (sidecar-facing) and the
 * token-refresh path, which need the credentials as a string map to
 * feed into header injection / token-endpoint POST bodies. Returns only
 * the `outputs` plane of the structured envelope (spec §4.6) — bootstrap
 * `inputs` (login secrets) are NEVER returned here, so the injection path
 * can never reference them. Throws on decryption failure (key rotation
 * issue, corrupted ciphertext, or non-v2 credential blob).
 */
export function decryptCredentialsToStringMap(ciphertext: string): Record<string, string> {
  return projectToStringMap(decryptCredentialEnvelope(ciphertext).outputs);
}

/**
 * Decrypt a `credentials_encrypted` blob and project its **bootstrap
 * inputs** to a flat `Record<string, string>` (spec §4.6). Returns `{}`
 * for envelopes persisted without `persistLoginSecret`. The ONLY caller is
 * the run-start spawn resolver, which needs the login secret to re-bootstrap
 * an expired session — the injection path must never call this.
 */
export function decryptCredentialInputsToStringMap(ciphertext: string): Record<string, string> {
  return projectToStringMap(decryptCredentialEnvelope(ciphertext).inputs);
}
