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
 * Create a cached, Zod-validated environment variable accessor.
 * Parses `process.env` against the provided schema on first call and caches the result.
 * @param schema - Zod schema to validate process.env against
 * @returns An EnvGetter with getEnv() and resetCache() methods
 * @throws Error if environment variables fail schema validation
 */
export function createEnvGetter<T extends z.ZodType>(schema: T): EnvGetter<z.infer<T>> {
  let cached: z.infer<T> | null = null;

  function getEnv(): z.infer<T> {
    if (cached) return cached;
    const result = schema.safeParse(process.env);
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
