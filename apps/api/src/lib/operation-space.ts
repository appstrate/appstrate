// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { asRecord, asRecordOrNull } from "@appstrate/core/safe-json";
import { resolveRef } from "../openapi/pointer.ts";
import { skipAuth } from "./auth-paths.ts";
import { INTEGRATION_CALLBACK_TEMPLATES } from "./integration-callback-url.ts";
import { isSpaceScopedPath } from "../middleware/space-context.ts";

const scopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("organization") }),
  z.strictObject({
    kind: z.literal("request"),
    parameter: z.string().min(1).optional(),
    default: z.enum(["personal", "personal_for_inline_source"]).optional(),
  }),
  z.strictObject({ kind: z.literal("aggregate"), permission: z.string().min(1).optional() }),
  z.strictObject({
    kind: z.literal("target"),
    parameter: z.string().min(1),
    source: z.enum(["query", "body"]).optional(),
    optional: z.literal(true).optional(),
  }),
  z.discriminatedUnion("source", [
    z.strictObject({ kind: z.literal("resource"), source: z.literal("row") }),
    z
      .strictObject({
        kind: z.literal("resource"),
        source: z.literal("query"),
        parameter: z.string().min(1),
        all_parameter: z.string().min(1),
        space_permission: z.string().min(1).optional(),
        organization_permission: z.string().min(1),
      })
      .transform(
        ({
          all_parameter: allParameter,
          space_permission: spacePermission,
          organization_permission: organizationPermission,
          ...rule
        }) => ({
          ...rule,
          allParameter,
          organizationPermission,
          ...(spacePermission && { spacePermission }),
        }),
      ),
    z
      .strictObject({
        kind: z.literal("resource"),
        source: z.literal("body"),
        parameter: z.string().min(1),
        level_parameter: z.string().min(1),
        space_level: z.string().min(1),
        space_permission: z.string().min(1).optional(),
      })
      .transform(
        ({
          level_parameter: levelParameter,
          space_level: spaceLevel,
          space_permission: spacePermission,
          ...rule
        }) => ({
          ...rule,
          levelParameter,
          spaceLevel,
          ...(spacePermission && { spacePermission }),
        }),
      ),
  ]),
]);

/** How a REST operation selects its space. A target's parameter is in the path unless designated otherwise. */
export type OperationSpaceScope = z.infer<typeof scopeSchema>;

/** Scope enforced by mounted middleware or by the terminal handler's row check. */
export type MountedSpaceScope =
  { kind: "request" } | { kind: "target"; parameter: string } | { kind: "resource"; source: "row" };

interface DocumentedRequest {
  spec: unknown;
  pathItem: object;
  operation: object;
}

/** Parameter and Request Body Reference Objects may point to other Reference Objects. */
function resolveObject(spec: unknown, item: unknown): Record<string, unknown> | undefined {
  const seen = new Set<string>();
  let node = asRecordOrNull(item);
  while (node && typeof node.$ref === "string") {
    if (seen.has(node.$ref)) return undefined;
    seen.add(node.$ref);
    node = resolveRef(spec, node.$ref) ?? null;
  }
  return node ?? undefined;
}

/**
 * The top-level fields a compatible schema branch declares. Conjunctions must all match,
 * while alternatives contribute only their matching branches. Stop at object properties:
 * a field inside a nested object or an array item cannot address the operation's space.
 */
function schemaFields(
  spec: unknown,
  schema: unknown,
  ownFields: (node: Record<string, unknown>) => Set<string> | undefined,
  ancestors: ReadonlySet<object> = new Set(),
): Set<string> | undefined {
  if (schema === true) return new Set();
  const node = asRecordOrNull(schema);
  if (!node) return undefined;
  if (ancestors.has(node)) return new Set();
  const fields = ownFields(node);
  if (!fields) return undefined;
  const branchAncestors = new Set(ancestors).add(node);
  const visit = (branch: unknown) => schemaFields(spec, branch, ownFields, branchAncestors);
  const required = Array.isArray(node.allOf) ? [...node.allOf] : [];
  if (typeof node.$ref === "string") required.push(resolveRef(spec, node.$ref));
  for (const branch of required) {
    const included = visit(branch);
    if (!included) return undefined;
    for (const name of included) fields.add(name);
  }
  for (const alternatives of [node.oneOf, node.anyOf]) {
    if (!Array.isArray(alternatives)) continue;
    const matches = alternatives.map(visit).filter((names) => names !== undefined);
    if (!matches.length) return undefined;
    for (const match of matches) for (const name of match) fields.add(name);
  }
  return fields;
}

