// SPDX-License-Identifier: Apache-2.0

/**
 * Blocking gate — a CURATED subscription model list must not silently fall
 * behind what we know the vendor ships.
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
 * ## What the curated list is compared AGAINST
 *
 * The union of two vendored sources (see `observedIds`): the pricing catalog
 * (`openai.json` for codex) and the provider's subscription-watch snapshot
 * (`chatgpt.json`). Neither alone is enough — 7 of the 10 snapshot ids are
 * absent from the pricing catalog, and they are the subscription-specific ones
 * (`-codex*`, `-instant`, `-pro`) a reviewer most needs to rule on, while the
 * snapshot in turn lags the catalog (it carries neither `gpt-5.5` nor the
 * `5.6` family).
 *
 * Both sources are FEEDS, and the vendor doc outranks them. When they
 * disagree, the doc wins and the loser's ids get a `reviewed.json` entry.
 *
 * ## The escape hatch — `apps/api/src/data/subscription-watch/reviewed.json`
 *
 * Plenty of observed ids are legitimately NOT served by a subscription, so a
 * bare "observed ⊆ curated" rule would be permanently red. `reviewed.json`
 * maps `{ "<providerId>": ["<model id>", …] }`. JSON has no comments, so the
 * semantics live here:
 *
 *   **An entry means: a human read the vendor's subscription doc on the date
 *   in the git history of that line, and the model is NOT served by the
 *   subscription.** It is a decision record, not a mute button — adding an id
 *   without checking the doc defeats the whole mechanism.
 *
 * The file is a ratchet by nature (an excused id is never re-examined, and one
 * below the current floor is unreachable by `findDrift` forever), so one test
 * pushes back the other way: every excused id must still be OBSERVED in some
 * vendored source. An excuse for a model the vendor has retired is a claim
 * nothing can falsify any more, and it must be deleted rather than inherited.
 *
 * Seeded 2026-07-27 against https://learn.chatgpt.com/docs/models (Codex with
 * ChatGPT sign-in). The doc's set is exactly recommended `5.6 Sol/Terra/Luna`,
 * `5.5`, `5.3 Codex Spark` plus other-available `5.4`, `5.4 Mini` — i.e.
 * exactly the curated list. Every excused id, with its reason:
 *
 *   Explicitly DEPRECATED for ChatGPT sign-in by that doc:
 *   - `gpt-5.2`, `gpt-5.3-codex` — both named on the page as no longer
 *     available to sign-in users. Both are still in the LiteLLM snapshot,
 *     which is how a lagging feed looks.
 *
 *   ABSENT from the doc while present in the LiteLLM `chatgpt` snapshot — the
 *   snapshot is a third-party reconstruction and trails the vendor page (it
 *   lists neither `gpt-5.5` nor any `5.6`), so absence from the doc decides:
 *   - `gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2-codex` — retired
 *     Codex model line, superseded by `gpt-5.3-codex-spark`.
 *   - `gpt-5.3-instant` — a ChatGPT chat-surface model, not a Codex one.
 *   - `gpt-5.4-pro` — Pro *plan* tier; the Codex sign-in page does not offer
 *     it.
 *
 *   Pricing-catalog neighbours the doc does NOT name:
 *   - `gpt-5.3-chat-latest` — a chat-surface alias. It ties the review floor
 *     (`gpt-5.3-codex-spark`), so it is the id the `>=` boundary below exists
 *     to surface rather than skip.
 *   - `gpt-5.4-nano` — API-only tier. The doc lists `gpt-5.4` and
 *     `gpt-5.4-mini` for ChatGPT sign-in; `-nano` appears nowhere on it.
 *   - `gpt-5.6` — the plain id is the API model. Codex sign-in serves the
 *     documented `-sol` / `-terra` / `-luna` variants, which ARE curated.
 *   - `gpt-5.6-cyber` — reviewed 2026-08-24 against the same doc, which
 *     arrived with the pricing refresh in #1205. The page's 5.6 family is
 *     exactly `5.6 Sol` / `5.6 Terra` / `5.6 Luna`; no `Cyber` appears on it,
 *     and the security capability the name suggests is attributed to Sol
 *     ("complex coding, computer use, research, and cybersecurity"). So it is
 *     an API-catalog sibling, and the ChatGPT sign-in set does not serve it.
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
 *
 * Because the floor is per-STEM, four of the codex entries in `reviewed.json`
 * (`gpt-5.1-codex-max`, `gpt-5.1-codex-mini`, `gpt-5.2`, `gpt-5.2-codex`) sit
 * below the current floor and are inert today. They are recorded anyway: they
 * were dropped from the served list by a human reading the doc, and that is
 * what the file is for. They also stop being inert the day the curated list
 * drops back to their generation.
 *
 * ## Known blind spot — a brand-new STEM is never compared
 *
 * The floor is keyed by stem, so an id whose stem is absent from the curated
 * list (`o5-preview`, `codex-max-2`, anything OpenAI names off the `gpt-` line)
 * has no floor to be measured against and is silently skipped. A whole new
 * product line is therefore invisible to this gate. That is deliberate: the
 * alternative — flagging every unknown stem — would report the entire back
 * catalog of every provider on day one, and the machinery to suppress that
 * again (per-stem opt-outs, a stem allow-list) would cost more than the human
 * habit it replaces. The weekly catalog-refresh PR still shows a new stem in
 * its diff; this gate covers the drift that PR is easy to skim past, namely a
 * new member of a line we already serve.
 */

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { isCatalogModelSelector } from "@appstrate/core/module";
import type { ModelProviderDefinition } from "@appstrate/core/module";
import {
  listModelProviders,
  registerModelProvider,
} from "../../../src/services/model-providers/registry.ts";
import {
  compareVersions,
  parseModelId,
  resolveDiscoveryCandidates,
} from "../../../src/services/model-providers/model-selection.ts";
import { listCatalogModels, registerCatalog } from "../../../src/services/pricing-catalog.ts";
import { seedTestModelProviders } from "../../helpers/model-providers.ts";
import reviewedFile from "../../../src/data/subscription-watch/reviewed.json" with { type: "json" };
import chatgptWatch from "../../../src/data/subscription-watch/chatgpt.json" with { type: "json" };
import type { CatalogModelEntry } from "@appstrate/shared-types";

