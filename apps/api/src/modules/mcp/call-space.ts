// SPDX-License-Identifier: Apache-2.0

import { defaultMcpSpaceId } from "@appstrate/core/mcp-spaces";
import { parseSkillUri } from "@appstrate/core/skill-address";
import { asRecord } from "@appstrate/core/safe-json";
import { getCatalog, type CatalogOperation } from "./catalog.ts";
import type { McpToolName, McpSurface } from "./tools.ts";
import type { OrgWideSpaces } from "./spaces.ts";

/** Each root tool declares both its admission grant and the source of its destination. */
export const TOOL_SPACE_RULES = {
  search: { kind: "search", grant: null },
  describe: { kind: "describe", grant: null },
  invoke_operation: { kind: "operation", grant: "invokes" },
  run_and_wait: { kind: "run", grant: "runs" },
  list_files: { kind: "request", grant: "listsFiles" },
  read: { kind: "read", grant: null },
  // The preflight judges conflicts in the space an import would land in: import's own.
  validate_package_file: { kind: "personal", grant: "validatesPackages" },
  import_package_file: { kind: "personal", grant: "importsPackages" },
  call_integration_tool: { kind: "personal", grant: "proxies" },
  get_me: { kind: "optional", grant: null },
  get_runtime_capabilities: { kind: "none", grant: null },
} as const satisfies Record<
  McpToolName,
  {
    kind:
      | "none"
      | "search"
      | "describe"
      | "operation"
      | "run"
      | "request"
      | "optional"
      | "read"
      | "personal";
    grant: keyof McpSurface | null;
  }
>;

/** Admission, the tool's guard, and its receipt use the same decision. An omitted id on a
 * space call means the caller must choose. A target can differ from the space a call enters. */
export type CallSpace =
  { kind: "none" } | { kind: "space"; id: unknown; target?: string } | { kind: "row"; id: unknown };

type SpacePolicy = Pick<
  OrgWideSpaces,
  "reachable" | "bounded" | "originSpaceId" | "orgPermissions"
>;

/** The resource a body or query addresses, before applying the caller's space policy. */
export function resourceAddress(
  rule: Extract<CatalogOperation["spaceScope"], { kind: "resource"; source: "body" | "query" }>,
  args: Record<string, unknown>,
): { kind: "organization" | "default" | "invalid" } | { kind: "target"; spaceId: unknown } {
  if (rule.source === "body") {
    const body = asRecord(args.body);
    return body[rule.levelParameter] === rule.spaceLevel
      ? { kind: "target", spaceId: body[rule.parameter] }
      : { kind: "organization" };
  }
  const query = asRecord(args.query);
  if (Array.isArray(query[rule.parameter]) || Array.isArray(query[rule.allParameter]))
    return { kind: "invalid" };
  if (query[rule.allParameter] === true || query[rule.allParameter] === "true")
    return { kind: "organization" };
  return query[rule.parameter] === undefined
    ? { kind: "default" }
    : { kind: "target", spaceId: query[rule.parameter] };
}

export function effectiveOperationScope(
  op: CatalogOperation,
  orgPermissions?: ReadonlySet<string>,
) {
  const rule = op.spaceScope;
  return rule.kind === "aggregate" && rule.permission && !orgPermissions?.has(rule.permission)
    ? ({ kind: "organization" } as const)
    : rule;
}

/** An inline remote run composes an agent from the request, as on the inline-run route. */
export function isInlineRunSource(rule: CatalogOperation["spaceScope"] | undefined, body: unknown) {
  return (
    rule?.kind === "request" &&
    rule.default === "personal_for_inline_source" &&
    asRecord(asRecord(body).source).kind === "inline"
  );
}

