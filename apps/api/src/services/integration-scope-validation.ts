// SPDX-License-Identifier: Apache-2.0

/**
 * Phase 1 — install-time validation that an agent's
 * `integrations_configuration[id]` selections (tools / scopes, §4.4)
 * are consistent with the catalog declared on each referenced
 * integration's manifest.
 *
 * Pure-function core (`validateAgentIntegrationScopes` in
 * `@appstrate/core/integration`) handles the per-pair comparison; this
 * service-layer wrapper resolves each integration's manifest from the
 * DB (org-scoped + system, mirroring the visibility rules used by
 * `getIntegration`) and folds the per-pair errors into the route-layer
 * `ValidationFieldError` shape.
 *
 * Short-circuit cases (no validation, no error):
 *  - Agent declares the integration with no `integrations_configuration`
 *    entry → nothing to validate.
 *  - Integration not (yet) installed / not visible to the org →
 *    validation is skipped silently. The run-readiness check
 *    (`agent-readiness.ts`) is the authority on "integration must be
 *    installed", not us.
 *  - Integration declares no `tools_policy` block or no `scope_catalog`
 *    catalog → the corresponding subset check is skipped (matches the
 *    Phase 0 schema semantics).
 *
 * `requireCallableTools` adds one more rule that is NOT a subset check — the
 * declared-but-empty gate — and is opt-in per call site (a publish/import rule,
 * not a draft rule). Turning it on also switches WHICH manifest every check
 * above judges against: the PINNED version the run will resolve, instead of the
 * integration author's live draft. See {@link resolvePinnedIntegrationManifests}.
 *
 * Only agent manifests go through this — other package types short-
 * circuit at the type check.
 */

import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import { matchVersion } from "@appstrate/core/semver";
import type { ManifestIntegrationEntry } from "@appstrate/core/dependencies";
import {
  canonicalizeApiToolName,
  resolveEffectiveToolSelection,
  resolveIntegrationToolCatalog,
  validateAgentIntegrationScopes,
} from "@appstrate/core/integration";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { McpServerManifest } from "@appstrate/core/mcp-server";
import type { ValidationFieldError } from "@appstrate/core/api-errors";

import {
  getIntegration,
  fetchMcpServerManifest,
  resolveMcpServerForSpawn,
  resolveRunIntegrationVersions,
  type IntegrationManifestCache,
} from "./integration-service.ts";
import { getLocalServerRef } from "./integration-manifest-helpers.ts";

/** One version of one package carried inside an incoming bundle. */
export interface CarriedVersion {
  version: string;
  manifest: Record<string, unknown>;
}

/**
 * Pick the carried version that satisfies `range`, or `null` when the bundle
 * carries this package but no version of it matches — a MISS, which falls
 * through to the DB rather than being treated as an absence of the package.
 *
 * An exact-version range is handled by `matchVersion` too (semver treats
 * `"1.2.3"` as the range `=1.2.3`), so there is no separate exact path to keep
 * in sync.
 */
function pickCarried(
  carried: ReadonlyArray<CarriedVersion> | undefined,
  range: string,
): CarriedVersion | null {
  if (!carried || carried.length === 0) return null;
  const winner = matchVersion(
    carried.map((c) => c.version),
    range,
  );
  return winner ? (carried.find((c) => c.version === winner) ?? null) : null;
}

