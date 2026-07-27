// SPDX-License-Identifier: Apache-2.0

/**
 * Blocking gate — a CURATED subscription model list must not silently fall
 * behind the vendored catalog.
 *
 * Most model lists no longer rot: a {@link CatalogModelSelector} (claude-code)
 * re-derives from the catalog on every read, so the weekly pricing refresh
 * carries a new generation through on its own. The exception is a provider
 * whose served set is defined by vendor DOCUMENTATION rather than by the
 * catalog — `codex`, whose ChatGPT sign-in set is deliberately narrower than
 * the OpenAI API catalog (deriving would over-list `-nano`, `-search-api`, the
 * `-chat-latest` aliases…). That list is an explicit array, a human writes it,
 * and `docs/architecture/SUBSCRIPTION_COMPLIANCE.md` forbids ANY probe that
 * could correct it empirically. It sat two generations behind while nothing
 * complained — this test is what complains now.
 *
 * The gate is generic over "static provider with an explicit array", not
 * hardcoded to codex: the next subscription module gets the same protection by
 * existing. Tests are the blocking CI gate here, hence a test and not a new
 * workflow.
 *
 * ## The escape hatch — `apps/api/src/data/subscription-watch/reviewed.json`
 *
 * Plenty of catalog ids are legitimately NOT served by a subscription, so a
 * bare "catalog ⊆ curated" rule would be permanently red. `reviewed.json` maps
 * `{ "<providerId>": ["<catalog id>", …] }`. JSON has no comments, so the
 * semantics live here:
 *
 *   **An entry means: a human read the vendor's subscription doc on the date
 *   in the git history of that line, and the model is NOT served by the
 *   subscription.** It is a decision record, not a mute button — adding an id
 *   without checking the doc defeats the whole mechanism.
 *
 * Seeded 2026-07-27 against https://learn.chatgpt.com/docs/models (Codex with
 * ChatGPT sign-in). The doc's set is exactly `5.6 Sol/Terra/Luna`, `5.5`,
 * `5.3 Codex Spark`, `5.4`, `5.4 Mini` — i.e. exactly the curated list. The
 * three excused ids are catalog neighbours the doc does NOT name:
 *   - `gpt-5.3-chat-latest` — a chat-surface alias, absent from the Codex
 *     page. It ties the review floor (`gpt-5.3-codex-spark`), so it is the id
 *     the `>=` boundary below exists to surface rather than skip.
 *   - `gpt-5.4-nano` — API-only tier. The doc lists `gpt-5.4` and
 *     `gpt-5.4-mini` for ChatGPT sign-in; `-nano` appears nowhere on it.
 *   - `gpt-5.6` — the plain id is the API model. Codex sign-in serves the
 *     documented `-sol` / `-terra` / `-luna` variants, which ARE curated.
 *
 * ## The review floor is the OLDEST curated version, not the newest
 *
 * Comparing against the newest curated version would only catch "the vendor
 * shipped a whole new major", and would miss the likelier drift: a new sibling
 * landing INSIDE the current generation (a hypothetical `gpt-5.6-mini` next to
 * `gpt-5.6-sol` compares equal, not greater). Anchoring on the oldest curated
 * version instead asserts the stronger, checkable property: every catalog id
 * at or above the generation the curator was already working in has been
 * looked at — curated or explicitly excused. Everything older is out of scope
 * (nobody needs to re-review `gpt-4o`).
 *
 * "At or above" is inclusive in the code too (`>=`): an equal-version sibling
 * IS the case the paragraph above describes, so a strict `>` would have
 * re-opened the same hole one generation lower. `gpt-5.3-chat-latest` — which
 * ties the codex floor — is the live proof it would have slipped through.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { isCatalogModelSelector } from "@appstrate/core/module";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  listModelProviders,
  registerModelProvider,
} from "../../../src/services/model-providers/registry.ts";
import { resolveDiscoveryCandidates } from "../../../src/services/model-providers/model-selection.ts";
import { listCatalogModels, registerCatalog } from "../../../src/services/pricing-catalog.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import reviewedFile from "../../../src/data/subscription-watch/reviewed.json" with { type: "json" };
import type { CatalogModelEntry } from "@appstrate/shared-types";

const reviewed = reviewedFile as Record<string, readonly string[]>;

// ---------------------------------------------------------------------------
// Model-id parsing
// ---------------------------------------------------------------------------

/**
 * A version segment is fully numeric, optionally dotted: `4`, `8`, `5.6`.
 * Both id conventions in this repo are covered — OpenAI dots the minor
 * (`gpt-5.6-sol`), Anthropic dashes it (`claude-opus-4-8`).
 */
