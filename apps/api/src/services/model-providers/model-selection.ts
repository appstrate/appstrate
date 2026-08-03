// SPDX-License-Identifier: Apache-2.0

/**
 * Model-list resolution — turn a provider definition's declarative
 * {@link ModelIdSelection} into concrete catalog ids.
 *
 * Two shapes reach here (see `ModelIdSelection` in `@appstrate/core/module`):
 *
 *   - an explicit array — passed through verbatim (deduped only). Right
 *     whenever the served set is defined by something the catalog does not
 *     model (the Codex ChatGPT sign-in set is documented by OpenAI and is
 *     deliberately narrower than the OpenAI API catalog).
 *   - a {@link CatalogModelSelector} — re-derived from the vendored catalog
 *     on every read. Right when the product tracks the vendor's current
 *     generation (`claude-code` serves whatever Anthropic currently ships).
 *
 * Why derive at all: a hand-curated list is a snapshot, and subscription
 * providers cannot re-check it empirically — `docs/architecture/
 * SUBSCRIPTION_COMPLIANCE.md` forbids ANY platform-side API call to test or
 * enumerate them. So the only non-rotting source is the vendored catalog,
 * which the weekly refresh keeps current. Deriving turns "stale for months
 * until someone notices" into "new generation appears at the next catalog
 * bump".
 *
 * Resolution is LAZY — called at each use site, never memoized at module
 * load. `registerCatalog()` can add or replace a catalog after this module is
 * imported (test fixtures, out-of-tree synthetic providers), and a cached
 * result would freeze the pre-registration answer.
 */

import { isCatalogModelSelector } from "@appstrate/core/module";
import type { ModelIdSelection, ModelProviderDefinition } from "@appstrate/core/module";
import { listCatalogModels } from "../pricing-catalog.ts";

// ---------------------------------------------------------------------------
// Model-id parsing — the single owner of the grammar
// ---------------------------------------------------------------------------
//
// Every consumer of "what generation is this model id" goes through
// `parseModelId` / `compareVersions` below, including the CI drift gate
// (`apps/api/test/unit/services/curated-model-drift.test.ts`). A second copy
// is not a stylistic problem here, it is a correctness one: the two copies
// disagreed on date detection, and the weaker one shipped — which let
// `gpt-5-2025-08-07` parse as version `[5, 2025, 8, 7]` and take the head of
// a featured list the contract documents as excluding dated aliases.

/**
 * A version segment is fully numeric, optionally dotted: `4`, `8`, `5.6`.
 * Both conventions in the vendored catalogs are covered — OpenAI dots the
 * minor (`gpt-5.6-sol`), Anthropic dashes it (`claude-opus-4-8`).
 */
const VERSION_SEGMENT = /^\d+(\.\d+)*$/;

/** Compact date stamp in a single segment: `claude-opus-4-20250514`. */
const COMPACT_DATE_SEGMENT = /^\d{6,}$/;

/** Leading segment of a dashed date stamp: `gpt-5-2025-08-07`. */
const YEAR_SEGMENT = /^(19|20)\d{2}$/;

/**
 * Zero-padded numeric segment: `gpt-4-0613`, `grok-4-0709`, `kimi-k2-0905`,
 * `gemini-2.0-flash-001`. A version number never carries a leading zero, while
 * `MMDD` release stamps and `NNN` revision suffixes routinely do. Checked
 * against every id in `apps/api/src/data/pricing/*.json`: 61 segments have
 * this shape and all 61 are stamps or revisions — no counter-example.
 */
const ZERO_PADDED_SEGMENT = /^0\d+$/;

/** Parsed `<stem>-<version…>[-<qualifier…>]` model id. */
export interface ParsedModelId {
  /** Leading run of non-version segments: `gpt`, `claude-opus`. */
  stem: string;
  /** Version tuple, most significant first: `[5, 6]`, `[4, 8]`. */
  version: number[];
  /** Everything after the version run, `""` when there is none: `sol`, `mini`. */
  qualifier: string;
}

/**
 * Parse a model id into stem + version + qualifier. Returns null when the id
 * carries no version at all (`gpt-4o`, `chatgpt-4o-latest`) or when it carries
 * a RELEASE STAMP anywhere — a stamped id duplicates a canonical one under a
 * snapshot name (`claude-opus-4-20250514` IS `claude-opus-4`), and its digits
 * would dominate every version comparison (`20250514` > `8`).
 *
 * Three stamp conventions across the vendored catalogs, so three detectors:
 * 6+ digits in one segment (Anthropic's `-20250514`), a year-shaped segment
 * followed by another numeric one (OpenAI's `-2025-08-07`), and a zero-padded
 * segment (xAI's `-0709`, OpenAI's `-0613`). All three scan the WHOLE id, not
 * just the version run — the stamp often sits behind a qualifier
 * (`gpt-5.4-mini-2026-03-17`).
 *
 * Known gap, accepted: an unpadded `YYMM` stamp is indistinguishable from a
 * version and stays one (`mistral-large-2512` → `[2512]`). Telling those apart
 * needs a per-vendor rule; the failure is local (the family orders by stamp,
 * which for `YYMM` still yields newest-first) unlike the stamps above, which
 * outranked every real version across families.
 */
