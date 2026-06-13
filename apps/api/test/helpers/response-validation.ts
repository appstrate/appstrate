// SPDX-License-Identifier: Apache-2.0

/**
 * Global response-validation middleware for the test harness.
 *
 * Wired into `getTestApp()` so EVERY JSON response produced by EVERY test is
 * validated against its OpenAPI response schema — turning the whole suite into
 * a contract gate. This catches the drift class the static `verify-openapi`
 * gate structurally cannot reach: "reverse-lies" where the spec marks a
 * response field required / non-nullable but the handler can omit or null it on
 * some path, plus undeclared response fields and undeclared status codes.
 *
 * Behavior:
 *   - Only `application/json` 2xx/3xx/4xx bodies are checked. `application/
 *     problem+json` (RFC 9457 errors), SSE streams, blobs, and empty bodies
 *     are skipped — error envelopes are covered by their own tests.
 *   - A request path that maps to no spec operation is skipped (e.g. `/internal`,
 *     `/invite`, module public pages). Everything under a documented path IS
 *     checked.
 *   - On a JSON response whose status is NOT declared for the matched operation,
 *     or whose body is missing a required field / carries an undeclared
 *     top-level field, the middleware THROWS. The error surfaces through the
 *     app's `onError` handler as a 500, failing the test fail-closed with a
 *     `[response-contract]` message naming the operation and the exact drift.
 *
 * Schemas and path matchers are precompiled once at middleware construction, so
 * per-response cost is a regex scan + a cached AJV `validate()` call.
 */
import type { MiddlewareHandler } from "hono";
import { createOpenApiValidator } from "./openapi-validator.ts";

interface SpecLike {
  paths: Record<string, Record<string, unknown>>;
}

interface PathMatcher {
  /** Original spec path template, e.g. "/api/agents/{scope}/{name}". */
  specPath: string;
  /** Compiled regex matching a concrete request path. */
  regex: RegExp;
  /** Count of literal (non-`{param}`) segments — higher = more specific. */
  specificity: number;
  /** Lowercased HTTP methods this path declares operations for. */
  methods: Set<string>;
}

/** A precompiled, dereferenced response schema + its AJV validator. */
interface CompiledResponse {
  validate: (body: unknown) => { valid: boolean; errors: string[]; extraFields: string[] };
}

const STATUS_HAS_NO_BODY = new Set(["204", "304"]);

/**
 * Path prefixes whose response bodies the platform does NOT own — verbatim
 * upstream passthrough proxies. The LLM proxy forwards the provider's response
 * (and its status code, including forwarded 4xx/5xx errors) byte-for-byte, so
 * the body shape is the upstream provider's, not a platform contract, and the
 * SPA never consumes it (runner-facing). Validating it against the platform
 * spec would false-positive on every provider-specific field.
 */
const PASSTHROUGH_PREFIXES = ["/api/llm-proxy"];

/** Outcome of resolving a (path, method, status) to a response schema. */
type Resolved =
  | { kind: "validate"; compiled: CompiledResponse }
  | { kind: "skip" } // declared, but intentionally opaque / no JSON body to check
  | { kind: "undeclared" }; // status not declared at all for this operation

function buildPathMatchers(spec: SpecLike): PathMatcher[] {
  const matchers: PathMatcher[] = [];
  for (const [specPath, operations] of Object.entries(spec.paths)) {
    const segments = specPath.split("/");
    const pattern = segments
      .map((seg) => (/^\{.+\}$/.test(seg) ? "[^/]+" : escapeRegex(seg)))
      .join("/");
    const specificity = segments.filter((seg) => !/^\{.+\}$/.test(seg)).length;
    const methods = new Set(
      Object.keys(operations)
        .map((m) => m.toLowerCase())
        .filter((m) => ["get", "post", "put", "patch", "delete", "head", "options"].includes(m)),
    );
    matchers.push({ specPath, regex: new RegExp(`^${pattern}$`), specificity, methods });
  }
  // Most-specific first so `/api/runs/inline` wins over `/api/runs/{id}`.
  matchers.sort((a, b) => b.specificity - a.specificity);
  return matchers;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function createResponseValidationMiddleware(spec: unknown): MiddlewareHandler {
  const validator = createOpenApiValidator(spec);
  const matchers = buildPathMatchers(spec as SpecLike);
  // Lazy cache of resolutions, keyed by `${method} ${specPath} ${status}`.
  const cache = new Map<string, Resolved>();

  function resolve(specPath: string, method: string, status: string): Resolved {
    const key = `${method} ${specPath} ${status}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;

    let schema: unknown;
    try {
      schema = validator.getResponseSchema(specPath, method, status);
    } catch {
      // getResponseSchema throws only when the status (or method/path) is not
      // declared for this operation — a genuine contract breach.
      const r: Resolved = { kind: "undeclared" };
      cache.set(key, r);
      return r;
    }
    // Declared, but no application/json schema attached — an intentional opaque
    // body (e.g. the LLM proxy's `application/json: {}` upstream passthrough) or
    // a no-content response. Nothing to validate; not a breach.
    if (schema == null) {
      const r: Resolved = { kind: "skip" };
      cache.set(key, r);
      return r;
    }
    const r: Resolved = {
      kind: "validate",
      compiled: { validate: (body) => validator.validateResponse(body, schema) },
    };
    cache.set(key, r);
    return r;
  }

  function matchSpecPath(reqPath: string, method: string): string | null {
    for (const m of matchers) {
      if (m.methods.has(method) && m.regex.test(reqPath)) return m.specPath;
    }
    return null;
  }

  return async (c, next) => {
    await next();

    const res = c.res;
    if (!res) return;
    const contentType = res.headers.get("content-type") ?? "";
    // Only structured JSON success/data bodies. Excludes problem+json errors,
    // text/event-stream, octet-stream blobs, html.
    if (!contentType.includes("application/json")) return;
    if (STATUS_HAS_NO_BODY.has(String(res.status))) return;

    const method = c.req.method.toLowerCase();
    const reqPath = new URL(c.req.url).pathname;
    if (PASSTHROUGH_PREFIXES.some((p) => reqPath.startsWith(p))) return;
    const specPath = matchSpecPath(reqPath, method);
    if (!specPath) return; // undocumented surface (internal, invite, module pages)

    const status = String(res.status);

    let body: unknown;
    try {
      body = await res.clone().json();
    } catch {
      return; // not actually JSON despite the header
    }

    const resolved = resolve(specPath, method, status);
    if (resolved.kind === "skip") return;
    if (resolved.kind === "undeclared") {
      // A JSON body on a status the spec does not declare for this operation
      // is itself a contract breach.
      throw new Error(
        `[response-contract] ${method.toUpperCase()} ${specPath} returned ${status} with a JSON body, ` +
          `but that status is not declared for the operation.`,
      );
    }

    const result = resolved.compiled.validate(body);
    if (result.valid && result.extraFields.length === 0) return;

    const problems = [
      ...result.errors,
      ...result.extraFields.map((f) => `undeclared field "${f}"`),
    ];
    throw new Error(
      `[response-contract] ${method.toUpperCase()} ${specPath} -> ${status} body violates its OpenAPI schema: ` +
        problems.join("; "),
    );
  };
}
