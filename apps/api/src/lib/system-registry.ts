// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { logger } from "./logger.ts";

/**
 * Shared skeleton for the env-sourced "system registries" that back the
 * system+DB merge surfaces. It parses a JSON array from an env var, validates
 * every entry with Zod, skips invalid/duplicate entries with a logged error
 * (one bad entry never blocks the rest), and returns a `Map` keyed by `id`.
 *
 * Used by the two FLAT id-keyed registries — model-provider keys
 * (`model-registry.ts` / `SYSTEM_PROVIDER_KEYS`) and proxies (`proxy-registry.ts`
 * / `SYSTEM_PROXIES`) — which hand-rolled this identical parse→validate→
 * dedupe→log loop. The integration registry (`integration-client-registry.ts` /
 * `SYSTEM_INTEGRATIONS`) keeps its own loop: its entries are a NESTED
 * integration→clients[] shape (one entry yields a set membership plus N
 * flattened clients), which doesn't fit this one-entry-one-id Map. Callers keep
 * their own typed accessors over the returned Map.
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
   *
   * NOTE: when `toDefinition` has side effects, also supply `idOf` so a
   * duplicate id is rejected BEFORE the mapper runs — otherwise the side effect
   * fires for an entry that is then dropped (the def is skipped but its
   * secondary-map writes already happened, leaving the two maps inconsistent).
   */
  toDefinition: (raw: Raw) => Def | null;
  /**
   * Extract the dedupe key from a validated entry, evaluated BEFORE
   * `toDefinition`. Supply this whenever `toDefinition` mutates external state:
   * a duplicate is skipped without ever invoking the side-effecting mapper. When
   * omitted, dedupe falls back to `def.id` after mapping (safe only for pure
   * mappers). Must agree with the resulting `def.id`.
   */
  idOf?: (raw: Raw) => string;
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
    // Pre-map dedupe: reject a duplicate before any side-effecting mapper runs.
    if (opts.idOf) {
      const id = opts.idOf(parsed.data);
      if (byId.has(id)) {
        logger.error(`[${opts.name}] ${opts.envVar}: skipping duplicate id`, { id });
        continue;
      }
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
