// SPDX-License-Identifier: Apache-2.0

/**
 * The `compat` flags every model record the PLATFORM prices must carry.
 *
 * This exists as one constant because the reason below is one reason, and it
 * was previously spelled out three times, in three packages, as three
 * hand-written `supportsLongCacheRetention: false` literals with three long
 * comments — while two of the five model builders carried neither. A rule that
 * has to be remembered at each new construction site is a convention; a
 * constant that every site spreads is a rule.
 *
 * ## Why long cache retention is refused
 *
 * The platform cannot price what it would produce. Anthropic bills a 1h cache
 * write at 2x the input rate, and a `ModelCost` record (`@appstrate/core`,
 * `computeTokenCost` in `@appstrate/afps-runtime/runner`) carries ONE
 * `cacheWrite` rate, not two. A long-retention write is therefore metered at
 * the short-retention price and the org is under-billed.
 *
 * pi-ai gates every long-retention emission on this single flag —
 * `cache_control.ttl: "1h"` for anthropic-messages, `prompt_cache_retention`
 * for both OpenAI shapes — and reads it as `model.compat?.… ?? true`. Silence
 * is consent: the record has to refuse OUT LOUD. It then resolves each
 * request's retention from `options.cacheRetention` and, failing that,
 * `process.env.PI_CACHE_RETENTION`. Both are reachable by someone the platform
 * does not control — agent code assigns to `process.env` from inside its own
 * container, and the CLI runs on the user's own machine — so refusing the
 * option at the boundary is necessary and NOT sufficient. This flag is the
 * sufficient half, and it holds for any value anyone picks.
 *
 * Turning it back on is a pricing change, not a performance tweak: it needs a
 * second cache-write rate in the catalog and in `computeTokenCost` first.
 *
 * Spread it rather than assigning it, so a site that needs an additional
 * per-record flag (the sidecar's `forceAdaptiveThinking`) can add one without
 * dropping these:
 *
 * ```ts
 * compat: { ...PLATFORM_MODEL_COMPAT, ...(adaptive ? { forceAdaptiveThinking: true } : {}) }
 * ```
 *
 * Coverage is pinned by `apps/api/test/unit/model-compat-coverage.test.ts`,
 * which enumerates the model builders and fails on a new one that omits this.
 */
export const PLATFORM_MODEL_COMPAT = {
  supportsLongCacheRetention: false,
} as const;