export interface ValidateAgentIntegrationSelectionsInput {
  /** Raw agent manifest (already shape-validated by `validateManifest`). */
  manifest: Record<string, unknown>;
  /** Org owning the agent — bounds the integration visibility lookup. */
  orgId: string;
  /**
   * Also refuse a DECLARED integration whose effective tool selection is
   * empty (AFPS §4.4) — the state `assertIntegrationExposesTools` turns into
   * a failed run.
   *
   * OFF by default, and that default is load-bearing: the agent editor's own
   * flow passes THROUGH the empty state (add the dependency, then tick a tool)
   * and autosaves in between. Turn it on only where an artifact becomes final
   * — publishing a version, and ZIP/GitHub/`.afps-bundle` import.
   */
  requireCallableTools?: boolean;
  /**
   * Manifests travelling WITH the agent — the packages of an incoming
   * `.afps-bundle`, keyed by package id, each carrying EVERY version the bundle
   * holds for that id. Consulted before the DB, for integrations AND for the
   * mcp-servers a local integration references.
   *
   * Without it a self-contained bundle bypassed the gate entirely: its
   * integration is not in the registry yet, the DB lookup misses, and
   * "not installed → skip silently" waved the agent through into an immutable
   * version. The catalog a bundle must be judged against is
   * `incoming ∪ already-installed`, not the DB alone.
   *
   * KEYED BY ID BUT VERSIONED. A bundle can legitimately carry several versions
   * of one package, and the agent's `dependencies.integrations.<id>` range picks
   * one. Flattening to a single manifest per id — which the first version of
   * this did — lets an agent pinning `^1` be judged against a carried `2.0.0`
   * and then run the `1.2.0` the DB resolves: a false verdict in both
   * directions. The pin is resolved against these versions with
   * {@link matchVersion}, and only a MISS falls through to the DB.
   */
  extraManifests?: ReadonlyMap<string, ReadonlyArray<CarriedVersion>>;
}

/**
 * True when the agent would end up with no callable tool from this integration.
 *
 * A NON-EMPTY selection is not the same thing as a callable one, which is why
 * this intersects the effective selection with the resolved catalog instead of
 * measuring its length. `default_tools: ["foo"]` where `foo` is listed in
 * `hidden_tools`, or absent from the resolved mcp-server, is a non-empty
 * selection that registers nothing — the boot gate's exact failure condition.
 *
 * `catalog` MUST be the same `resolveIntegrationToolCatalog` result the subset
 * check below uses (it already subtracts `hidden_tools` and adds the synthetic
 * `api_call`/`api_upload` entries). One computation, two checks: a catalog that
 * disagreed between them would let one of the two lie.
 */
function selectsNoCallableTool(
  entry: ManifestIntegrationEntry,
  integrationManifest: IntegrationManifest,
  catalog: ReadonlyArray<{ name: string }>,
  surfaceIsKnown: boolean,
): boolean {
  const effective = resolveEffectiveToolSelection(entry.tools, integrationManifest);
  if (isToolsWildcard(effective)) return false;
  if (effective === undefined || effective.length === 0) return true;
  // Intersect only when the catalog is KNOWABLE here. A remote integration that
  // enumerates nothing in its manifest discovers its tools at connect time, so
  // an empty catalog means "unknown", not "none" — intersecting would refuse a
  // perfectly good publish. Same reason `validateAgentIntegrationScopes` skips
  // its own subset check on an empty catalog (Phase 0 semantics).
  //
  // A DECLARED surface that `hidden_tools` empties is the opposite case and must
  // refuse: the integration told us its tools and then hid all of them, so the
  // selection provably registers nothing.
  if (!surfaceIsKnown) return false;
  const callable = new Set(catalog.map((e) => e.name));
  return !effective.some((t) => callable.has(canonicalizeApiToolName(integrationManifest, t)));
}

/**
 * Resolve, for every integration the agent declares, the manifest AT the
 * version its `dependencies.integrations.<id>` pin will resolve to on a run.
 *
 * WHY NOT THE DRAFT. `getIntegration` reads `packages.draft_manifest`, but a
 * run never does: `resolveRunIntegrationVersions` freezes each pin and the
 * spawn resolver reads THAT version's manifest. Judging from the integration
 * author's live draft would refuse publishes the runtime would run perfectly —
 * an agent pinned to `^1.0.0` stays callable after that author drops
 * `default_tools` from their current draft. This calls THE run's own resolver,
 * so the two cannot drift.
 *
 * An id absent from the returned map is NOT judged — an unsatisfiable pin
 * already fails loud upstream with `dependency_unresolved` (422).
 *
 * Every check in the loop judges against this manifest when it resolves, not
 * only the emptiness gate. A publish this newly refuses — selection valid in
 * the draft, absent from the pinned version — is a publish whose run would
 * have registered nothing at boot; refusing it while the artifact is still
 * editable is the whole point. Draft writes keep reading the draft: nothing is
 * frozen there, and resolving pins on every autosave is not worth its cost.
 */
