// SPDX-License-Identifier: Apache-2.0

/**
 * What a route requires, read off the handler markers of Hono's route table
 * and matched segment by segment as Hono matches, since several operations
 * have no route of their own. An operation is SERVED by the first terminal
 * handler that matches all of it, whatever its method or path shape; middleware
 * matching before it only adds its guard. Guards mounted after a space
 * re-scope (`markSpaceRescope`) are enforced in the space the PATH names, so
 * they are reported apart and never filter.
 */

import { PERMISSION_REQUIREMENT_MARKER } from "@appstrate/core/permissions";
import { findTargetHandler, isMiddleware } from "hono/utils/handler";
import { getPattern, splitPath, splitRoutingPath } from "hono/utils/url";
import { hasHandlerMarker, markHandler, readHandlerMarker } from "../middleware/handler-marker.ts";
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

type Token =
  | { readonly kind: "literal"; readonly value: string }
  | { readonly kind: "param"; readonly accepts: RegExp | null }
  | { readonly kind: "wildcard" };

/** One segment of an OpenAPI template; `null` is a `{param}`, i.e. any value. */
type TemplateSegment = string | null;

/** `partial`: the entry runs for some values of a `{param}` and not others. */
type Match = "none" | "partial" | "full";

const WILDCARD: Token = Object.freeze({ kind: "wildcard" });

interface TableEntry {
  readonly method: string;
  /** Without the trailing `*` of a prefix mount. */
  readonly tokens: readonly Token[];
  readonly prefix: boolean;
  readonly serves: boolean;
  readonly requirement: string | null;
  readonly rowDecides: boolean;
  readonly rescope: boolean;
}

const FALLBACK = Symbol.for("appstrate.fallback");

/** Mark a catch-all terminal handler (unknown-path 404, SPA shell): it answers
 *  whatever it matches, yet serves no documented operation. */
export function markFallback<T extends object>(handler: T): T {
  return markHandler(handler, FALLBACK);
}

/** Hono's convention, not its dispatch: a handler declaring `next` is
 *  middleware (`isMiddleware` reads `length > 1`). So a middleware written with
 *  rest args or a defaulted `next` reads as serving, and `app.mount()`, whose
 *  handler declares `next`, never serves. Read on the target, since
 *  `app.route()` wraps a sub-app's handlers in a `(c, next)` shim when it has
 *  an `onError`. */
export function servesOperation(handler: unknown): boolean {
  if (typeof handler !== "function") return false;
  const target = findTargetHandler(handler as (...args: never[]) => unknown);
  return !isMiddleware(target) && !hasHandlerMarker(handler, FALLBACK);
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
    const tokens = tokenize(route.path);
    const prefix = tokens.at(-1)?.kind === "wildcard";
    const required = readHandlerMarker(route.handler, PERMISSION_REQUIREMENT_MARKER);
    entries.push({
      method,
      tokens: prefix ? tokens.slice(0, -1) : tokens,
      prefix,
      serves: servesOperation(route.handler),
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
    const match = matches(entry, template);
    if (match === "none") continue;
    if (entry.rescope) rescoped = true;
    if (entry.rowDecides) conditional = true;
    if (entry.requirement !== null) {
      // A guard reached twice is one requirement to the model.
      const into = rescoped ? targetSpaceRequirements : requirements;
      if (!into.includes(entry.requirement)) into.push(entry.requirement);
    }
    // Hono answers with the first terminal handler; nothing after it runs.
    // A partial one leaves the other values to later entries, guards included.
    if (entry.serves) {
      served = true;
      if (match === "full") break;
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
 *  values a mount literal does not name, so a literal never covers it, and a
 *  constrained mount param covers only the values its pattern accepts. */
function matches(entry: TableEntry, template: readonly TemplateSegment[]): Match {
  const { tokens } = entry;
  if (entry.prefix ? template.length < tokens.length : template.length !== tokens.length) {
    return "none";
  }
  let match: Match = "full";
  for (const [i, segment] of template.slice(0, tokens.length).entries()) {
    const covered = tokenCovers(tokens[i]!, segment);
    if (covered === "none") return "none";
    if (covered === "partial") match = "partial";
  }
  return match;
}

function tokenCovers(token: Token, segment: TemplateSegment): Match {
  switch (token.kind) {
    case "wildcard":
      return "full";
    case "literal":
      return segment === token.value ? "full" : "none";
    case "param":
      if (token.accepts === null) return "full";
      if (segment === null) return "partial";
      return token.accepts.test(segment) ? "full" : "none";
  }
}

/** Every requirement holds, a `|` entry on any alternative. Target-space and
 *  row-conditional routes count as granted: only that space or row can refuse. */
export function isGranted(
  requirement: RouteRequirement,
  permissions: ReadonlySet<string>,
): boolean {
  return requirement.requirements.every((entry) =>
    entry.split("|").some((alternative) => permissions.has(alternative)),
  );
}
