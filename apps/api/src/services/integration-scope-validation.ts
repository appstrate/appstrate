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
 * The one check that is NOT a subset check — `requireCallableTools`, the
 * declared-but-empty gate — is opt-in per call site, because it is a
 * publish/import rule and NOT a draft rule. See
 * {@link ValidateAgentIntegrationSelectionsInput.requireCallableTools}.
 * It also reads a DIFFERENT manifest from the subset checks — the PINNED
 * one, not the draft. See {@link resolvePinnedIntegrationManifests}.
 *
 * Only agent manifests go through this — other package types short-
 * circuit at the type check.
 */

import { isToolsWildcard, parseManifestIntegrations } from "@appstrate/core/dependencies";
import type { ManifestIntegrationEntry } from "@appstrate/core/dependencies";
import {
  resolveEffectiveToolSelection,
  validateAgentIntegrationScopes,
} from "@appstrate/core/integration";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { ValidationFieldError } from "@appstrate/core/api-errors";

import {
  getIntegration,
  fetchMcpServerManifest,
  resolveRunIntegrationVersions,
  type IntegrationManifestCache,
} from "./integration-service.ts";
import { getLocalServerRef } from "./integration-manifest-helpers.ts";

export interface ValidateAgentIntegrationSelectionsInput {
  /** Raw agent manifest (already shape-validated by `validateManifest`). */
  manifest: Record<string, unknown>;
  /** Org owning the agent — bounds the integration visibility lookup. */
  orgId: string;
  /**
   * Also refuse a DECLARED integration whose effective tool selection is
   * empty (AFPS §4.4: `tools` absent AND no inherited `default_tools`, or an
   * explicit `[]`). Such an integration boots with nothing callable, which
   * `assertIntegrationExposesTools` (`runtime-pi/sidecar/integrations-boot.ts`)
   * turns into a failed run — so the artifact is already broken the moment it
   * is frozen.
   *
   * OFF by default, and that default is load-bearing: the agent editor's own
   * flow passes THROUGH the empty state (add the dependency, then tick a
   * tool), and it autosaves the draft in between. Gating draft writes would
   * make the editor unusable. Turn it on only where an artifact becomes
   * final — publishing a version, and ZIP/GitHub import + `.afps-bundle`
   * import (both of which cut a version via `postInstallPackage`).
   *
   * Costs one extra version-resolution pass per call
   * ({@link resolvePinnedIntegrationManifests}) — this check reads the PINNED
   * integration manifest, not the draft the subset checks read.
   */
  requireCallableTools?: boolean;
}

/**
 * True when the agent would end up with no callable tool from this
 * integration — the state the runtime boot gate refuses.
 *
 * Reads through {@link resolveEffectiveToolSelection}, the SAME resolver the
 * spawn resolver uses to build `toolAllowlist`, so "empty" means here exactly
 * what it will mean at boot: an absent selection inherits the integration's
 * declared `default_tools`, and only a genuinely empty result (or an explicit
 * `[]`, which overrides the default) counts. The wildcard `"*"` is never
 * empty — it is the opposite selection.
 */
function selectsNoCallableTool(
  entry: ManifestIntegrationEntry,
  integrationManifest: IntegrationManifest,
): boolean {
  const effective = resolveEffectiveToolSelection(entry.tools, integrationManifest);
  if (isToolsWildcard(effective)) return false;
  return effective === undefined || effective.length === 0;
}

