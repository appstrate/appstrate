// SPDX-License-Identifier: Apache-2.0

/**
 * What a route requires, read off Hono's route table — the same mounts that
 * decide it, never a second list beside them (`middleware/handler-marker.ts`).
 *
 * The lookup follows Hono's matching, not an exact `(method, path)` key, since
 * several operations have no route of their own. A prefix mount (path ending
 * in `*`) with a concrete method SERVES its subtree, bare prefix path
 * included: `app.on(["POST"], "/api/auth/*")` is every auth operation. An
 * `ALL` mount only DECORATES — `app.use("/api/*", cors)` makes nothing exist —
 * yet still contributes its guard beneath, and an exact-path one is
 * indistinguishable from `router.use()`, so it counts as serving
 * (`scripts/verify-openapi.ts` is what catches a documented operation whose
 * handler was removed).
 */

import { PERMISSION_REQUIREMENT_MARKER } from "@appstrate/core/permissions";
import { readHandlerMarker } from "../middleware/handler-marker.ts";
import { isPermissionGuard } from "../middleware/require-permission.ts";

export interface RouteRequirement {
  /** One per guard, in mount order, all required; `"a|b"` is a disjunction. */
  readonly requirements: readonly string[];
  /** A guard stamped no requirement: the above is a lower bound, the row decides. */
  readonly conditional: boolean;
}

/** A route with no guard at all — granted to anyone who reached the transport. */
export const NO_REQUIREMENT: RouteRequirement = Object.freeze({
  requirements: Object.freeze([]) as readonly string[],
  conditional: false,
});

const PARAM_CHAR = /[A-Za-z0-9_]/;

/** `"POST /api/agents/{scope}/{name}"` — Hono's `:param` (constrained or not) in
 *  OpenAPI form, so the join needs no second grammar. */
export function routeRequirementKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${openApiPath(path)}`;
}

function openApiPath(path: string): string {
  let out = "";
  let i = 0;
  while (i < path.length) {
    if (path.charAt(i) !== ":") {
      out += path.charAt(i);
      i += 1;
      continue;
    }
    let end = i + 1;
    while (end < path.length && PARAM_CHAR.test(path.charAt(end))) end += 1;
    const name = path.slice(i + 1, end);
    if (name === "") {
      out += ":";
      i += 1;
      continue;
    }
    // `:packageId{@[^/]+/[^/]+}` — a constraint holds `/` and nested braces.
    if (path.charAt(end) === "{") {
      let depth = 1;
      end += 1;
      while (end < path.length && depth > 0) {
        const char = path.charAt(end);
        if (char === "{") depth += 1;
        else if (char === "}") depth -= 1;
        end += 1;
      }
    }
    out += `{${name}}`;
    i = end;
  }
  return out;
}

export interface RouteTable {
  /** The route serving `METHOD pathTemplate`; `undefined` when none does. */
  requirementFor(method: string, pathTemplate: string): RouteRequirement | undefined;
}

/** Pre-rewritten so a lookup only compares; exactly one of the two is set. */
interface TableEntry {
  readonly method: string;
  readonly exact: string | null;
  readonly prefix: string | null;
  readonly requirement: string | null;
  readonly rowAware: boolean;
}

export function deriveRouteRequirements(
  routes: ReadonlyArray<{ method: string; path: string; handler: unknown }>,
): RouteTable {
  const entries: TableEntry[] = routes.map((route) => {
    const path = openApiPath(route.path);
    const wildcard = path.endsWith("*");
    const required = readHandlerMarker(route.handler, PERMISSION_REQUIREMENT_MARKER);
    const requirement = typeof required === "string" && required.length > 0 ? required : null;
    return {
      method: route.method.toUpperCase(),
      exact: wildcard ? null : path,
      prefix: wildcard ? path.slice(0, -1) : null,
      requirement,
      rowAware: requirement === null && isPermissionGuard(route.handler),
    };
  });

  const answers = new Map<string, RouteRequirement | undefined>();
  return {
    requirementFor(method: string, pathTemplate: string): RouteRequirement | undefined {
      const key = routeRequirementKey(method, pathTemplate);
      if (answers.has(key)) return answers.get(key);
      const answer = lookup(entries, method.toUpperCase(), openApiPath(pathTemplate));
      answers.set(key, answer);
      return answer;
    },
  };
}

function lookup(
  entries: readonly TableEntry[],
  method: string,
  template: string,
): RouteRequirement | undefined {
  let served = false;
  const requirements: string[] = [];
  let conditional = false;
  for (const entry of entries) {
    if (entry.method !== "ALL" && entry.method !== method) continue;
    const exactHit = entry.exact !== null && entry.exact === template;
    if (!exactHit && !coversPrefix(entry.prefix, template)) continue;
    if (exactHit || entry.method !== "ALL") served = true;
    // De-duplicated: a guard reached twice is one requirement to the model.
    if (entry.requirement !== null) {
      if (!requirements.includes(entry.requirement)) requirements.push(entry.requirement);
    } else if (entry.rowAware) conditional = true;
  }
  if (!served) return undefined;
  if (requirements.length === 0 && !conditional) return NO_REQUIREMENT;
  return Object.freeze({
    requirements: Object.freeze(requirements) as readonly string[],
    conditional,
  });
}

function coversPrefix(prefix: string | null, template: string): boolean {
  if (prefix === null) return false;
  if (template.startsWith(prefix)) return true;
  return prefix.endsWith("/") && template === prefix.slice(0, -1);
}

/** Every requirement holds, a `|` entry on any alternative; a conditional one
 *  is granted here — only the row could still refuse. */
export function isGranted(
  requirement: RouteRequirement,
  permissions: ReadonlySet<string>,
): boolean {
  return requirement.requirements.every((entry) =>
    entry.split("|").some((alternative) => permissions.has(alternative)),
  );
}