function validateSpaceFields(
  operationId: string,
  path: string,
  scope: OperationSpaceScope,
  { spec, pathItem, operation }: DocumentedRequest,
): void {
  if (!("parameter" in scope) || !scope.parameter) return;
  const source = scope.kind === "request" ? "body" : (scope.source ?? "path");
  const fail = (field: string): never => {
    throw new Error(
      `${operationId}: space field ${field} is absent from the documented ${source} of ${path}`,
    );
  };
  if (source !== "body") {
    const names = new Set<string>();
    for (const params of [asRecord(pathItem).parameters, asRecord(operation).parameters]) {
      if (!Array.isArray(params)) continue;
      for (const param of params) {
        const item = resolveObject(spec, param);
        if (item?.in === source && typeof item.name === "string") names.add(item.name);
      }
    }
    if (!names.has(scope.parameter)) fail(scope.parameter);
    if ("allParameter" in scope && !names.has(scope.allParameter)) fail(scope.allParameter);
    return;
  }
  const body = resolveObject(spec, asRecord(operation).requestBody);
  const json = asRecord(asRecord(body?.content)["application/json"]);
  const fields = schemaFields(spec, json.schema, (node) => {
    const properties = asRecord(node.properties);
    if ("levelParameter" in scope && Object.hasOwn(properties, scope.levelParameter)) {
      const allowed = schemaFields(spec, properties[scope.levelParameter], (part) =>
        (Object.hasOwn(part, "const") && part.const !== scope.spaceLevel) ||
        (Array.isArray(part.enum) && !part.enum.includes(scope.spaceLevel))
          ? undefined
          : new Set(),
      );
      if (!allowed) return undefined;
    }
    return new Set(Object.keys(properties));
  });
  if ("levelParameter" in scope && !fields?.has(scope.levelParameter)) {
    fail(`${scope.levelParameter}=${scope.spaceLevel}`);
  }
  if (!fields?.has(scope.parameter)) fail(scope.parameter);
}

/**
 * Every served operation must have a space contract, either enforced by its mounted middleware or
 * declared by its owner in OpenAPI. This is evaluated at registration, including for module routes.
 */
export function operationSpaceScope(
  operationId: string,
  path: string,
  mounted: MountedSpaceScope | undefined,
  declaration: unknown,
  publicPaths: ReadonlySet<string>,
  request: DocumentedRequest,
): OperationSpaceScope {
  // The platform middleware skips authenticated-run callbacks and public module doors even under
  // a space family. The redirect's tag is a constrained path parameter on its concrete route.
  const family =
    isSpaceScopedPath(path) &&
    !Object.values(INTEGRATION_CALLBACK_TEMPLATES).includes(path) &&
    !skipAuth(path, publicPaths, new Headers());
  if (family && mounted && mounted.kind !== "request") {
    throw new Error(`${operationId}: conflicting request-space family and mounted space scope`);
  }
  const enforced = mounted ?? (family ? { kind: "request" as const } : undefined);
  const parsed = scopeSchema.safeParse(declaration === undefined ? enforced : declaration);
  if (!parsed.success) {
    throw new Error(`${operationId}: missing or invalid x-appstrate-space contract for ${path}`);
  }
  const scope = parsed.data;
  if (scope.kind === "resource" && scope.source === "row" && enforced?.kind !== "resource") {
    throw new Error(`${operationId}: resource:row requires a withAuthorizedRow handler`);
  }
  if (
    enforced &&
    (enforced.kind !== scope.kind ||
      (enforced.kind === "resource" && scope.kind === "resource" && scope.source !== "row") ||
      (enforced.kind === "target" &&
        (scope.kind !== "target" ||
          scope.source ||
          scope.optional ||
          scope.parameter !== enforced.parameter)))
  ) {
    throw new Error(`${operationId}: x-appstrate-space contradicts its mounted space middleware`);
  }
  if (
    scope.kind === "target" &&
    !scope.source &&
    !path.split("/").includes(`{${scope.parameter}}`)
  ) {
    throw new Error(
      `${operationId}: target space parameter ${scope.parameter} is absent from ${path}`,
    );
  }
  validateSpaceFields(operationId, path, scope, request);
  return scope;
}
