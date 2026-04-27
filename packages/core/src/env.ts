// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

import type { z } from "zod";

/** Cached environment variable accessor with schema validation. */
export interface EnvGetter<T> {
  /** Parse and return validated environment variables (cached after first call). */
  getEnv(): T;
  /** Clear the cached environment so the next getEnv() re-parses process.env. */
  resetCache(): void;
}

/**
 * Coalesce empty strings to `undefined` across the entire `process.env`
 * snapshot before Zod sees it.
 *
 * Docker Compose's `${VAR:-}` pattern forwards an unset host variable to
 * the container as an empty string (`VAR=`), not as a missing key. Zod's
 * `.default(...)` only fires on `undefined`, so without this preprocess
 * any refined-string field with a default (booleans, regex-validated kid
 * IDs, enums) would crash boot on a literal `VAR=` with a cryptic
 * "must be …" error.
 *
 * Coalescing once at the root makes `.default(...)` the single source of
 * truth for fallback behavior on EVERY field — no per-field opt-in
 * helper, no behavioral drift between fields. For env vars,
 * "explicitly empty" and "unset" are conceptually identical (the host
 * never sets a variable to a meaningful empty string), so the universal
 * coalesce is safe.
 */
function sanitizeEnv(input: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = v === "" ? undefined : v;
  }
  return out;
}

/**
 * Create a cached, Zod-validated environment variable accessor.
 *
 * Parses `process.env` against the provided schema on first call and
 * caches the result. Empty-string values are coalesced to `undefined`
 * before validation so `.default(...)` fires uniformly for compose's
 * `${VAR:-}` pattern (see {@link sanitizeEnv}).
 *
 * @param schema - Zod schema to validate process.env against
 * @returns An EnvGetter with getEnv() and resetCache() methods
 * @throws Error if environment variables fail schema validation
 */
export function createEnvGetter<T extends z.ZodType>(schema: T): EnvGetter<z.infer<T>> {
  let cached: z.infer<T> | null = null;

  function getEnv(): z.infer<T> {
    if (cached) return cached;
    const result = schema.safeParse(sanitizeEnv(process.env));
    if (!result.success) {
      const issues = result.error.issues.map(
        (i) => `  - ${String(i.path.join("."))}: ${i.message}`,
      );
      throw new Error(`[env] Invalid environment variables:\n${issues.join("\n")}`);
    }
    cached = result.data;
    return cached;
  }

  function resetCache(): void {
    cached = null;
  }

  return { getEnv, resetCache };
}