const VERSION_SEGMENT = /^\d+(\.\d+)*$/;

/** Compact date stamp in a single segment: `claude-opus-4-20250514`. */
const COMPACT_DATE_SEGMENT = /^\d{6,}$/;

/** Leading segment of a dashed date stamp: `gpt-5.5-2026-04-23`. */
const YEAR_SEGMENT = /^(19|20)\d{2}$/;

interface ParsedModelId {
  /** Leading run of non-version segments: `gpt`, `claude-opus`. */
  stem: string;
  /** Version tuple, most significant first: `[5, 6]`, `[4, 8]`. */
  version: number[];
}

/**
 * Parse `<stem>-<version…>[-<qualifier…>]`. Returns null when the id carries
 * no version at all (`gpt-4o`, `chatgpt-4o-latest`) or when it carries a DATE
 * STAMP anywhere — those are snapshot aliases of a canonical id and would
 * otherwise be reported forever (`gpt-5.4-mini-2026-03-17` is `gpt-5.4-mini`,
 * already curated, wearing a release date).
 *
 * Two date conventions, so two detectors: 6+ digits in one segment (Anthropic's
 * `-20250514`), or a year segment followed by more numbers (OpenAI's
 * `-2026-04-23`). Both scan the WHOLE id, not just the version run — the stamp
 * often sits behind a qualifier (`…-mini-2026-03-17`). A 4-digit segment that
 * is NOT year-shaped and NOT followed by more numbers stays a version
 * (`gpt-4-0613` → `[4, 613]`) — harmless, it can only sort below anything a
 * curator is currently working on.
 */
function parseModelId(id: string): ParsedModelId | null {
  const segments = id.split("-");
  const dated = segments.some(
    (s, i) =>
      COMPACT_DATE_SEGMENT.test(s) ||
      (YEAR_SEGMENT.test(s) && VERSION_SEGMENT.test(segments[i + 1] ?? "")),
  );
  if (dated) return null;

  const versionStart = segments.findIndex((s) => VERSION_SEGMENT.test(s));
  // `<= 0` also rejects an id that STARTS with a number: no stem, nothing to
  // compare it against.
  if (versionStart <= 0) return null;

  const versionSegments: string[] = [];
  for (let i = versionStart; i < segments.length && VERSION_SEGMENT.test(segments[i]!); i++) {
    versionSegments.push(segments[i]!);
  }

  return {
    stem: segments.slice(0, versionStart).join("-"),
    version: versionSegments.flatMap((s) => s.split(".").map(Number)),
  };
}

/** Lexicographic compare; a missing segment counts as 0 (`[5]` > `[4, 8]`). */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

/**
 * Providers this gate applies to: `mode: "static"` (no probe can ever correct
 * the list) AND an explicit array (a selector re-derives itself, so there is
 * nothing to fall behind). Mirrors the production fallback — an absent
 * `modelDiscoveryCandidates` means the featured selection IS the served set.
 */
function isCuratedStaticProvider(def: ModelProviderDefinition): boolean {
  if (def.modelDiscovery?.mode !== "static") return false;
  return !isCatalogModelSelector(def.modelDiscoveryCandidates ?? def.featuredModels);
}

