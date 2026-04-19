// SPDX-License-Identifier: Apache-2.0

/**
 * Filter + formatter helpers for `appstrate openapi list` / `show`.
 *
 * Stays client-side on purpose:
 *   - the server ships the whole schema in one call (ETag-cached),
 *   - filtering in-process keeps `list` sub-100ms even on 191 paths,
 *   - we avoid coupling the CLI release cadence to the API's filter
 *     query-param surface (issue #206's "server-side filtering"
 *     option was explicitly rejected for the same reason).
 *
 * Exports two layers:
 *   1. pure filter predicates (`matchesTag`, `matchesMethod`, …) and
 *      `collectOperations` which flattens paths[…][method] into a
 *      single indexable array. These are unit-tested in isolation.
 *   2. formatters (`formatList`, `formatShow`) returning a ready-to-
 *      write string. No I/O, no process.exit — the command file owns
 *      stdout/stderr and exit codes.
 */

import type { OpenApiDocument, OpenApiOperation } from "./openapi-cache.ts";

/** Known HTTP methods we expose as operations — matches the OpenAPI spec. */
export const HTTP_METHODS = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "head",
  "options",
  "trace",
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

/** Flattened (path, method, op) triple — the primary unit `list` operates on. */
export interface OperationEntry {
  path: string;
  method: HttpMethod;
  op: OpenApiOperation;
}

/** ANSI colors — small palette, no dependency. Disabled when stdout isn't a TTY. */
const COLORS = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
} as const;

/**
 * Color per HTTP method, curl-ish scheme. Consumers pass `useColor`
 * explicitly so tests can assert both plain + colored output.
 */
function colorForMethod(method: HttpMethod): string {
  switch (method) {
    case "get":
      return COLORS.green;
    case "post":
      return COLORS.yellow;
    case "put":
    case "patch":
      return COLORS.blue;
    case "delete":
      return COLORS.red;
    case "head":
    case "options":
    case "trace":
      return COLORS.magenta;
  }
}

function paint(text: string, color: string, useColor: boolean): string {
  return useColor ? `${color}${text}${COLORS.reset}` : text;
}

/**
 * Flatten `paths` → `OperationEntry[]` sorted by (path asc, method
 * order). Skips entries that aren't HTTP methods (OpenAPI allows
 * `parameters` / `summary` / `description` / `servers` / `$ref` to
 * sit next to methods under a path — none are operations).
 */
export function collectOperations(doc: OpenApiDocument): OperationEntry[] {
  const out: OperationEntry[] = [];
  const paths = doc.paths ?? {};
  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== "object") continue;
    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method];
      if (!op || typeof op !== "object") continue;
      out.push({ path, method, op: op as OpenApiOperation });
    }
  }
  out.sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return HTTP_METHODS.indexOf(a.method) - HTTP_METHODS.indexOf(b.method);
  });
  return out;
}

/** Case-insensitive tag match. `undefined` filter matches every op. */
export function matchesTag(entry: OperationEntry, tag: string | undefined): boolean {
  if (!tag) return true;
  const needle = tag.toLowerCase();
  const tags = entry.op.tags ?? [];
  return tags.some((t) => typeof t === "string" && t.toLowerCase() === needle);
}

/** Case-insensitive method match. Accepts "get", "GET", etc. */
export function matchesMethod(entry: OperationEntry, method: string | undefined): boolean {
  if (!method) return true;
  return entry.method.toLowerCase() === method.toLowerCase();
}

/**
 * Path glob matcher — supports `*` (single segment) and `**` (any
 * number of segments). No regex characters are exposed beyond that;
 * the caller can pass plain prefixes (`/api/runs`) or explicit globs
 * (`/api/runs/*`). A bare path (no glob char) matches only exactly —
 * this is the principle-of-least-surprise behavior tested by e.g.
 * `--path /api/runs` not accidentally matching `/api/runs/cancel`.
 */
export function matchesPath(entry: OperationEntry, pattern: string | undefined): boolean {
  if (!pattern) return true;
  if (!pattern.includes("*")) {
    return entry.path === pattern;
  }
  const regex = globToRegex(pattern);
  return regex.test(entry.path);
}

