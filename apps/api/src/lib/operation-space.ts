// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
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
  return scope;
}