export function parseModelId(id: string): ParsedModelId | null {
  const segments = id.split("-");
  const dated = segments.some(
    (s, i) =>
      COMPACT_DATE_SEGMENT.test(s) ||
      ZERO_PADDED_SEGMENT.test(s) ||
      (YEAR_SEGMENT.test(s) && VERSION_SEGMENT.test(segments[i + 1] ?? "")),
  );
  if (dated) return null;

  const versionStart = segments.findIndex((s) => VERSION_SEGMENT.test(s));
  // `<= 0` also rejects an id that STARTS with a number: no stem, nothing to
  // group or compare it against.
  if (versionStart <= 0) return null;

  let versionEnd = versionStart;
  while (versionEnd < segments.length && VERSION_SEGMENT.test(segments[versionEnd]!)) versionEnd++;

  return {
    stem: segments.slice(0, versionStart).join("-"),
    version: segments.slice(versionStart, versionEnd).flatMap((s) => s.split(".").map(Number)),
    qualifier: segments.slice(versionEnd).join("-"),
  };
}

/**
 * Compare two version tuples, ASCENDING (`a - b`). A missing segment counts
 * as 0, so `claude-opus-5` ([5]) outranks `claude-opus-4-8` ([4, 8]) — the
 * shorter tuple is not "older", it is a fresh major with no minor yet.
 */
export function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Parsed `<family>-<version>` catalog id. */
interface FamilyMatch {
  id: string;
  /** Numeric version segments, most significant first (`4-8` → `[4, 8]`). */
  version: number[];
}

/**
 * Parse `id` as a member of `family`. Stricter than {@link parseModelId} on
 * one point: a qualifier disqualifies the id. A family is a version LINE, and
 * `claude-opus-5-thinking` is a variant of `claude-opus-5`, not a generation
 * of its own — admitting it would let a variant tie with, and displace, the
 * canonical id in the `generations` window. Grouping (the drift gate) wants
 * the opposite and keeps the qualifier, which is why the distinction lives
 * here and not in the parser.
 */
function matchFamily(family: string, id: string): FamilyMatch | null {
  const parsed = parseModelId(id);
  if (!parsed || parsed.stem !== family || parsed.qualifier !== "") return null;
  return { id, version: parsed.version };
}

/**
 * Resolve one selection against `catalogProviderId`'s vendored catalog.
 *
 * Ordering is round-robin BY GENERATION, not family-by-family: the newest of
 * every family comes first, then every second-newest, and so on. That keeps
 * the head of the list "one current model per family" — which is what the
 * picker's Featured section surfaces — instead of burning the whole head on
 * the first family's back catalog.
 *
 * An unknown catalog resolves to `[]` rather than throwing: `listCatalogModels`
 * already returns `[]` for un-vendored providers, and a provider legitimately
 * declaring no catalog must not crash a read path.
 */
function resolveSelection(selection: ModelIdSelection, catalogProviderId: string): string[] {
  if (!isCatalogModelSelector(selection)) return [...new Set(selection)];

  const catalogIds = listCatalogModels(catalogProviderId).map((m) => m.id);

  // Per family: match → sort newest-first → keep `generations`.
  const perFamily = selection.catalogFamilies.map((family) =>
    catalogIds
      .map((id) => matchFamily(family, id))
      .filter((m): m is FamilyMatch => m !== null)
      .sort((a, b) => compareVersions(b.version, a.version)) // newest first
      .slice(0, Math.max(0, selection.generations))
      .map((m) => m.id),
  );

  // Round-robin by generation index; families that ran out are skipped.
  const ordered: string[] = [];
  const depth = Math.max(0, ...perFamily.map((ids) => ids.length));
  for (let gen = 0; gen < depth; gen++) {
    for (const ids of perFamily) {
      const id = ids[gen];
      if (id !== undefined) ordered.push(id);
    }
  }

  return [...new Set(ordered)];
}

/** Catalog key a provider's model ids resolve against. */
function catalogKeyOf(def: Pick<ModelProviderDefinition, "providerId" | "catalogProviderId">) {
  return def.catalogProviderId ?? def.providerId;
}

/**
 * Concrete ids for the picker's "Featured" section / `org_models` auto-seed.
 * Every returned id must exist in the resolved catalog — enforced at boot by
 * `registry.ts`'s `validateCatalogReferences`.
 */
export function resolveFeaturedModels(
  def: Pick<ModelProviderDefinition, "providerId" | "catalogProviderId" | "featuredModels">,
): string[] {
  return resolveSelection(def.featuredModels, catalogKeyOf(def));
}

/**
 * Concrete discovery candidates. Falls back to the featured selection when
 * `modelDiscoveryCandidates` is absent, mirroring the contract documented on
 * the field. Unlike featured ids these need NOT exist in the catalog (the
 * probe path may legitimately try an uncatalogued id).
 */
export function resolveDiscoveryCandidates(
  def: Pick<
    ModelProviderDefinition,
    "providerId" | "catalogProviderId" | "featuredModels" | "modelDiscoveryCandidates"
  >,
): string[] {
  return resolveSelection(def.modelDiscoveryCandidates ?? def.featuredModels, catalogKeyOf(def));
}

/**
 * Discovery candidates that exist in the resolved catalog — the set a
 * `mode: "static"` provider's credential can actually serve.
 *
 * The intersection mirrors the gate `POST /api/models/seed` applies (catalog
 * membership), so this list can never offer an id that seeding would then
 * reject. It is NOT redundant with a {@link CatalogModelSelector}, which is
 * catalog-derived by construction: an explicit array (codex) can perfectly
 * well name an id the vendored catalog does not carry yet.
 *
 * The probe path deliberately does not use this — an empirically verified id
 * is served whether or not the catalog knows about it, and the model form
 * falls back to an id-only entry for such ids.
 */
export function resolveCatalogBackedCandidates(
  def: Pick<
    ModelProviderDefinition,
    "providerId" | "catalogProviderId" | "featuredModels" | "modelDiscoveryCandidates"
  >,
): string[] {
  const catalogIds = new Set(listCatalogModels(catalogKeyOf(def)).map((m) => m.id));
  return resolveDiscoveryCandidates(def).filter((id) => catalogIds.has(id));
}
