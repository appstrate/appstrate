// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { logger } from "./logger.ts";

/**
 * Shared skeleton for the env-sourced "system registries" that back the
 * system+DB merge surfaces (integration OAuth clients, model-provider keys,
 * proxies). Each one parses a JSON array from an env var, validates every entry
 * with Zod, skips invalid/duplicate entries with a logged error (one bad entry
 * never blocks the rest), and returns a `Map` keyed by `id`. The three
 * registries hand-rolled this identical parse→validate→dedupe→log loop; this
 * centralizes it. Callers keep their own typed accessors over the returned Map.
 */

export interface LoadSystemRegistryOptions<Raw, Def extends { id: string }> {
  /** Log prefix / source label, e.g. `"proxy-registry"`. */
  name: string;
  /** Env var the entries came from, e.g. `"SYSTEM_PROXIES"` — for error context. */
  envVar: string;
  /** Raw entries already read from the env (or a test override). */
  entries: unknown[];
  /** Per-entry validation schema. */
  schema: z.ZodType<Raw>;
  /**
   * Map a validated entry to its registry definition, or return `null` to skip
   * it (the mapper logs its own reason — e.g. an unknown provider id). May have
   * side effects (e.g. populating a secondary map). `id` must be set so
   * duplicates can be detected.
   */
  toDefinition: (raw: Raw) => Def | null;
  /** Redact an entry before logging an invalid-entry error (drop secrets). */
  redact?: (entry: unknown) => unknown;
}

/**
 * Load one env-sourced system registry into an id-keyed Map. Invalid entries
 * (schema failure, mapper-rejected, duplicate id) are skipped with a logged
 * error and never abort the load.
 */
export function loadSystemRegistry<Raw, Def extends { id: string }>(
  opts: LoadSystemRegistryOptions<Raw, Def>,
): Map<string, Def> {
  const byId = new Map<string, Def>();
  for (const entry of opts.entries) {
    const parsed = opts.schema.safeParse(entry);
    if (!parsed.success) {
      logger.error(`[${opts.name}] ${opts.envVar}: skipping invalid entry`, {
        error: parsed.error.issues[0]?.message,
        entry: opts.redact ? opts.redact(entry) : entry,
      });
      continue;
    }
    const def = opts.toDefinition(parsed.data);
    if (def === null) continue; // mapper logged its own reason
    if (byId.has(def.id)) {
      logger.error(`[${opts.name}] ${opts.envVar}: skipping duplicate id`, { id: def.id });
      continue;
    }
    byId.set(def.id, def);
  }
  logger.info(`[${opts.name}] loaded`, { count: byId.size });
  return byId;
}