function gatedProviders(): ModelProviderDefinition[] {
  return listModelProviders().filter(isCuratedStaticProvider);
}

/** Catalog ids newer than the curated floor that are neither curated nor excused. */
function findDrift(def: ModelProviderDefinition): string[] {
  // Reuse the production resolver rather than reading the raw field: it
  // applies the same `?? featuredModels` fallback and dedupe the platform
  // applies, so the gate can never guard a list nobody serves.
  const curated = resolveDiscoveryCandidates(def);
  const curatedIds = new Set(curated);

  const floorByStem = new Map<string, number[]>();
  for (const id of curated) {
    const parsed = parseModelId(id);
    if (!parsed) continue;
    const floor = floorByStem.get(parsed.stem);
    if (!floor || compareVersions(parsed.version, floor) < 0) {
      floorByStem.set(parsed.stem, parsed.version);
    }
  }

  const excused = new Set(reviewed[def.providerId] ?? []);
  return listCatalogModels(def.catalogProviderId ?? def.providerId)
    .map((m) => m.id)
    .filter((id) => {
      if (curatedIds.has(id) || excused.has(id)) return false;
      const parsed = parseModelId(id);
      if (!parsed) return false;
      const floor = floorByStem.get(parsed.stem);
      // `>= 0`, not `> 0`: the floor is a generation boundary, not a
      // high-water mark. An id sitting EXACTLY at the floor generation is the
      // "new sibling inside the current generation" case this floor choice
      // exists to catch (`gpt-5.3-chat-latest` next to `gpt-5.3-codex-spark`).
      // Curated ids can never self-flag — `curatedIds.has(id)` returns above,
      // before any comparison runs.
      return floor !== undefined && compareVersions(parsed.version, floor) >= 0;
    })
    .sort();
}

