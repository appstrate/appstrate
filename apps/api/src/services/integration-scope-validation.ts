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
 * Only agent manifests go through this — other package types short-
 * circuit at the type check.
 */

import { parseManifestIntegrations } from "@appstrate/core/dependencies";
import { validateAgentIntegrationScopes } from "@appstrate/core/integration";
import type { ValidationFieldError } from "@appstrate/core/api-errors";

import { getIntegration, fetchMcpServerManifest } from "./integration-service.ts";
import { getLocalServerRef } from "./integration-manifest-helpers.ts";

export interface ValidateAgentIntegrationSelectionsInput {
  /** Raw agent manifest (already shape-validated by `validateManifest`). */
  manifest: Record<string, unknown>;
  /** Org owning the agent — bounds the integration visibility lookup. */
  orgId: string;
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
  const { manifest, orgId } = input;
  if (manifest.type !== "agent") return [];

  const integrations = parseManifestIntegrations(manifest);
  if (integrations.length === 0) return [];

  // Only configured entries carry tools/scopes — integrations with no
  // configuration entry have nothing to validate.
  const configuredEntries = integrations.filter(
    (e) => (e.tools && e.tools.length > 0) || (e.scopes && e.scopes.length > 0),
  );
  if (configuredEntries.length === 0) return [];

  // Sequential DB lookups keep the implementation simple and the
  // typical agent declares ≤ 3 integrations; trade a little latency
  // for stable ordering of errors in the response.
  const errors: ValidationFieldError[] = [];
  for (const entry of configuredEntries) {
    const integration = await getIntegration(orgId, entry.id);
    if (!integration) {
      // Integration not visible / not installed — defer to run-time
      // dependency validation rather than emit a misleading error
      // about scopes against a non-existent catalog.
      continue;
    }
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
            : "Scope outside integration catalog",
        message: issue.message,
      });
    }
  }
  return errors;
}
