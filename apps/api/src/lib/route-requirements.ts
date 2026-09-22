// SPDX-License-Identifier: Apache-2.0

/**
 * What a route requires, read off Hono's route table — the same mounts that
 * decide it (`middleware/handler-marker.ts`). Matching follows Hono's, segment
 * by segment, since several operations have no route of their own: a prefix
 * mount (`*`) with a concrete method SERVES its subtree, bare prefix included;
 * a wildcard `ALL` mount only DECORATES, contributing its guard without making
 * anything exist, while an exact-path one serves every method; a root `/*`
 * entry with a concrete method is the SPA fallback and is discarded outright,
 * since reading it would answer every GET template ever spelled. A guard
 * mounted after a space re-scope (`markSpaceRescope`) is enforced in the space
 * the PATH names, so it is reported separately and never filters.
 */

import { PERMISSION_REQUIREMENT_MARKER } from "@appstrate/core/permissions";
import { getPattern, splitPath, splitRoutingPath } from "hono/utils/url";
import { readHandlerMarker } from "../middleware/handler-marker.ts";
import { isRowAuthority, isSpaceRescope } from "../middleware/require-permission.ts";

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

/** One segment of a mounted path, in Hono's own grammar. */
type Token =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly accepts: RegExp | null }
  | { readonly kind: "wildcard" };

/** One segment of an OpenAPI template; `null` is a `{param}`, i.e. any value. */
type TemplateSegment = string | null;

const WILDCARD: Token = Object.freeze({ kind: "wildcard" });

interface TableEntry {
  readonly method: string;
  /** Without the trailing `*` of a prefix mount. */
  readonly tokens: readonly Token[];
  /** Ended in `*`: covers the subtree, bare prefix included. */
  readonly prefix: boolean;
  readonly requirement: string | null;
  readonly rowDecides: boolean;
  /** Everything matched after this entry is enforced in the space the path names. */
  readonly rescope: boolean;
}

function tokenize(path: string): Token[] {
  return splitRoutingPath(path).map((label): Token => {
    const pattern = getPattern(label);
    if (pattern === "*") return WILDCARD;
    if (pattern === null) return { kind: "literal", value: label };
    return { kind: "param", accepts: pattern[2] === true ? null : pattern[2] };
  });
}

function templateSegments(pathTemplate: string): TemplateSegment[] {
  return splitPath(pathTemplate).map((segment) => (/^\{[^{}]+\}$/.test(segment) ? null : segment));
}

export function deriveRouteRequirements(
  routes: ReadonlyArray<{ method: string; path: string; handler: unknown }>,
): RouteRequirementLookup {
  const entries: TableEntry[] = [];
  for (const route of routes) {
    const method = route.method.toUpperCase();
    // The SPA fallback only. An `ALL /*` mount decorates without serving, so
    // dropping it would silently discard a guard covering the whole app.
    if (route.path === "/*" && method !== "ALL") continue;
    const tokens = tokenize(route.path);
    const prefix = tokens.at(-1)?.kind === "wildcard";
    const required = readHandlerMarker(route.handler, PERMISSION_REQUIREMENT_MARKER);
    entries.push({
      method,
      tokens: prefix ? tokens.slice(0, -1) : tokens,
      prefix,
      requirement: typeof required === "string" && required.length > 0 ? required : null,
      rowDecides: isRowAuthority(route.handler),
      rescope: isSpaceRescope(route.handler),
    });
  }
  return (method, pathTemplate) =>
    lookup(entries, method.toUpperCase(), templateSegments(pathTemplate));
}

function lookup(
  entries: readonly TableEntry[],
  method: string,
  template: readonly TemplateSegment[],
): RouteRequirement | undefined {
  let served = false;
  let rescoped = false;
  let conditional = false;
  const requirements: string[] = [];
  const targetSpaceRequirements: string[] = [];
  // Mount order, so a guard is attributed to the space in force where it sits.
  for (const entry of entries) {
    if (entry.method !== "ALL" && entry.method !== method) continue;
    if (!matches(entry, template)) continue;
    if (!entry.prefix || entry.method !== "ALL") served = true;
    if (entry.rescope) rescoped = true;
    if (entry.rowDecides) conditional = true;
    if (entry.requirement !== null) {
      // A guard reached twice is one requirement to the model.
      const into = rescoped ? targetSpaceRequirements : requirements;
      if (!into.includes(entry.requirement)) into.push(entry.requirement);
    }
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

/** Hono's match, lifted from a URL to a template: a `{param}` also stands for
 *  values a mount literal does not name, so only a mount param covers it. */
function matches(entry: TableEntry, template: readonly TemplateSegment[]): boolean {
  const { tokens } = entry;
  if (entry.prefix ? template.length < tokens.length : template.length !== tokens.length) {
    return false;
  }
  return template.every((segment, i) => i >= tokens.length || tokenCovers(tokens[i]!, segment));
}

function tokenCovers(token: Token, segment: TemplateSegment): boolean {
  switch (token.kind) {
    case "wildcard":
      return true;
    case "literal":
      return segment === token.value;
    case "param":
      return segment === null || token.accepts === null || token.accepts.test(segment);
  }
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