/** Empty string when clean — the value the assertion compares, so the whole remedy prints on failure. */
function driftReport(def: ModelProviderDefinition): string {
  const drift = findDrift(def);
  if (drift.length === 0) return "";
  const catalog = def.catalogProviderId ?? def.providerId;
  const doc = def.docsUrl
    ? `the vendor's subscription doc (${def.docsUrl})`
    : "the vendor's subscription doc";
  return [
    `[${def.providerId}] the vendored "${catalog}" catalog holds model ids newer than the curated`,
    `subscription list, and nobody has ruled on them: ${drift.join(", ")}.`,
    ``,
    `Check ${doc}, then for EACH id either:`,
    `  - add it to \`modelDiscoveryCandidates\` on the "${def.providerId}" provider definition`,
    `    (packages/module-${def.providerId}/src/index.ts) if the subscription serves it, or`,
    `  - record it under "${def.providerId}" in apps/api/src/data/subscription-watch/reviewed.json`,
    `    if it does not — that file is a decision record, see the header of this test.`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SYNTHETIC_CATALOG = "test-curated-drift";
const SYNTHETIC_PROVIDER = "test-curated-drift-provider";

const ENTRY: CatalogModelEntry = {
  label: "synthetic",
  contextWindow: 1000,
  maxTokens: 100,
  capabilities: ["text"],
  cost: { input: 0, output: 0 },
};

beforeAll(() => {
  // The canonical baseline, which already carries the REAL codex and
  // claude-code definitions: the root test preload discovers `packages/module-*`
  // alongside the built-in `apps/api/src/modules/*`, and `seedTestModelProviders`
  // registers every discovered module's contribution. Re-registering them by
  // hand would throw on the duplicate id as soon as another file seeded first.
  // Real definitions matter here — a synthetic stand-in would stay green while
  // the shipped list rots, which is the exact failure being closed.
  seedTestModelProviders();

  // A catalog that HAS advanced past its curated list — pins that the gate
  // still bites. Without it a parsing regression could turn the check into a
  // permanent pass and nothing would notice.
  registerCatalog(
    SYNTHETIC_CATALOG,
    Object.fromEntries(
      ["syn-1", "syn-2", "syn-2-mini", "syn-3", "syn-3-20260101", "syn-legacy"].map((id) => [
        id,
        ENTRY,
      ]),
    ),
  );
  registerModelProvider({
    providerId: SYNTHETIC_PROVIDER,
    displayName: "Synthetic curated",
    iconUrl: "openai",
    description: "Static provider whose curated list trails its catalog.",
    apiShape: "openai-responses",
    defaultBaseUrl: "https://synthetic.example.test",
    baseUrlOverridable: false,
    authMode: "api_key",
    catalogProviderId: SYNTHETIC_CATALOG,
    featuredModels: ["syn-2"],
    modelDiscovery: { mode: "static" },
  });
});

afterAll(() => {
  // `bun test` shares one process and the registry rejects duplicate ids —
  // restore the canonical baseline or the next file boots on a dirty registry.
  seedTestModelProviders();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("curated subscription lists vs the vendored catalog", () => {
  it("keeps every curated static list current (or explicitly reviewed)", () => {
    for (const def of gatedProviders()) {
      if (def.providerId === SYNTHETIC_PROVIDER) continue;
      expect(driftReport(def)).toBe("");
    }
  });

  it("gates codex and skips catalog-derived selectors", () => {
    const ids = gatedProviders().map((d) => d.providerId);
    expect(ids).toContain("codex");
    // `claude-code` declares a CatalogModelSelector: it re-derives on every
    // read, so there is no curation to fall behind and no gate to apply.
    expect(ids).not.toContain("claude-code");
  });

  it("reports drift when the catalog moves ahead of the curated list", () => {
    const def = listModelProviders().find((d) => d.providerId === SYNTHETIC_PROVIDER)!;
    // Floor = `syn-2` (the only curated id). Reported: `syn-3` (newer) AND
    // `syn-2-mini` (a sibling AT the floor generation — the inclusive
    // boundary). Not reported: `syn-2` itself (curated ids are filtered before
    // any comparison, so the floor can never self-flag), `syn-1` (older),
    // `syn-legacy` (no version), `syn-3-20260101` (dated alias).
    expect(findDrift(def)).toEqual(["syn-2-mini", "syn-3"]);
    expect(driftReport(def)).toContain("syn-3");
    expect(driftReport(def)).toContain("reviewed.json");
  });
});

describe("model-id parsing", () => {
  it("handles both version conventions", () => {
    expect(parseModelId("gpt-5.6-sol")).toEqual({ stem: "gpt", version: [5, 6] });
    expect(parseModelId("gpt-5.4-mini")).toEqual({ stem: "gpt", version: [5, 4] });
    expect(parseModelId("claude-opus-4-8")).toEqual({ stem: "claude-opus", version: [4, 8] });
  });

  it("ignores date-stamped snapshot aliases in both conventions", () => {
    expect(parseModelId("gpt-5.5-2026-04-23")).toBeNull();
    expect(parseModelId("claude-opus-4-20250514")).toBeNull();
    // The stamp behind a qualifier — this one is an alias of the already
    // curated `gpt-5.4-mini`, and missing it made the gate cry wolf.
    expect(parseModelId("gpt-5.4-mini-2026-03-17")).toBeNull();
  });

  it("ignores ids that carry no version", () => {
    expect(parseModelId("gpt-4o")).toBeNull();
    expect(parseModelId("chatgpt-4o-latest")).toBeNull();
  });

  it("orders a bare major above a dotted minor of the previous one", () => {
    // `claude-opus-5` is newer than `claude-opus-4-8`: a shorter tuple is a
    // fresh major with no minor yet, not an older release.
    expect(compareVersions([5], [4, 8])).toBeGreaterThan(0);
    expect(compareVersions([5, 6], [5, 6])).toBe(0);
  });
});