function globToRegex(pattern: string): RegExp {
  // Escape everything that isn't `*`, then re-expand glob tokens.
  // Order matters: `**` → `.*` FIRST so we don't double-expand the
  // inner `*`. `{` / `}` are also escaped (no brace expansion support).
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 2;
      } else {
        out += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (/[.+?^${}()|[\]\\]/.test(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
    i += 1;
  }
  return new RegExp(`^${out}$`);
}

/**
 * Fuzzy search — lowercased substring match across `operationId`,
 * `summary`, `description`, and `path`. We deliberately do NOT use a
 * trigram / Levenshtein matcher: every operation lives in a curated
 * spec, so substring is both sufficient and predictable. Callers who
 * want strict equality should use `--tag` / `--path` instead.
 */
export function matchesSearch(entry: OperationEntry, search: string | undefined): boolean {
  if (!search) return true;
  const needle = search.toLowerCase();
  const haystacks = [
    entry.op.operationId,
    entry.op.summary,
    entry.op.description,
    entry.path,
    entry.method,
  ];
  return haystacks.some((h) => typeof h === "string" && h.toLowerCase().includes(needle));
}

/** All filters combined. The command file composes the flags. */
export interface ListFilters {
  tag?: string;
  method?: string;
  path?: string;
  search?: string;
}

export function filterOperations(
  entries: OperationEntry[],
  filters: ListFilters,
): OperationEntry[] {
  return entries.filter(
    (e) =>
      matchesTag(e, filters.tag) &&
      matchesMethod(e, filters.method) &&
      matchesPath(e, filters.path) &&
      matchesSearch(e, filters.search),
  );
}

/**
 * Render the `list` output: one operation per line, method padded to
 * 6 chars (length of "DELETE"), path next, summary dimmed, tag in
 * brackets. Deprecated operations get a trailing `[deprecated]` in
 * bold red.
 *
 * Example:
 *   GET    /api/runs           List runs [runs]
 *   POST   /api/runs           Create a run [runs]
 *   DELETE /api/runs/{id}      Cancel a run [runs]
 */
export function formatList(entries: OperationEntry[], useColor: boolean): string {
  if (entries.length === 0) {
    return "No operations match the given filters.\n";
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const method = entry.method.toUpperCase().padEnd(6);
    const coloredMethod = paint(method, colorForMethod(entry.method), useColor);
    const summary = typeof entry.op.summary === "string" ? entry.op.summary : "";
    const summaryPart = summary ? ` — ${paint(summary, COLORS.dim, useColor)}` : "";
    const tags = Array.isArray(entry.op.tags) && entry.op.tags.length > 0 ? entry.op.tags : [];
    const tagPart =
      tags.length > 0 ? ` ${paint(`[${tags.join(",")}]`, COLORS.cyan, useColor)}` : "";
    const deprecatedPart = entry.op.deprecated
      ? ` ${paint("[deprecated]", COLORS.bold + COLORS.red, useColor)}`
      : "";
    lines.push(`${coloredMethod} ${entry.path}${summaryPart}${tagPart}${deprecatedPart}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * JSON shape for `list --json`: stable, minimal, omits the full
 * operation object (use `show --json` for that). One JSON array,
 * each item keyed so downstream tooling (jq, agent prompts) can
 * project easily.
 */
export interface ListJsonEntry {
  method: string;
  path: string;
  operationId?: string;
  summary?: string;
  tags?: string[];
  deprecated?: boolean;
}

export function toListJson(entries: OperationEntry[]): ListJsonEntry[] {
  return entries.map((e) => {
    const out: ListJsonEntry = {
      method: e.method.toUpperCase(),
      path: e.path,
    };
    if (typeof e.op.operationId === "string") out.operationId = e.op.operationId;
    if (typeof e.op.summary === "string") out.summary = e.op.summary;
    if (Array.isArray(e.op.tags) && e.op.tags.length > 0) {
      out.tags = e.op.tags.filter((t): t is string => typeof t === "string");
    }
    if (e.op.deprecated === true) out.deprecated = true;
    return out;
  });
}

/**
 * Lookup a single operation. Accepts either:
 *   - an operationId (e.g. `createRun`), or
 *   - a `METHOD /path` pair (case-insensitive method).
 *
 * Returns `null` when nothing matches; ambiguity (two operations
 * sharing an id — spec violation but possible) picks the first
 * occurrence by stable order.
 */
export function findOperation(
  doc: OpenApiDocument,
  identifier: string,
  pathArg?: string,
): OperationEntry | null {
  const entries = collectOperations(doc);
  if (pathArg !== undefined) {
    const method = identifier.toLowerCase();
    return entries.find((e) => e.method.toLowerCase() === method && e.path === pathArg) ?? null;
  }
  // Single argument: try as operationId first, then fall back to a
  // `METHOD /path` parsed from it (space-separated) for callers who
  // quote the whole thing: `appstrate openapi show "GET /api/runs"`.
  const byId = entries.find((e) => e.op.operationId === identifier);
  if (byId) return byId;
  const split = identifier.trim().split(/\s+/);
  if (split.length === 2) {
    const [m, p] = split as [string, string];
    const method = m.toLowerCase();
    return entries.find((e) => e.method.toLowerCase() === method && e.path === p) ?? null;
  }
  return null;
}

/**
 * Render the `show` output: a readable summary of one operation.
 * Sections:
 *   - method + path + tag(s)
 *   - summary + description
 *   - parameters table (in / name / required / type / description)
 *   - request body content types
 *   - response status + content types
 *
 * `--json` emits the full dereferenced operation object instead — the
 * command layer handles that; this function is text-only.
 */
export function formatShow(entry: OperationEntry, useColor: boolean): string {
  const lines: string[] = [];
  const methodLabel = entry.method.toUpperCase();
  const methodColor = colorForMethod(entry.method);
  lines.push(`${paint(methodLabel, methodColor + COLORS.bold, useColor)} ${entry.path}`);
  if (entry.op.operationId) {
    lines.push(paint(`operationId: ${entry.op.operationId}`, COLORS.dim, useColor));
  }
  const tags = Array.isArray(entry.op.tags)
    ? entry.op.tags.filter((t) => typeof t === "string")
    : [];
  if (tags.length > 0) {
    lines.push(paint(`tags: ${tags.join(", ")}`, COLORS.cyan, useColor));
  }
  if (entry.op.deprecated === true) {
    lines.push(paint("DEPRECATED", COLORS.bold + COLORS.red, useColor));
  }
  if (typeof entry.op.summary === "string" && entry.op.summary.length > 0) {
    lines.push("");
    lines.push(paint(entry.op.summary, COLORS.bold, useColor));
  }
  if (typeof entry.op.description === "string" && entry.op.description.length > 0) {
    lines.push("");
    lines.push(entry.op.description.trim());
  }

  // Parameters
  const params = Array.isArray(entry.op.parameters) ? entry.op.parameters : [];
  if (params.length > 0) {
    lines.push("");
    lines.push(paint("Parameters:", COLORS.bold, useColor));
    for (const p of params) {
      if (!p || typeof p !== "object") continue;
      const param = p as Record<string, unknown>;
      const name = typeof param.name === "string" ? param.name : "?";
      const inLoc = typeof param.in === "string" ? param.in : "?";
      const required = param.required === true;
      const schema =
        param.schema && typeof param.schema === "object"
          ? (param.schema as Record<string, unknown>)
          : undefined;
      const type = schema && typeof schema.type === "string" ? schema.type : "any";
      const description = typeof param.description === "string" ? param.description : "";
      const reqMark = required ? paint(" (required)", COLORS.red, useColor) : "";
      const descPart = description ? ` — ${paint(description, COLORS.dim, useColor)}` : "";
      lines.push(
        `  ${paint(inLoc, COLORS.cyan, useColor)}.${paint(name, COLORS.bold, useColor)}: ${type}${reqMark}${descPart}`,
      );
    }
  }

  // Request body
  const requestBody =
    entry.op.requestBody && typeof entry.op.requestBody === "object"
      ? (entry.op.requestBody as Record<string, unknown>)
      : undefined;
  if (requestBody) {
    lines.push("");
    const required = requestBody.required === true;
    lines.push(paint(`Request body${required ? " (required)" : ""}:`, COLORS.bold, useColor));
    const content =
      requestBody.content && typeof requestBody.content === "object"
        ? (requestBody.content as Record<string, unknown>)
        : {};
    const types = Object.keys(content);
    if (types.length === 0) {
      lines.push("  (no content)");
    } else {
      for (const t of types) {
        lines.push(`  ${paint(t, COLORS.cyan, useColor)}`);
      }
    }
  }

  // Responses
  const responses =
    entry.op.responses && typeof entry.op.responses === "object" ? entry.op.responses : undefined;
  if (responses && Object.keys(responses).length > 0) {
    lines.push("");
    lines.push(paint("Responses:", COLORS.bold, useColor));
    const sortedStatuses = Object.keys(responses).sort((a, b) => {
      // Numeric status codes first in ascending order, `default` last.
      const an = /^\d+$/.test(a) ? Number(a) : Infinity;
      const bn = /^\d+$/.test(b) ? Number(b) : Infinity;
      if (an !== bn) return an - bn;
      return a.localeCompare(b);
    });
    for (const status of sortedStatuses) {
      const resp = (responses as Record<string, unknown>)[status];
      if (!resp || typeof resp !== "object") continue;
      const respObj = resp as Record<string, unknown>;
      const description = typeof respObj.description === "string" ? respObj.description : "";
      const statusColor = status.startsWith("2")
        ? COLORS.green
        : status.startsWith("3")
          ? COLORS.blue
          : status.startsWith("4")
            ? COLORS.yellow
            : status.startsWith("5")
              ? COLORS.red
              : COLORS.gray;
      const descPart = description ? ` — ${paint(description, COLORS.dim, useColor)}` : "";
      lines.push(`  ${paint(status, statusColor + COLORS.bold, useColor)}${descPart}`);
      const content =
        respObj.content && typeof respObj.content === "object"
          ? (respObj.content as Record<string, unknown>)
          : undefined;
      if (content) {
        for (const t of Object.keys(content)) {
          lines.push(`    ${paint(t, COLORS.cyan, useColor)}`);
        }
      }
    }
  }

  return lines.join("\n") + "\n";
}
