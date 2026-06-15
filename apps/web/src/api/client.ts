// SPDX-License-Identifier: Apache-2.0

/**
 * Typed API client, generated from the OpenAPI spec (`schema.d.ts`).
 *
 * - `client` (openapi-fetch): paths, params, request bodies, and response
 *   shapes are checked against the spec at compile time.
 * - `$api` (openapi-react-query): typed `useQuery`/`useMutation`/`queryOptions`
 *   wrappers around the same client, with automatic query keys.
 *
 * Middleware injects platform context and normalizes errors:
 * - `X-Org-Id` / `X-Application-Id` headers injected from the org/app stores
 * - non-2xx responses throw `ApiError` (RFC 9457 problem details), so React
 *   Query errors are `instanceof ApiError` with `code`/`status`/`requestId`.
 *   Note: because errors are thrown, the `{ error }` branch of direct
 *   `client.GET(...)` calls is never populated — always use try/catch.
 */
import createFetchClient, { type Middleware } from "openapi-fetch";
import createReactQueryClient from "openapi-react-query";
import type { components, paths } from "./schema";
import { ApiError } from "./errors";
import { getCurrentOrgId } from "../stores/org-store";
import { getCurrentApplicationId } from "../stores/app-store";

type ProblemDetail = components["schemas"]["ProblemDetail"];

const PATH_PARAM_RE = /\{[^{}]+\}/g;

/**
 * Path params that carry a full scoped package id (`@scope/name`) in a SINGLE
 * param — their internal `/` is a real route separator and must stay literal
 * (Hono `:packageId{@[^/]+/[^/]+}` routes; `%2F` never matches). Each `@scope`
 * and `name` segment is encoded individually with the `@` kept literal.
 */
const SCOPED_PACKAGE_ID_PARAMS = new Set(["packageId", "agentPackageId"]);

/**
 * Path params that carry a bare scope segment (`@scope`) — the leading `@`
 * must stay literal (Hono `:scope{@[^/]+}` routes; `%40scope` never matches).
 */
const SCOPE_SEGMENT_PARAMS = new Set(["scope"]);

/**
 * Path serializer mirroring openapi-fetch's default (simple style, the only
 * style this spec uses) with two API-mandated deviations — Hono's regex routes
 * match the RAW path, so percent-encoding these 404s. The deviations are keyed
 * on the PARAM NAME (not the value shape): only package-id / scope params relax
 * encoding, so an arbitrary value that happens to start with `@` or contain `/`
 * in some other param is still faithfully percent-encoded.
 */
export function pathSerializer(pathname: string, pathParams: Record<string, unknown>): string {
  let next = pathname;
  for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
    const paramName = match.slice(1, -1);
    const value = pathParams[paramName];
    if (value === undefined || value === null) continue;
    const raw = String(value);
    let encoded: string;
    if (SCOPED_PACKAGE_ID_PARAMS.has(paramName)) {
      encoded = raw.split("/").map(encodeSegment).join("/");
    } else if (SCOPE_SEGMENT_PARAMS.has(paramName)) {
      encoded = encodeSegment(raw);
    } else {
      encoded = encodeURIComponent(raw);
    }
    next = next.replace(match, encoded);
  }
  return next;
}

function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).split("%40").join("@");
}

const orgContext: Middleware = {
  onRequest({ request }) {
    const orgId = getCurrentOrgId();
    if (orgId && !request.headers.has("X-Org-Id")) {
      request.headers.set("X-Org-Id", orgId);
    }
    const applicationId = getCurrentApplicationId();
    if (applicationId && !request.headers.has("X-Application-Id")) {
      request.headers.set("X-Application-Id", applicationId);
    }
    return request;
  },
};

const problemDetailErrors: Middleware = {
  async onResponse({ response }) {
    if (response.ok) return response;
    const body: Partial<ProblemDetail> = await response
      .clone()
      .json()
      .catch(() => ({ detail: response.statusText }));
    if (body.code) {
      throw new ApiError(
        body.code,
        body.detail || `API Error: ${response.status}`,
        response.status,
        // `ApiError.details` is intentionally an open record: the spec models
        // `errors` as a typed array, but runtime problem bodies are polymorphic
        // by `code` (validation → array of field errors; conflict codes →
        // code-specific object), so consumers narrow per `code`. The cast
        // bridges the spec's array type to that open shape.
        body.errors as unknown as Record<string, unknown> | undefined,
        body.requestId,
      );
    }
    throw new Error(body.detail || `API Error: ${response.status}`);
  },
};

/**
 * Raw typed fetch client. Spec paths already include the `/api` prefix, so
 * no baseUrl is needed — requests stay same-origin.
 */
export const client = createFetchClient<paths>({
  credentials: "include",
  pathSerializer,
});
client.use(orgContext, problemDetailErrors);

/** Typed React Query bindings: `$api.useQuery("get", "/api/end-users", ...)`. */
export const $api = createReactQueryClient(client);

export { ApiError } from "./errors";
export type { components, paths } from "./schema";
