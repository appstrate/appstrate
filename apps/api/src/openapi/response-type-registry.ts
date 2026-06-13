// SPDX-License-Identifier: Apache-2.0

/**
 * Registry mapping OpenAPI response schemas to the `@appstrate/shared-types`
 * interface they are supposed to mirror, consumed by verify-openapi step #7
 * ("Shared-Type ↔ OpenAPI Response Required-Field Comparison").
 *
 * The check asserts that every field a shared-type marks **required** is also
 * marked required in the matching OpenAPI response schema (for fields the spec
 * declares as properties). It catches the "spec marks a response field optional
 * that the consuming type marks required" class of drift — the frontend trusts
 * the generated type and reads `.x` unconditionally, but the spec permits the
 * server to omit it.
 *
 * SEEDING POLICY: only pairs with **zero** current violations belong here, so
 * the gate is green on day one. Expand it schema-by-schema as response schemas
 * are tightened to match their types.
 *
 * Each entry targets either:
 *   - a named component schema (`specSchemaName`), resolved from
 *     `components.schemas[name]`, or
 *   - an inline response schema (`path` + `method` + `status`), resolved from
 *     `paths[path][method].responses[status].content["application/json"].schema`.
 */

export type ResponseTypeEntry = {
  /** Named component schema under `components.schemas`. Mutually exclusive with path/method/status. */
  specSchemaName?: string;
  /** Inline response: spec path (e.g. "/api/integrations/{packageId}/agent-resolution/{agentPackageId}"). */
  path?: string;
  /** Inline response: HTTP method (lowercase). */
  method?: string;
  /** Inline response: status code (e.g. "200"). */
  status?: string;
  /** Exported interface name in `@appstrate/shared-types`. */
  sharedTypeName: string;
  /** Human-readable label used in the verifier's per-entry output. */
  description: string;
};

export const responseTypeRegistry: ResponseTypeEntry[] = [
  {
    specSchemaName: "EndUserObject",
    sharedTypeName: "EndUserInfo",
    description: "EndUserObject ↔ EndUserInfo",
  },
  {
    path: "/api/integrations/{packageId}/agent-resolution/{agentPackageId}",
    method: "get",
    status: "200",
    sharedTypeName: "IntegrationAgentResolution",
    description: "GET .../agent-resolution/... 200 ↔ IntegrationAgentResolution",
  },
  {
    specSchemaName: "Run",
    sharedTypeName: "EnrichedRun",
    description: "Run ↔ EnrichedRun (every run response is enriched via mapEnrichedRun)",
  },
  {
    specSchemaName: "Schedule",
    sharedTypeName: "EnrichedSchedule",
    description: "Schedule ↔ EnrichedSchedule (every schedule response is actor-enriched)",
  },
  // Future expansion target: AgentDetail still keeps a few fields spec-optional
  // that the type marks required. Tighten its `required` array (or record the
  // divergence in KNOWN_DRIFT below with a justification) before seeding it.
];

/**
 * Accepted spec-optional-but-type-required fields, keyed by `specSchemaName`
 * or inline `path`. Each listed field is a deliberate, reviewed exception:
 * the shared-type marks it required but the spec intentionally leaves it
 * optional. Keep every entry justified with a comment.
 */
export const KNOWN_DRIFT: Record<string, string[]> = {
  // (empty) — no accepted drift yet. All seeded pairs match exactly.
};
