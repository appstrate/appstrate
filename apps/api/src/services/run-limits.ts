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
import { formatZodIssues } from "../lib/zod-format.ts";

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
    prompt_bytes: z.number().int().positive().default(200_000),
    max_skills: z.number().int().nonnegative().default(20),
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
    throw new Error(`PLATFORM_RUN_LIMITS invalid: ${formatZodIssues(platformParsed.error)}`);
  }
  platformLimits = platformParsed.data;

  const inlineParsed = inlineRunLimitsSchema.safeParse(env.INLINE_RUN_LIMITS);
  if (!inlineParsed.success) {
    throw new Error(`INLINE_RUN_LIMITS invalid: ${formatZodIssues(inlineParsed.error)}`);
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

// ---------------------------------------------------------------------------
// Timeout resolution
// ---------------------------------------------------------------------------

/**
 * Timeout applied when an agent manifest declares none. AFPS leaves `timeout`
 * optional, so every read path needs the same fallback — keeping it here, next
 * to the ceiling that clamps it, stops the two drifting apart.
 */
export const DEFAULT_RUN_TIMEOUT_SECONDS = 300;

export interface ResolvedRunTimeout {
  /** What the manifest asked for (or {@link DEFAULT_RUN_TIMEOUT_SECONDS}). */
  declaredSeconds: number;
  /** What the run actually gets — `declaredSeconds` clamped to the ceiling. */
  effectiveSeconds: number;
  /** `true` when the ceiling won, i.e. the declared value is unreachable. */
  capped: boolean;
}

/**
 * Resolve a manifest's declared `timeout` against the platform ceiling.
 *
 * Single source for a rule that has three consumers with three different
 * reactions: the run preflight (clamps the manifest before the prompt is built
 * and before `beforeUsage` quotes it), the import route (warns the author), and
 * the agent detail DTO (shows the author what a run will really get). Inlining
 * `Math.min` at each of them is exactly how the three would drift.
 *
 * Takes the declared VALUE rather than the manifest: all three callers already
 * hold the manifest and a property read is cheaper than a union parameter that
 * has to re-narrow an `unknown` object at every call.
 *
 * Non-number declarations (absent, `null`, `"600"`) fall back to the default —
 * the same narrowing the preflight has always applied, deliberately NOT a
 * coercion: a string timeout is an authoring bug, and silently honouring it
 * would make the manifest's meaning depend on its JSON type.
 *
 * Throws when run limits are not initialized (see {@link getPlatformRunLimits}) —
 * a missing `initRunLimits()` is a boot-ordering bug, not a condition to paper
 * over with an unbounded default.
 */
export function resolveRunTimeout(declaredTimeout: unknown): ResolvedRunTimeout {
  const ceiling = getPlatformRunLimits().timeout_ceiling_seconds;
  const declaredSeconds =
    typeof declaredTimeout === "number" ? declaredTimeout : DEFAULT_RUN_TIMEOUT_SECONDS;
  return {
    declaredSeconds,
    effectiveSeconds: Math.min(declaredSeconds, ceiling),
    capped: declaredSeconds > ceiling,
  };
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