const reviewed = reviewedFile as Record<string, readonly string[]>;

// ---------------------------------------------------------------------------
// The observed set
// ---------------------------------------------------------------------------

/**
 * Provider → the subscription-watch snapshots that describe the same product.
 *
 * The vendored PRICING catalog is not the whole picture for a subscription
 * provider. `codex` resolves against `openai.json` (the API catalog), but 7 of
 * the 10 ids in the `chatgpt` snapshot — every `-codex*` id, `gpt-5.3-instant`,
 * `gpt-5.4-pro` — appear nowhere in it. Those are precisely the
 * subscription-specific ids a reviewer must rule on, so a gate that only reads
 * the pricing catalog is blind to exactly the ids it exists for.
 *
 * The link is one line of configuration and lives here on purpose: nothing in
 * production reads these snapshots (`scripts/refresh-pricing-catalog.ts` only
 * writes them), so adding a field to `ModelProviderDefinition` would put a
 * test-only concern in the published module contract. The cost of that choice
 * is that a new subscription module must remember to add its line — hence the
 * `codex` assertion below, which fails if the mapping ever stops resolving.
 */
const WATCH_SNAPSHOTS: Record<string, readonly string[]> = {
  codex: chatgptWatch as string[],
};

/**
 * Every id the gate is willing to rule on for `def`: pricing catalog ∪ watch
 * snapshot. Union, not replacement — the catalog carries ids the LiteLLM
 * snapshot lacks (it does not even list `gpt-5.5` or the `5.6` family) and the
 * snapshot carries ids the catalog lacks. Neither source alone is complete;
 * both lag the vendor doc, which is why an entry in `reviewed.json` records a
 * human reading the doc rather than a machine reading a feed.
 */
function observedIds(def: ModelProviderDefinition): string[] {
  const catalog = listCatalogModels(def.catalogProviderId ?? def.providerId).map((m) => m.id);
  return [...new Set([...catalog, ...(WATCH_SNAPSHOTS[def.providerId] ?? [])])];
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

/** Observed ids at or above the curated floor that are neither curated nor excused. */
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
  return observedIds(def)
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
  const sources = WATCH_SNAPSHOTS[def.providerId]
    ? `the vendored "${catalog}" catalog and the subscription-watch snapshot`
    : `the vendored "${catalog}" catalog`;
  const doc = def.docsUrl
    ? `the vendor's subscription doc (${def.docsUrl})`
    : "the vendor's subscription doc";
  return [
    `[${def.providerId}] ${sources} hold model ids at or above the curated`,
    `subscription list's generation, and nobody has ruled on them: ${drift.join(", ")}.`,
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

  it("keeps reviewed.json free of ids no source observes any more", () => {
    // Without this, `reviewed.json` is a one-way ratchet: an excused id is
    // never looked at again, and one below the current floor is unreachable by
    // `findDrift` forever — so a vendor RETIRING a model leaves its excuse
    // sitting there as an unfalsifiable claim about a model that no longer
    // exists. Requiring every excused id to still be observed somewhere
    // (catalog ∪ watch snapshot) forces the cleanup the ratchet otherwise
    // defers indefinitely, and it is the only pressure on the inert entries
    // (`gpt-5.2`, the `5.1-codex-*` pair) the header calls out.
    const stale: string[] = [];
    for (const [providerId, ids] of Object.entries(reviewed)) {
      const def = listModelProviders().find((d) => d.providerId === providerId);
      if (!def) {
        stale.push(`${providerId}: * (no such model provider is registered)`);
        continue;
      }
      const observed = new Set(observedIds(def));
      for (const id of ids) if (!observed.has(id)) stale.push(`${providerId}: ${id}`);
    }
    expect(
      stale.length === 0
        ? ""
        : [
            `reviewed.json excuses ids that no vendored source observes any more: ${stale.join(", ")}.`,
            `An excuse is a decision about a model the vendor ships; once the model is gone from both`,
            `the pricing catalog and the subscription-watch snapshot, the entry is dead weight —`,
            `delete it from apps/api/src/data/subscription-watch/reviewed.json.`,
          ].join("\n"),
    ).toBe("");
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
