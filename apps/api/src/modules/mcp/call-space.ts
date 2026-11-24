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
  validate_package_file: { kind: "request", grant: "validatesPackages" },
  import_package_file: { kind: "personal", grant: "importsPackages" },
  call_integration_tool: { kind: "personal", grant: "proxies" },
  get_me: { kind: "request", grant: null },
  get_runtime_capabilities: { kind: "none", grant: null },
} as const satisfies Record<
  McpToolName,
  {
    kind: "none" | "search" | "describe" | "operation" | "run" | "request" | "read" | "personal";
    grant: keyof McpSurface | null;
  }
>;

const PERSONAL_OPERATIONS = new Set([
  "createAgent",
  "createSkill",
  "createIntegrationPackage",
  "forkPackage",
  "importPackage",
  "importBundle",
  "importPackageFromGithub",
  "runInline",
  "validateInlineRun",
]);

/** Admission, the tool's guard, and its receipt use the same decision. An omitted id on a
 * space call means the caller must choose. A target can differ from the space a call enters. */
export type CallSpace =
  { kind: "none" } | { kind: "space"; id: unknown; target?: string } | { kind: "row"; id: unknown };

type SpacePolicy = Pick<
  OrgWideSpaces,
  "reachable" | "bounded" | "originSpaceId" | "orgPermissions" | "spaceChoice"
>;

export function effectiveOperationScope(
  op: CatalogOperation,
  orgPermissions?: ReadonlySet<string>,
) {
  const rule = op.spaceScope;
  return rule.kind === "aggregate" && rule.permission && !orgPermissions?.has(rule.permission)
    ? ({ kind: "organization" } as const)
    : rule;
}

export function chosenCallSpace(name: unknown, args: Record<string, unknown>, policy: SpacePolicy) {
  const choice = policy.spaceChoice;
  return choice &&
    choice.tool === name &&
    (name !== "invoke_operation" || choice.operationId === args.operation_id)
    ? choice.spaceId
    : undefined;
}

export function resolveCallSpace(
  name: unknown,
  args: Record<string, unknown>,
  policy: SpacePolicy,
): CallSpace {
  const chosen = chosenCallSpace(name, args, policy);
  const explicit = args.space_id === undefined ? chosen : args.space_id;
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
      if (args.kind === "operation") {
        const op = typeof args.id === "string" ? getCatalog().operations.get(args.id) : undefined;
        return explicit === undefined ||
          (op && effectiveOperationScope(op, policy.orgPermissions).kind === "organization")
          ? { kind: "none" }
          : direct();
      }
      const skill =
        args.kind === "skill" && typeof args.id === "string" ? parseSkillUri(args.id) : null;
      return skill ? target(skill.spaceId) : direct();
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
      return direct(
        PERSONAL_OPERATIONS.has(op.operationId) ||
          (op.operationId === "createRemoteRun" && asRecord(body.source).kind === "inline"),
      );
    case "aggregate":
      if (policy.bounded) return direct();
      // An explicitly named caller space still gates the tool there. Unconfined REST reads
      // the organization's whole reach either way.
      return explicit === undefined ? { kind: "none" } : direct();
    case "target":
      return target(asRecord(args[rule.source ?? "path_params"])[rule.parameter], rule.optional);
    case "resource": {
      if (rule.source === "row") return { kind: "row", id: explicit };
      if (rule.source === "body")
        return body[rule.levelParameter] === rule.spaceLevel
          ? target(body[rule.parameter])
          : { kind: "none" };
      const query = asRecord(args.query);
      if (query[rule.allParameter] === true || query[rule.allParameter] === "true")
        return { kind: "none" };
      if (query[rule.parameter] !== undefined) return target(query[rule.parameter]);
      return explicit === undefined &&
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
  let source: "path_params" | "body" | "query";
  if (rule.kind === "target" && !rule.optional) source = rule.source ?? "path_params";
  else if (rule.kind === "resource" && rule.source !== "row") {
    source = rule.source;
    if (rule.source === "body" && asRecord(args.body)[rule.levelParameter] !== rule.spaceLevel)
      return args;
    if (rule.source === "query" && String(asRecord(args.query)[rule.allParameter]) === "true")
      return args;
  } else return args;
  const original = args[source];
  if (
    original !== undefined &&
    (original === null || typeof original !== "object" || Array.isArray(original))
  )
    return args;
  const bag = asRecord(original);
  return bag[rule.parameter] === undefined
    ? { ...args, [source]: { ...bag, [rule.parameter]: spaceId } }
    : args;
}
