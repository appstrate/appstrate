// SPDX-License-Identifier: Apache-2.0

import { STD_RESPONSE_HEADERS } from "../headers.ts";

/**
 * OpenAPI paths for the credential proxy's call journal: its owner door
 * (`/api/me/connections/{connectionId}/calls`) and its space door (`/api/integrations/calls`).
 */

const connectionCallSchema = {
  type: "object",
  description:
    "One call the credential proxy made with a connection's credential. The journal outlives what " +
    "it describes: every id is a plain value and may name a connection, space, run, key or " +
    "principal that no longer exists.",
  required: [
    "id",
    "createdAt",
    "spaceId",
    "connection_id",
    "integration_package_id",
    "owner_type",
    "owner_id",
    "actor_type",
    "actor_id",
    "apiKeyId",
    "auth_method",
    "runId",
    "method",
    "host",
    "path",
    "outcome",
    "duration_ms",
    "request_id",
  ],
  properties: {
    id: { type: "integer", description: "Monotonic row id; the pagination cursor." },
    createdAt: { type: "string", format: "date-time" },
    spaceId: { type: "string", description: "The space the call was made in." },
    connection_id: { type: "string", format: "uuid" },
    integration_package_id: { type: "string", description: "The integration (`@scope/name`)." },
    owner_type: {
      type: ["string", "null"],
      enum: ["user", "end_user", null],
      description: "The connection's owner when the call was made; null when it was gone by then.",
    },
    owner_id: { type: ["string", "null"] },
    actor_type: {
      type: "string",
      enum: ["user", "end_user"],
      description: "Who acted. Under an API key, the principal acting through it.",
    },
    actor_id: { type: "string" },
    apiKeyId: {
      type: ["string", "null"],
      description: "The API key the actor acted through, if any.",
    },
    auth_method: {
      type: "string",
      description: "How the caller authenticated (`api_key`, an OAuth token kind, …).",
    },
    runId: {
      type: ["string", "null"],
      description: "The run the call declared (`X-Run-Id`), if any.",
    },
    method: { type: "string", description: "The call's HTTP method." },
    host: {
      type: "string",
      description:
        "The target's host as the caller wrote it, before substitution: a `{{field}}` placeholder " +
        "is kept as written, never its value. `<templated>` or `<unparseable>` when the target " +
        "names no readable host.",
    },
    path: {
      type: "string",
      description:
        "The target's path as the caller wrote it, before substitution, without query string or " +
        "fragment. Empty when the target does not parse.",
    },
    outcome: {
      type: "string",
      description:
        "The upstream's HTTP status (`200`, `404`, …), or the proxy's own problem code when the " +
        "proxy answered itself (`unauthorized_target`, `upstream_timeout`, …).",
    },
    duration_ms: { type: "integer", minimum: 0 },
    request_id: { type: ["string", "null"], description: "The call's `Request-Id`." },
  },
} as const;

const filterParameters = [
  {
    name: "actor_id",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "Only the calls this principal made.",
  },
  {
    name: "runId",
    in: "query",
    required: false,
    schema: { type: "string" },
    description: "Only the calls that declared this run.",
  },
  {
    name: "start_date",
    in: "query",
    required: false,
    schema: { type: "string", format: "date-time" },
    description: "Only the calls made at or after this instant (ISO 8601 with an offset).",
  },
  {
    name: "end_date",
    in: "query",
    required: false,
    schema: { type: "string", format: "date-time" },
    description: "Only the calls made at or before this instant (ISO 8601 with an offset).",
  },
  {
    name: "format",
    in: "query",
    required: false,
    schema: { type: "string", enum: ["json", "csv"], default: "json" },
    description:
      "`csv` answers the same rows as `text/csv` (RFC 4180, one header line naming the fields " +
      "below), `limit` then defaulting to its maximum of 10000.",
  },
  {
    name: "limit",
    in: "query",
    required: false,
    schema: { type: "integer", minimum: 1, maximum: 10000, default: 50 },
    description: "Page size: 1 to 200 as JSON (default 50), 1 to 10000 as CSV (default 10000).",
  },
  {
    name: "startingAfter",
    in: "query",
    required: false,
    schema: { type: "string", pattern: "^[1-9][0-9]{0,14}$" },
    description:
      "Cursor: the `id` of the last call of the previous page. Follow the RFC 5988 " +
      '`Link: <…>; rel="next"` response header instead of building it by hand.',
  },
] as const;

