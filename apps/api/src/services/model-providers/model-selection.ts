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

/**
 * A dated alias is a catalog id whose last segment is a date stamp
 * (`claude-opus-4-20250514`, `claude-haiku-4-5-20251001`). Six or more digits
 * is the discriminator: real version segments are one or two digits, date
 * stamps are `YYYYMMDD`. These duplicate a canonical id under a snapshot name
 * and would otherwise dominate the version ordering (`20250514` > `8`).
 */
const DATED_ALIAS_MIN_DIGITS = 6;

/** Parsed `<family>-<version>` catalog id. */
interface FamilyMatch {
  id: string;
  /** Numeric version segments, most significant first (`4-8` → `[4, 8]`). */
  version: number[];
}

/**
 * Parse `id` as a member of `family`. Returns null when the id does not carry
 * the `<family>-<numeric-version>` shape, or when the version tail is a dated
 * alias.
 */
function matchFamily(family: string, id: string): FamilyMatch | null {
  if (!id.startsWith(`${family}-`)) return null;
  const tail = id.slice(family.length + 1);
  const segments = tail.split("-");
  if (segments.some((s) => !/^\d+$/.test(s))) return null;
  if (segments[segments.length - 1]!.length >= DATED_ALIAS_MIN_DIGITS) return null;
  return { id, version: segments.map((s) => Number(s)) };
}

/**
 * Compare two version tuples, newest first. A missing segment counts as 0 so
 * `claude-opus-5` ([5]) outranks `claude-opus-4-8` ([4, 8]) — the shorter
 * tuple is not "older", it is a fresh major with no minor yet.
 */
function compareVersionsDesc(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const diff = (b[i] ?? 0) - (a[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Resolve one selection against `catalogProviderId`'s vendored catalog.
 *
 * Ordering is round-robin BY GENERATION, not family-by-family: the newest of
 * every family comes first, then every second-newest, and so on. That keeps
 * the head of the list "one current model per family" — which is what the
 * picker's Featured section and a `limit` should surface — instead of burning
 * the whole budget on the first family's back catalog.
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
      .sort((a, b) => compareVersionsDesc(a.version, b.version))
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

  const deny = new Set(selection.deny ?? []);
  const kept = [...new Set(ordered)].filter((id) => !deny.has(id));
  return selection.limit === undefined ? kept : kept.slice(0, selection.limit);
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