export function resolveCallSpace(
  name: unknown,
  args: Record<string, unknown>,
  policy: SpacePolicy,
): CallSpace {
  const explicit = args.space_id;
  const destination = (personal = false) =>
    explicit !== undefined
      ? explicit
      : defaultMcpSpaceId(policy.reachable, policy.originSpaceId, personal);
  const direct = (personal = false): CallSpace => ({ kind: "space", id: destination(personal) });
  const target = (id: unknown, optional = false): CallSpace => {
    if (id === undefined) return optional ? { kind: "none" } : direct();
    return {
      kind: "space",
      id: explicit === undefined ? id : explicit,
      ...(typeof id === "string" ? { target: id } : {}),
    };
  };
  if (typeof name !== "string" || !Object.hasOwn(TOOL_SPACE_RULES, name)) return { kind: "none" };
  switch (TOOL_SPACE_RULES[name as McpToolName].kind) {
    case "none":
      return { kind: "none" };
    case "search":
      return explicit === undefined ? { kind: "none" } : direct();
    case "request":
      return direct();
    case "optional": {
      // A designated space when there is one; with none, the call acts in no space.
      const id = destination();
      return id === undefined ? { kind: "none" } : { kind: "space", id };
    }
    case "personal":
      return direct(true);
    case "run":
      return direct(args.kind === "inline");
    case "read": {
      const skill = typeof args.uri === "string" ? parseSkillUri(args.uri) : null;
      if (skill) return target(skill.spaceId);
      // A file URI identifies its resource; the ACL decides its space (or an opaque miss).
      // A named caller space still confines a bounded credential's read.
      return explicit === undefined ? { kind: "row", id: undefined } : direct();
    }
    case "describe": {
      // `id` or `ids`: one call is one space, so a batch resolves as its items all would.
      const named = (Array.isArray(args.ids) ? args.ids : [args.id]).filter(
        (id): id is string => typeof id === "string",
      );
      if (args.kind === "operation") {
        const orgLevel =
          named.length > 0 &&
          named.every((id) => {
            const op = getCatalog().operations.get(id);
            return op && effectiveOperationScope(op, policy.orgPermissions).kind === "organization";
          });
        return explicit === undefined || orgLevel ? { kind: "none" } : direct();
      }
      if (args.kind !== "skill") return direct();
      const homes = new Set(named.map((id) => parseSkillUri(id)?.spaceId));
      const [home] = homes;
      // Skills of several spaces: the call's space is chosen, and each skill of another one is
      // refused on its own.
      return homes.size === 1 && home !== undefined ? target(home) : direct();
    }
    case "operation":
      break;
  }
  const op =
    typeof args.operation_id === "string"
      ? getCatalog().operations.get(args.operation_id)
      : undefined;
  if (!op) return { kind: "none" }; // Its own handler reports the unknown or missing operation id.
  const rule = effectiveOperationScope(op, policy.orgPermissions);
  const body = asRecord(args.body);
  switch (rule.kind) {
    case "organization":
      return { kind: "none" };
    case "request":
      if (rule.parameter && body[rule.parameter] !== undefined) return target(body[rule.parameter]);
      return direct(rule.default === "personal" || isInlineRunSource(rule, body));
    case "aggregate":
      if (policy.bounded) return direct();
      // An explicitly named caller space still gates the tool there. Unconfined REST reads
      // the organization's whole reach either way.
      return explicit === undefined ? { kind: "none" } : direct();
    case "target":
      return target(asRecord(args[rule.source ?? "path_params"])[rule.parameter], rule.optional);
    case "resource": {
      if (rule.source === "row") return { kind: "row", id: explicit };
      const resource = resourceAddress(rule, args);
      if (resource.kind === "organization" || resource.kind === "invalid") return { kind: "none" };
      if (resource.kind === "target") return target(resource.spaceId);
      return rule.source === "query" &&
        explicit === undefined &&
        !policy.bounded &&
        policy.orgPermissions?.has(rule.organizationPermission)
        ? { kind: "none" }
        : direct();
    }
  }
}

/** Supply only the space parameter a route declares, once its destination is known.
 * Other missing path/body/query arguments remain the route's own validation errors. */
export function withOperationTarget(
  op: CatalogOperation,
  args: Record<string, unknown>,
  spaceId: string | undefined,
): Record<string, unknown> {
  if (!spaceId) return args;
  const rule = op.spaceScope;
  if (!("parameter" in rule) || !rule.parameter) return args;
  const parameter = rule.parameter;
  let source: "path_params" | "body" | "query";
  if (rule.kind === "request") source = "body";
  else if (rule.kind === "target" && !rule.optional) source = rule.source ?? "path_params";
  else if (rule.kind === "resource") {
    source = rule.source;
    const resource = resourceAddress(rule, args);
    if (resource.kind === "organization" || resource.kind === "invalid") return args;
  } else return args;
  const original = args[source];
  if (
    original !== undefined &&
    (original === null || typeof original !== "object" || Array.isArray(original))
  )
    return args;
  const bag = asRecord(original);
  return bag[parameter] === undefined
    ? { ...args, [source]: { ...bag, [parameter]: spaceId } }
    : args;
}
