// SPDX-License-Identifier: Apache-2.0

/**
 * The universal DB-convention carve-out of `docs/CASING_CONVENTIONS.md` (4b)
 * keeps `spaceId`, `createdAt`, … camelCase on the wire. This walks the whole
 * spec (core + every module) and fails on a property or query parameter spelled
 * as the snake_case twin of one of those names, unless it is listed below.
 *
 * The list only shrinks: an entry that no longer matches anything fails too.
 */

import { describe, expect, it } from "bun:test";
import { buildOpenApiSpec } from "../../src/openapi/index.ts";
import { collectModuleOpenApi } from "../../../../scripts/lib/module-openapi.ts";

const CARVE_OUT_SNAKE_TWINS = new Set([
  "created_at",
  "updated_at",
  "expires_at",
  "revoked_at",
  "last_used_at",
  "run_number",
  "user_id",
  "org_id",
  "space_id",
  "package_id",
  "end_user_id",
  "api_key_id",
  "schedule_id",
  "run_origin",
  "context_snapshot",
  "model_credential_id",
]);

const ALLOWED = new Set([
  // The enumerated counter-exception of the placement / share family.
  "components.PackagePlacement: space_id",
  "components.PackagePlacement: shared_by.user_id",
  "components.PackageShare: shared_by.user_id",
  // Internal sidecar↔platform wire, documented snake_case end to end.
  "components.IntegrationCredentialsResponse: auths[].expires_at",
  // OAuth 2.0 token endpoint (Zone 1, RFC 6749 wire).
  "POST /api/auth/oauth2/token 200: expires_at",
  // Open: epoch-ms connect-offer expiry and its package id — issue #1529, finding 13.
  "components.ResolutionFieldError: expires_at",
  "components.ResolutionFieldError: package_id",
  "POST /api/integrations/{packageId}/auths/{authKey}/connect/session 200: expires_at",
  // Open: not yet reconciled with the carve-out.
  "GET /api/me/context 200: recent_runs[].package_id",
  "GET /api/me/context 200: recent_runs[].run_number",
  "GET /api/me/context 200: agents[].package_id",
  "GET /api/me/context 200: skills[].package_id",
  "GET /api/notifications 200: data[].created_at",
  "POST /api/agents/{scope}/{name}/schedules request: actor.user_id",
  "POST /api/agents/{scope}/{name}/schedules request: actor.end_user_id",
  "PUT /api/schedules/{id} request: actor.user_id",
  "PUT /api/schedules/{id} request: actor.end_user_id",
  "components.EeBillingManager: user_id",
  "components.EeBillingManager: created_at",
]);

type Schema = Record<string, unknown>;

function collect(schema: unknown, where: string, prefix: string, out: string[]): void {
  if (!schema || typeof schema !== "object") return;
  const node = schema as Schema;
  const props = node.properties as Record<string, unknown> | undefined;
  for (const [key, child] of Object.entries(props ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (CARVE_OUT_SNAKE_TWINS.has(key)) out.push(`${where}: ${path}`);
    collect(child, where, path, out);
  }
  collect(node.items, where, `${prefix}[]`, out);
  if (node.additionalProperties && typeof node.additionalProperties === "object") {
    collect(node.additionalProperties, where, `${prefix}{}`, out);
  }
  for (const combinator of ["oneOf", "anyOf", "allOf"] as const) {
    for (const branch of (node[combinator] as unknown[] | undefined) ?? []) {
      collect(branch, where, prefix, out);
    }
  }
}

function contentSchemas(carrier: unknown): unknown[] {
  const content = (carrier as { content?: Record<string, { schema?: unknown }> } | undefined)
    ?.content;
  return Object.values(content ?? {}).map((media) => media.schema);
}

async function offendingNames(): Promise<string[]> {
  const modules = await collectModuleOpenApi();
  const spec = buildOpenApiSpec(modules.paths, modules.componentSchemas, modules.tags) as {
    paths: Record<string, Record<string, Schema>>;
    components: { schemas: Record<string, unknown> };
  };
  const out: string[] = [];
  for (const [name, schema] of Object.entries(spec.components.schemas)) {
    collect(schema, `components.${name}`, "", out);
  }
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const [method, op] of Object.entries(item)) {
      if (!op || typeof op !== "object" || method === "parameters") continue;
      const label = `${method.toUpperCase()} ${path}`;
      for (const param of (op.parameters as { name?: string; in?: string }[] | undefined) ?? []) {
        if (param.in === "query" && param.name && CARVE_OUT_SNAKE_TWINS.has(param.name)) {
          out.push(`${label} query: ${param.name}`);
        }
      }
      for (const schema of contentSchemas(op.requestBody)) {
        collect(schema, `${label} request`, "", out);
      }
      for (const [status, response] of Object.entries((op.responses as Schema) ?? {})) {
        for (const schema of contentSchemas(response))
          collect(schema, `${label} ${status}`, "", out);
      }
    }
  }
  return [...new Set(out)].sort();
}

describe("OpenAPI casing — universal DB-convention carve-out", () => {
  it("spells no carve-out name in snake_case outside the listed exceptions", async () => {
    const found = await offendingNames();
    expect(found.filter((entry) => !ALLOWED.has(entry))).toEqual([]);
    // A fixed entry must leave the list, or it would excuse the next regression.
    expect([...ALLOWED].filter((entry) => !found.includes(entry))).toEqual([]);
  });
});
