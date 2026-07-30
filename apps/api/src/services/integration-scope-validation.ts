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
import type { ManifestIntegrationEntry } from "@appstrate/core/dependencies";
import {
  resolveEffectiveToolSelection,
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
   * Manifests travelling WITH the agent, keyed by package id — the packages of
   * an incoming `.afps-bundle`. Consulted before the DB, for integrations AND
   * for the mcp-servers a local integration references.
   *
   * Without it a self-contained bundle bypassed the gate entirely: its
   * integration is not in the registry yet, the DB lookup misses, and
   * "not installed → skip silently" waved the agent through into an immutable
   * version. The catalog a bundle must be judged against is
   * `incoming ∪ already-installed`, not the DB alone.
   *
   * A bundle-carried manifest is used verbatim: it IS the artifact being
   * frozen, so there is no published version to resolve it to.
   */
  extraManifests?: ReadonlyMap<string, Record<string, unknown>>;
}

/**
 * True when the agent would end up with no callable tool from this
 * integration. Reads through {@link resolveEffectiveToolSelection}, the SAME
 * resolver that builds `toolAllowlist`, so "empty" means here exactly what it
 * will mean at boot.
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
    const carried = extraManifests?.get(entry.id);
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
    if (pinnedManifest && selectsNoCallableTool(entry, pinnedManifest)) {
      errors.push({
        field: `integrations_configuration.${entry.id}.tools`,
        code: "no_tools_selected",
        title: "Integration exposes no tool",
        message: `Integration ${entry.id} is declared but selects no tool, so it would expose nothing callable and the run would abort at boot. Select at least one tool in integrations_configuration.${entry.id}.tools, or remove ${entry.id} from dependencies.integrations.`,
      });
      // Deliberately NO `continue`: `{ tools: [], scopes: ["bogus"] }` still
      // has a checkable scope, and both errors must land in one pass.
    }
    if (!configuredIds.has(entry.id)) continue;
    // For local-source integrations the catalog comes from the referenced
    // mcp-server's MCPB tools. Fetch it best-effort — the validator falls
    // back to `integration.tools_policy` keys when undefined (mirrors the picker).
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
      const carriedServer = extraManifests?.get(localRef.name);
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
