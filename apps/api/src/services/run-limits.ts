// SPDX-License-Identifier: Apache-2.0

/**
 * Platform + inline run limits.
 *
 * Two env vars, strictly validated:
 *   - PLATFORM_RUN_LIMITS — applies to every run (classic + inline)
 *   - INLINE_RUN_LIMITS   — additional caps for POST /api/runs/inline
 *
 * Defaults are generous / non-breaking for existing deployments (see
 * docs/specs/INLINE_RUNS.md §7). Invalid JSON or shape => fail-fast at boot
 * via a thrown error from {@link initRunLimits}.
 */

import { z } from "zod";
import { getEnv } from "@appstrate/env";
import { logger } from "../lib/logger.ts";

// ---------------------------------------------------------------------------
// Schemas — reject unknown keys so typos surface at boot.
// ---------------------------------------------------------------------------

const platformRunLimitsSchema = z
  .object({
    timeout_ceiling_seconds: z.number().int().positive().default(1800),
    per_org_global_rate_per_min: z.number().int().positive().default(200),
    max_concurrent_per_org: z.number().int().positive().default(50),
  })
  .strict();

const inlineRunLimitsSchema = z
  .object({
    rate_per_min: z.number().int().positive().default(60),
    manifest_bytes: z.number().int().positive().default(65536),
    prompt_chars: z.number().int().positive().default(200_000),
    max_skills: z.number().int().nonnegative().default(20),
    max_tools: z.number().int().nonnegative().default(20),
    max_authorized_uris: z.number().int().nonnegative().default(50),
    wildcard_uri_allowed: z.boolean().default(false),
    retention_days: z.number().int().positive().default(30),
  })
  .strict();

export type PlatformRunLimits = z.infer<typeof platformRunLimitsSchema>;
export type InlineRunLimits = z.infer<typeof inlineRunLimitsSchema>;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

let platformLimits: PlatformRunLimits | null = null;
let inlineLimits: InlineRunLimits | null = null;

/**
 * Parse + validate PLATFORM_RUN_LIMITS and INLINE_RUN_LIMITS.
 * Invalid shape throws — the caller (boot) MUST let it bubble up.
 */
export function initRunLimits(): void {
  const env = getEnv();

  const platformParsed = platformRunLimitsSchema.safeParse(env.PLATFORM_RUN_LIMITS);
  if (!platformParsed.success) {
    throw new Error(
      `PLATFORM_RUN_LIMITS invalid: ${platformParsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  platformLimits = platformParsed.data;

  const inlineParsed = inlineRunLimitsSchema.safeParse(env.INLINE_RUN_LIMITS);
  if (!inlineParsed.success) {
    throw new Error(
      `INLINE_RUN_LIMITS invalid: ${inlineParsed.error.issues
        .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
        .join("; ")}`,
    );
  }
  inlineLimits = inlineParsed.data;

  logger.info("Run limits loaded", {
    platform: platformLimits,
    inline: inlineLimits,
  });
}

export function getPlatformRunLimits(): PlatformRunLimits {
  if (!platformLimits) {
    throw new Error("Run limits not initialized. Call initRunLimits() at boot.");
  }
  return platformLimits;
}

export function getInlineRunLimits(): InlineRunLimits {
  if (!inlineLimits) {
    throw new Error("Run limits not initialized. Call initRunLimits() at boot.");
  }
  return inlineLimits;
}

/** Test-only: reset the cache so successive tests can install their own limits. */
export function _resetRunLimitsForTesting(): void {
  platformLimits = null;
  inlineLimits = null;
}

/** Test-only: override with concrete values without going through env. */
export function _setRunLimitsForTesting(
  platform?: Partial<PlatformRunLimits>,
  inline?: Partial<InlineRunLimits>,
): void {
  platformLimits = platformRunLimitsSchema.parse({ ...platform });
  inlineLimits = inlineRunLimitsSchema.parse({ ...inline });
}
