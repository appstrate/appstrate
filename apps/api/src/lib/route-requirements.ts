// SPDX-License-Identifier: Apache-2.0

/**
 * What a route requires, read off Hono's route table — the same mounts that
 * decide it (`middleware/handler-marker.ts`). Matching follows Hono's, since
 * several operations have no route of their own: a prefix mount (`*`) with a
 * concrete method SERVES its subtree, bare prefix included; a wildcard `ALL`
 * mount only DECORATES, contributing its guard without making anything exist,
 * while an exact-path one serves every method; a root `/*` entry with a
 * concrete method is the SPA fallback and is discarded outright, since reading
 * it would answer every GET template ever spelled — an `ALL /*` is kept, since
 * a guard mounted that way really does gate everything beneath it. A guard mounted
 * after a space re-scope (`markSpaceRescope`) is enforced in the space the
 * PATH names, so it is reported separately and never filters.
 */

import { PERMISSION_REQUIREMENT_MARKER } from "@appstrate/core/permissions";
import { readHandlerMarker } from "../middleware/handler-marker.ts";
import {
  isPermissionGuard,
  isRowAuthority,
  isSpaceRescope,
} from "../middleware/require-permission.ts";

export interface RouteRequirement {
  /** One per guard evaluated in the caller's own space, mount order, all required; `"a|b"` is a disjunction. Filters. */
  readonly requirements: readonly string[];
  /** Guards mounted after a space re-scope: enforced in the space the path names. Shown, never filtered. */
  readonly targetSpaceRequirements: readonly string[];
  /** The row, or the target space, decides: `requirements` is a lower bound. */
  readonly conditional: boolean;
}

/** A route no guard narrows — granted to anyone who reached the transport. */
const UNGUARDED: RouteRequirement = Object.freeze({
  requirements: Object.freeze([]) as readonly string[],
  targetSpaceRequirements: Object.freeze([]) as readonly string[],
  conditional: false,
});

/** Answers the requirement for `METHOD pathTemplate`; `undefined` when no route serves it. */
export type RouteRequirementLookup = (
  method: string,
  pathTemplate: string,
) => RouteRequirement | undefined;

const PARAM_CHAR = /[A-Za-z0-9_]/;

/** Hono's `:param` (constrained or not) in OpenAPI `{param}` form, so the join
 *  between the route table and the spec needs no second grammar. */
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

/** Pre-rewritten so a lookup only compares; exactly one of the two paths is set. */
interface TableEntry {
  readonly method: string;
  readonly exact: string | null;
  readonly prefix: string | null;
  readonly requirement: string | null;
  /** The handler decides on the row it loads — a guard stamping no requirement, or `rowAuthority()`. */
  readonly rowDecides: boolean;
  /** Everything matched after this entry is enforced in the space the path names. */
  readonly rescope: boolean;
}

export function deriveRouteRequirements(
  routes: ReadonlyArray<{ method: string; path: string; handler: unknown }>,
): RouteRequirementLookup {
  const entries: TableEntry[] = [];
  for (const route of routes) {
    const path = openApiPath(route.path);
    // The SPA fallback only. An `ALL /*` mount decorates without serving, so
    // dropping it would silently discard a guard covering the whole app.
    if (path === "/*" && route.method.toUpperCase() !== "ALL") continue;
    const wildcard = path.endsWith("*");
    const required = readHandlerMarker(route.handler, PERMISSION_REQUIREMENT_MARKER);
    const requirement = typeof required === "string" && required.length > 0 ? required : null;
    entries.push({
      method: route.method.toUpperCase(),
      exact: wildcard ? null : path,
      prefix: wildcard ? path.slice(0, -1) : null,
      requirement,
      rowDecides:
        (requirement === null && isPermissionGuard(route.handler)) || isRowAuthority(route.handler),
      rescope: isSpaceRescope(route.handler),
    });
  }
  return (method, pathTemplate) => lookup(entries, method.toUpperCase(), openApiPath(pathTemplate));
}

function lookup(
  entries: readonly TableEntry[],
  method: string,
  template: string,
): RouteRequirement | undefined {
  let served = false;
  let rescoped = false;
  let conditional = false;
  const requirements: string[] = [];
  const targetSpaceRequirements: string[] = [];
  // Mount order, so a guard is attributed to the space in force where it sits.
  for (const entry of entries) {
    if (entry.method !== "ALL" && entry.method !== method) continue;
    const exactHit = entry.exact !== null && entry.exact === template;
    if (!exactHit && !coversPrefix(entry.prefix, template)) continue;
    if (exactHit || entry.method !== "ALL") served = true;
    if (entry.rescope) rescoped = true;
    if (entry.requirement !== null) {
      // De-duplicated: a guard reached twice is one requirement to the model.
      const into = rescoped ? targetSpaceRequirements : requirements;
      if (!into.includes(entry.requirement)) into.push(entry.requirement);
    } else if (entry.rowDecides) conditional = true;
  }
  if (!served) return undefined;
  if (targetSpaceRequirements.length > 0) conditional = true;
  if (requirements.length === 0 && !conditional) return UNGUARDED;
  return Object.freeze({
    requirements: Object.freeze(requirements) as readonly string[],
    targetSpaceRequirements: Object.freeze(targetSpaceRequirements) as readonly string[],
    conditional,
  });
}

function coversPrefix(prefix: string | null, template: string): boolean {
  if (prefix === null) return false;
  if (template.startsWith(prefix)) return true;
  return prefix.endsWith("/") && template === prefix.slice(0, -1);
}

/** Every requirement holds, a `|` entry on any alternative. Target-space and
 *  row-conditional requirements are granted here — only the space or the row
 *  the call names could still refuse. */
export function isGranted(
  requirement: RouteRequirement,
  permissions: ReadonlySet<string>,
): boolean {
  return requirement.requirements.every((entry) =>
    entry.split("|").some((alternative) => permissions.has(alternative)),
  );
}
