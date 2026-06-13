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
const SCOPED_PACKAGE_ID_RE = /^@[^/]+\/[^/]+$/;

/**
 * Path serializer mirroring openapi-fetch's default (simple style, the only
 * style this spec uses) with two API-mandated deviations — Hono's regex
 * routes match the RAW path, so percent-encoding these 404s:
 * - `@` stays literal (`:scope{@[^/]+}` routes; `%40scope` never matches).
 *   Valid pchar per RFC 3986, safe unencoded.
 * - a value shaped like a scoped package id (`@scope/name`) keeps its `/` as
 *   a real separator (`:packageId{@[^/]+/[^/]+}` routes; `%2F` never
 *   matches); each segment is encoded individually. No other ID type starts
 *   with `@`, so the shape test is unambiguous.
 * Everything else stays percent-encoded.
 */
export function pathSerializer(pathname: string, pathParams: Record<string, unknown>): string {
  let next = pathname;
  for (const match of pathname.match(PATH_PARAM_RE) ?? []) {
    const value = pathParams[match.slice(1, -1)];
    if (value === undefined || value === null) continue;
    const raw = String(value);
    const encoded = SCOPED_PACKAGE_ID_RE.test(raw)
      ? raw.split("/").map(encodeSegment).join("/")
      : encodeSegment(raw);
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
