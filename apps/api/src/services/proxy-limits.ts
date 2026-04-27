// SPDX-License-Identifier: Apache-2.0

/**
 * LLM + credential proxy limits.
 *
 * Two env vars, strictly validated:
 *   - LLM_PROXY_LIMITS        — caps on `/api/llm-proxy/*`
 *   - CREDENTIAL_PROXY_LIMITS — caps on `/api/credential-proxy/proxy`
 *
 * Mirrors `services/run-limits.ts`: schemas use `.strict()` so unknown
 * keys fail-fast at boot, and {@link initProxyLimits} throws on invalid
 * shape — the caller (boot) must let the error bubble up.
 */

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const llmProxyLimitsSchema = z
  .object({
    rate_per_min: z.number().int().positive().default(60),
    max_request_bytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
  })
  .strict();

const credentialProxyLimitsSchema = z
  .object({
    rate_per_min: z.number().int().positive().default(100),
    max_request_bytes: z
      .number()
      .int()
      .positive()
      .default(10 * 1024 * 1024),
    max_response_bytes: z
      .number()
      .int()
      .positive()
      .default(50 * 1024 * 1024),
    session_ttl_seconds: z.number().int().positive().default(3600),
  })
  .strict();

export type LlmProxyLimits = z.infer<typeof llmProxyLimitsSchema>;
export type CredentialProxyLimits = z.infer<typeof credentialProxyLimitsSchema>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let llmLimits: LlmProxyLimits | null = null;
let credentialLimits: CredentialProxyLimits | null = null;

export function initProxyLimits(): void {
  const env = getEnv();

  const llmParsed = llmProxyLimitsSchema.safeParse(env.LLM_PROXY_LIMITS);
  if (!llmParsed.success) {
    throw new Error(
      `LLM_PROXY_LIMITS invalid: ${llmParsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  llmLimits = llmParsed.data;

  const credentialParsed = credentialProxyLimitsSchema.safeParse(env.CREDENTIAL_PROXY_LIMITS);
  if (!credentialParsed.success) {
    throw new Error(
      `CREDENTIAL_PROXY_LIMITS invalid: ${credentialParsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  credentialLimits = credentialParsed.data;

  logger.info("Proxy limits loaded", {
    llm: llmLimits,
    credential: credentialLimits,
  });
}

export function getLlmProxyLimits(): LlmProxyLimits {
  if (!llmLimits) {
    throw new Error("Proxy limits not initialized. Call initProxyLimits() at boot.");
  }
  return llmLimits;
}

export function getCredentialProxyLimits(): CredentialProxyLimits {
  if (!credentialLimits) {
    throw new Error("Proxy limits not initialized. Call initProxyLimits() at boot.");
  }
  return credentialLimits;
}

/** Test-only: reset the cache so successive tests can install their own limits. */
export function _resetProxyLimitsForTesting(): void {
  llmLimits = null;
  credentialLimits = null;
}

/** Test-only: override with concrete values without going through env. */
export function _setProxyLimitsForTesting(
  llm?: Partial<LlmProxyLimits>,
  credential?: Partial<CredentialProxyLimits>,
): void {
  llmLimits = llmProxyLimitsSchema.parse({ ...llm });
  credentialLimits = credentialProxyLimitsSchema.parse({ ...credential });
}