async function resolvePinnedIntegrationManifests(
  manifest: Record<string, unknown>,
  orgId: string,
): Promise<Map<string, IntegrationManifest>> {
  const cache: IntegrationManifestCache = new Map();
  // Return value ignored: every id that DID resolve is seeded into the cache
  // either way.
  await resolveRunIntegrationVersions({ agentManifest: manifest, orgId, manifestCache: cache });
  const resolved = new Map<string, IntegrationManifest>();
  for (const [id, pending] of cache) {
    const res = await pending;
    if (res.ok) resolved.set(id, res.manifest);
  }
  return resolved;
}

/**
 * Walk the agent's configured integrations (those with an
 * `integrations_configuration` entry), look each one up in the DB, and run
 * the pure subset validator. Returns the accumulated field errors (empty
 * array on success). Caller decides whether to `throw validationFailed(errors)`
 * or surface them differently.
 *
 * Non-agent manifests, integrations with no configuration entry, and absent
 * integrations all short-circuit to a successful result — see the module
 * preamble for the rationale.
 */
export async function validateAgentIntegrationSelections(
  input: ValidateAgentIntegrationSelectionsInput,
): Promise<ValidationFieldError[]> {
  const { manifest, orgId, requireCallableTools = false, extraManifests } = input;
  if (manifest.type !== "agent") return [];

  const integrations = parseManifestIntegrations(manifest);
  if (integrations.length === 0) return [];

  // Only configured entries carry tools/scopes — integrations with no
  // configuration entry have nothing to validate. The AFPS §4.4 wildcard
  // literal `"*"` counts as a configured selection (the agent opted into
  // every upstream tool) and must reach `validateAgentIntegrationScopes`
  // so the `wildcard_not_authorized` rule fires when the integration
  // didn't opt in via `allow_undeclared_tools: true`.
  const configuredEntries = integrations.filter(
    (e) =>
      isToolsWildcard(e.tools) ||
      (Array.isArray(e.tools) && e.tools.length > 0) ||
      (e.scopes && e.scopes.length > 0),
  );

  // The declared-but-empty gate is precisely about the entries the subset
  // filter above DROPS, so it needs the full declared list.
  const inspected = requireCallableTools ? integrations : configuredEntries;
  if (inspected.length === 0) return [];
  const configuredIds = new Set(configuredEntries.map((e) => e.id));

  const pinnedManifests = requireCallableTools
    ? await resolvePinnedIntegrationManifests(manifest, orgId)
    : undefined;

  // Sequential DB lookups keep the implementation simple and the
  // typical agent declares ≤ 3 integrations; trade a little latency
  // for stable ordering of errors in the response.
  const errors: ValidationFieldError[] = [];
  for (const entry of inspected) {
    // Resolve the agent's OWN pin against the versions the bundle carries.
    const carriedEntry = pickCarried(extraManifests?.get(entry.id), entry.version);
    const carried = carriedEntry?.manifest;
    const integration = carried
      ? { manifest: carried as unknown as IntegrationManifest }
      : await getIntegration(orgId, entry.id);
    if (!integration) {
      // Integration not visible / not installed — defer to run-time
      // dependency validation rather than emit a misleading error
      // about scopes against a non-existent catalog.
      continue;
    }
    // THE manifest every check below judges against. At a freeze point that is
    // the PINNED version — what the run will actually resolve and spawn (see
    // `resolvePinnedIntegrationManifests`). The draft is the fallback, used
    // when no pin resolves and on the ungated draft-write path.
    //
    // Judging the subset checks on the draft while judging emptiness on the
    // pinned version was incoherent in both directions: an agent selecting a
    // tool that exists in the author's draft but NOT in the pinned version
    // published cleanly and then registered nothing at boot — the exact abort
    // this validator exists to prevent — and the mirror case refused a publish
    // that would have run fine.
    const pinnedManifest = carried
      ? (carried as unknown as IntegrationManifest)
      : pinnedManifests?.get(entry.id);
    const judgedManifest = pinnedManifest ?? integration.manifest;

    // For local-source integrations the catalog comes from the referenced
    // mcp-server's MCPB tools. Fetched BEFORE both checks: the emptiness gate
    // needs it too, because "non-empty selection" and "callable selection" are
    // different properties and only the second one is the boot contract.
    let mcpServerTools: ReadonlyArray<{ name: string; description?: string }> | undefined;
    const localRef = getLocalServerRef(judgedManifest);
    if (localRef) {
      // Same rule as the integration manifest above, one level deeper: at a
      // freeze point read the mcp-server AT the version `source.server.version`
      // resolves to — `resolveMcpServerForSpawn`, the resolver the spawn path
      // itself calls (`integration-spawn-resolver.ts`). `fetchMcpServerManifest`
      // reads `packages.draft_manifest`, which the runtime never does, so a tool
      // present only in the mcp-server author's draft used to pass publish and
      // then register nothing at boot.
      // Same rule one level deeper: `source.server.version` is the range here.
      const carriedServer = pickCarried(
        extraManifests?.get(localRef.name),
        localRef.version,
      )?.manifest;
      const mcpServer = carriedServer
        ? (carriedServer as unknown as McpServerManifest)
        : requireCallableTools
          ? await resolveMcpServerForSpawn(localRef.name, orgId, localRef.version).then((r) =>
              r.ok ? r.manifest : null,
            )
          : await fetchMcpServerManifest(localRef.name);
      if (mcpServer) {
        const t = (mcpServer as { tools?: Array<{ name?: unknown; description?: unknown }> }).tools;
        if (Array.isArray(t)) {
          mcpServerTools = t
            .filter((e): e is { name: string; description?: string } => typeof e?.name === "string")
            .map((e) => ({
              name: e.name,
              description: typeof e.description === "string" ? e.description : undefined,
            }));
        }
      }
    }
    // ONE catalog, both checks. `resolveIntegrationToolCatalog` already
    // subtracts `hidden_tools` and appends the synthetic api_call/api_upload
    // entries, so this is the set the sidecar will actually register.
    const catalog = resolveIntegrationToolCatalog({
      integration: judgedManifest,
      ...(mcpServerTools ? { mcpServerTools } : {}),
    });

    // The integration told us its tool surface when it declares `tools_policy`,
    // or when the referenced mcp-server resolved and enumerated tools. Absent
    // both, the surface is discovered at runtime and must not be second-guessed.
    const surfaceIsKnown =
      (mcpServerTools?.length ?? 0) > 0 ||
      Object.keys((judgedManifest as { tools_policy?: Record<string, unknown> }).tools_policy ?? {})
        .length > 0;

    if (pinnedManifest && selectsNoCallableTool(entry, pinnedManifest, catalog, surfaceIsKnown)) {
      errors.push({
        field: `integrations_configuration.${entry.id}.tools`,
        code: "no_tools_selected",
        title: "Integration exposes no callable tool",
        message: `Integration ${entry.id} is declared but nothing it selects is callable, so the run would abort at boot. Select at least one tool this integration actually exposes in integrations_configuration.${entry.id}.tools, or remove ${entry.id} from dependencies.integrations.`,
      });
      // Deliberately NO `continue`: `{ tools: [], scopes: ["bogus"] }` still
      // has a checkable scope, and both errors must land in one pass.
    }
    if (!configuredIds.has(entry.id)) continue;

    const issues = validateAgentIntegrationScopes(
      { id: entry.id, tools: entry.tools, scopes: entry.scopes },
      judgedManifest,
      mcpServerTools,
    );
    for (const issue of issues) {
      errors.push({
        field: issue.field,
        code: issue.code,
        title:
          issue.code === "unknown_tool"
            ? "Unknown integration tool"
            : issue.code === "wildcard_not_authorized"
              ? "Wildcard tools not permitted by integration"
              : "Scope outside integration catalog",
        message: issue.message,
      });
    }
  }
  return errors;
}