const PAGINATION =
  "Newest first, keyset-paginated on `id`: the `Link` header names the next page, in either " +
  "format. An unknown query parameter is a 400, never an ignored filter. In the CSV, a cell of " +
  "`runId`, `method`, `host`, `path`, `outcome` or `request_id` (the text a caller writes) that a " +
  "spreadsheet would read as a formula (leading `=`, `+`, `-`, `@`, tab or carriage return) is " +
  "prefixed with `'`; identifiers are exported as they are. Rate-limited to 60/min.";

const callsPage = {
  description: "A page of calls, newest first.",
  headers: { ...STD_RESPONSE_HEADERS, Link: { $ref: "#/components/headers/Link" } },
  content: {
    "application/json": {
      schema: {
        type: "object",
        required: ["object", "data", "hasMore"],
        properties: {
          object: { type: "string", enum: ["list"] },
          data: { type: "array", items: connectionCallSchema },
          hasMore: { type: "boolean" },
        },
      },
    },
    "text/csv": { schema: { type: "string" } },
  },
} as const;

export const connectionCallsPaths = {
  "/api/me/connections/{connectionId}/calls": {
    get: {
      operationId: "listMyConnectionCalls",
      tags: ["Profile"],
      summary: "The credential proxy's calls made with one of the caller's connections",
      description:
        "Every call the credential proxy (`/api/credential-proxy/proxy`) made with a connection " +
        "the caller owns, whoever made it and from whichever space: a colleague using a " +
        "connection shared into a space, a run, an API key. One row per call that may have sent " +
        "the credential, successful or not. Authorized by ownership, capped by a delegated " +
        "credential's `integrations:read` ceiling. A delegated or end-user credential reads " +
        "inside its bound organization (and space, when it pins one) only. Ownership is read on " +
        "the connection itself: once it is deleted this route answers 404, and its calls remain " +
        "listed by `GET /api/integrations/calls` in the spaces they were made in. " +
        PAGINATION,
      parameters: [
        {
          name: "connectionId",
          in: "path",
          required: true,
          schema: { type: "string", format: "uuid" },
        },
        ...filterParameters,
      ],
      responses: {
        "200": callsPage,
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          $ref: "#/components/responses/Forbidden",
          description: "The credential's scope ceiling lacks `integrations:read`.",
        },
        "404": {
          $ref: "#/components/responses/NotFound",
          description:
            "The id is not a UUID, names no connection (a deleted one included), names one the " +
            "caller does not own, or names one outside a bound credential's organization (and space).",
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/integrations/calls": {
    get: {
      operationId: "listConnectionCalls",
      tags: ["Integrations"],
      summary: "The credential proxy's calls made in the current space",
      description:
        "Every call the credential proxy (`/api/credential-proxy/proxy`) made in the current " +
        "space, whatever the connection and whoever owns it: who used which connection, against " +
        "which host and path, with what outcome. One row per call that may have sent a " +
        "credential, successful or not. Requires `integrations:configure`, the permission that " +
        "governs which credential the space resolves to; it is session-only, so no API key " +
        "reads this journal. Calls made in another space are never listed, including those made " +
        "with a connection shared into both. " +
        PAGINATION,
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XSpaceId" },
        {
          name: "connection_id",
          in: "query",
          required: false,
          schema: { type: "string", format: "uuid" },
          description: "Only the calls made with this connection.",
        },
        ...filterParameters,
      ],
      responses: {
        "200": callsPage,
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