/**
 * Resolve, for every integration the agent declares, the manifest AT the
 * version its `dependencies.integrations.<id>` pin will resolve to on a run.
 *
 * WHY NOT THE DRAFT. `getIntegration` reads `packages.draft_manifest`, but a run
 * never does: `resolveRunIntegrationVersions` freezes each pin onto
 * `runs.resolved_integration_versions` and the spawn resolver reads THAT
 * version's manifest. Judging "selects no callable tool" from the integration
 * author's live draft therefore refuses publishes the runtime would run
 * perfectly — an agent pinned to `@x/int: "^1.0.0"` whose v1 declares
 * `default_tools: ["api_call"]` stays callable after that author drops
 * `default_tools` from their current draft. The declared-but-empty gate is a
 * hard 400, so it must read exactly what boot will read; a false rejection
 * blocks a legitimate publish, which is strictly worse than missing a case the
 * boot gate (`assertIntegrationExposesTools`) still catches.
 *
 * This calls THE run's own resolver, so the two cannot drift.
 *
 * The returned map holds only the ids whose pin resolved to a concrete
 * published/system manifest. An id is absent when:
 *   - the pin is unsatisfiable / the package was never published — the run
 *     fails loud upstream with `dependency_unresolved` (422) and never boots,
 *     so this gate has no business raising a `no_tools_selected` on it; or
 *   - the package is missing / the wrong type / has an unparseable manifest —
 *     in which case `getIntegration` returns null at the call site too and the
 *     whole entry is skipped anyway.
 * Absent ⇒ NOT judged. That asymmetry is the no-false-rejection guarantee.
 *
 * The SUBSET checks deliberately keep reading the draft (unchanged behaviour):
 * they pre-date this gate and switching them here would turn a previously
 * accepted publish into a 400 whenever a published version's catalog is
 * narrower than the draft's. That drift is real but out of scope for this fix.
 */
async function resolvePinnedIntegrationManifests(
  manifest: Record<string, unknown>,
  orgId: string,
): Promise<Map<string, IntegrationManifest>> {
  const cache: IntegrationManifestCache = new Map();
  // The `ok` flag reports unsatisfiable pins; irrelevant here — every id that
  // DID resolve is seeded into the cache either way, and an unsatisfiable pin
  // is not this gate's error to raise (see above).
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
  const { manifest, orgId, requireCallableTools = false } = input;
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
  // filter above DROPS, so it needs the full declared list. Without it the
  // lookup set stays what it always was — one DB read per configured entry,
  // none for an unconfigured one.
  const inspected = requireCallableTools ? integrations : configuredEntries;
  if (inspected.length === 0) return [];
  const configuredIds = new Set(configuredEntries.map((e) => e.id));

  // One extra resolution pass, and ONLY on the publish/import call sites —
  // draft writes (the autosave hot path) pay nothing for it.
  const pinnedManifests = requireCallableTools
    ? await resolvePinnedIntegrationManifests(manifest, orgId)
    : undefined;

  // Sequential DB lookups keep the implementation simple and the
  // typical agent declares ≤ 3 integrations; trade a little latency
  // for stable ordering of errors in the response.
  const errors: ValidationFieldError[] = [];
  for (const entry of inspected) {
    const integration = await getIntegration(orgId, entry.id);
    if (!integration) {
      // Integration not visible / not installed — defer to run-time
      // dependency validation rather than emit a misleading error
      // about scopes against a non-existent catalog.
      continue;
    }
    // Judged against the PINNED manifest, not `integration.manifest` (the
    // draft) — see `resolvePinnedIntegrationManifests`. An unresolved pin
    // leaves the entry unjudged rather than rejected.
    const pinnedManifest = pinnedManifests?.get(entry.id);
    if (pinnedManifest && selectsNoCallableTool(entry, pinnedManifest)) {
      errors.push({
        field: `integrations_configuration.${entry.id}.tools`,
        code: "no_tools_selected",
        title: "Integration exposes no tool",
        message: `Integration ${entry.id} is declared but selects no tool, so it would expose nothing callable and the run would abort at boot. Select at least one tool in integrations_configuration.${entry.id}.tools, or remove ${entry.id} from dependencies.integrations.`,
      });
      // Deliberately NO `continue`: an empty tool selection does not imply an
      // empty ENTRY. `{ tools: [], scopes: ["bogus"] }` reaches
      // `configuredEntries` on `scopes.length > 0` alone, and its scope is
      // still checkable against the catalog. Short-circuiting here reported
      // one error per publish attempt — the author fixed `tools`, republished,
      // and only then learned about `scopes`. Report both in one pass.
    }
    if (!configuredIds.has(entry.id)) continue;
    // For local-source integrations the catalog comes from the referenced
    // mcp-server's MCPB tools. Fetch it best-effort — the validator falls
    // back to `integration.tools_policy` keys when undefined (mirrors the picker).
    let mcpServerTools: ReadonlyArray<{ name: string; description?: string }> | undefined;
    const localRef = getLocalServerRef(integration.manifest);
    if (localRef) {
      const mcpServer = await fetchMcpServerManifest(localRef.name);
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
    const issues = validateAgentIntegrationScopes(
      { id: entry.id, tools: entry.tools, scopes: entry.scopes },
      integration.manifest,
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
