// SPDX-License-Identifier: Apache-2.0

/**
 * Reusable OpenAPI parameter definitions.
 */
export const parameters = {
  Offset: {
    name: "offset",
    in: "query" as const,
    required: false,
    description: "Number of items to skip before the first returned item.",
    schema: { type: "integer", minimum: 0, default: 0 },
  },
  XOrgId: {
    name: "X-Org-Id",
    in: "header" as const,
    description:
      "Organization ID. Required for cookie auth. Not needed for API key auth (org resolved from key).",
    schema: { type: "string", format: "uuid" },
  },
  SseOrgId: {
    name: "orgId",
    in: "query" as const,
    required: true,
    description:
      "Organization ID. Required for SSE auth (cookies cannot carry X-Org-Id header on EventSource).",
    schema: { type: "string", format: "uuid" },
  },
  Verbose: {
    name: "verbose",
    in: "query" as const,
    required: false,
    description:
      "When true, include full payload with `result` and `data` fields. Default (false) strips large user-content fields for safer consumption by external agents.",
    schema: { type: "boolean", default: false },
  },
  SseChannels: {
    name: "channels",
    in: "query" as const,
    required: false,
    description:
      "Comma-separated list of SSE channels to subscribe to (`run_update`, `run_log`, `run_metric`, `connection_update`, `chat_session_update`). " +
      "Omit to receive every channel (default, unchanged behaviour). Unknown names are ignored; if nothing is recognised the stream falls back to every channel. " +
      "Declaring only the channels you consume avoids fanning the `run_log` firehose out to a stream that discards it.",
    schema: { type: "string", example: "run_update,connection_update" },
  },
  AppstrateUser: {
    name: "Appstrate-User",
    in: "header" as const,
    required: false,
    description:
      "End-user ID (eu_ prefix) to execute the request on behalf of. API key auth only — rejected with 400 on cookie auth.",
    schema: { type: "string" },
  },
  AppstrateVersion: {
    name: "Appstrate-Version",
    in: "header" as const,
    required: false,
    description:
      "API version override (format: YYYY-MM-DD). Defaults to the org's pinned version or the current platform version.",
    schema: { type: "string" },
  },
  IdempotencyKey: {
    name: "Idempotency-Key",
    in: "header" as const,
    required: false,
    description:
      "Unique key for idempotent requests (max 255 chars). Prevents duplicate resource creation on retries. Cached for 24 hours, " +
      "scoped to the organization and space: a repeat with the same body replays the original response with " +
      "`Idempotent-Replayed: true`, the same key with a different body is `422 idempotency_conflict`, and a concurrent duplicate " +
      "is `409 idempotency_in_progress`. This operation honours the header because it declares this parameter — operations that " +
      "do not declare it refuse the header with `400 idempotency_not_supported` rather than silently ignoring it (see the " +
      "“Idempotency” section of the API description).",
    schema: { type: "string", maxLength: 255 },
  },
  ConnectOffers: {
    name: "x-appstrate-connect-offers",
    in: "header" as const,
    required: false,
    description:
      "Opt-in: when set to `1` and the actor holds `integrations:connect`, each actor-actionable " +
      "item of a 412 `missing_integration_connection` also carries a ready-to-open `connect_url` " +
      "(a single-use bearer link that connects AS the actor). Set only by clients that render the " +
      "connect card or hand the link to that human.",
    schema: { type: "string", enum: ["1"] },
  },
  SseSpaceId: {
    name: "spaceId",
    in: "query" as const,
    required: false,
    description:
      "Space ID. Required for cookie auth (SSE cannot send X-Space-Id header). Not needed for API key auth (space resolved from key).",
    schema: { type: "string" },
  },
  SseViewAs: {
    name: "view_as",
    in: "query" as const,
    required: false,
    description:
      "Role preview for this stream — the same value, grammar and refusals as the `X-View-As` " +
      "header (see that parameter). It is a query parameter here because `EventSource` cannot " +
      "send headers — presenting it as the `X-View-As` header on these routes is " +
      "`400 invalid_view_as`. Sessions only: with `?token=ask_…` it is " +
      "`400 view_as_unsupported`. A stream opened under a persona sees what that role would see " +
      "and stops where that role would stop (`403 not_a_space_member`, or `404` for a private " +
      "space), and carries `X-View-As-Active: 1`.",
    schema: { type: "string", example: "org_role=member; space=spc_…; role=preset:viewer" },
  },
  SseToken: {
    name: "token",
    in: "query" as const,
    required: false,
    description:
      "API key (ask_ prefix) for SSE authentication. EventSource cannot send Authorization headers, so API key auth uses this query parameter instead.",
    schema: { type: "string" },
  },
  XViewAs: {
    name: "X-View-As",
    in: "header" as const,
    required: false,
    description:
      'Preview the API as a lesser role ("view as"). One value, `;`-separated `key=value` pairs; ' +
      "whitespace around the separators is tolerated and nothing else is:\n\n" +
      "- `org_role` (required) — `member` or `guest`. Previewing `owner`/`admin` is refused.\n" +
      "- `space` (optional) — a `spc_` space id. Must be paired with `role`.\n" +
      "- `role` (optional) — `preset:<admin|builder|operator|viewer>` or `custom:<srl_ id>`. " +
      "Must be paired with `space`.\n\n" +
      "Example: `org_role=member; space=spc_…; role=preset:viewer`.\n\n" +
      "The persona is enforced server-side: `permissions`, the space role and every listing are " +
      "the persona's, and a write the persona cannot make is refused exactly as it would be for a " +
      "real holder of that role. The authenticated identity and the audit actor stay the real " +
      "caller; audit rows carry the persona under `after.view_as`.\n\n" +
      "Refusals — never a silent fall-back to the caller's real permissions: `400 invalid_view_as` " +
      "(header does not parse), `400 view_as_unsupported` (the credential is not one that can " +
      "carry a persona — only a cookie session and the CLI/instance token, which authenticate the " +
      "user themselves, can), `403 view_as_forbidden` " +
      "(the real org role is not owner/admin, or the role is not one the caller could grant in " +
      "that space, or previewing a custom role where the `custom_roles` feature is off), " +
      "`404 view_as_not_found` (the space is not in the org, the custom role does not exist, or " +
      "the organization named alongside the persona is not one the caller belongs to). A 404 " +
      "carrying `view_as_not_found` means the PREVIEW died and must be dropped; a plain " +
      "`404 not_found` under an active persona is the previewed role's own wall and leaves the " +
      "preview standing.\n\n" +
      "On `GET /api/orgs` and `GET /api/me/orgs` — the two listings exempt from `X-Org-Id` — the " +
      "`X-Org-Id` header names the organization the persona applies to; every other row in those " +
      "listings stays the caller's real role. Sending the persona without it is `400 " +
      "invalid_view_as`, and naming an organization the caller is not a member of is " +
      "`404 view_as_not_found`: a " +
      "listing that answered with real permissions while the client believed it was previewing " +
      "would be the failure this feature exists to prevent.\n\n" +
      "The Server-Sent-Events routes (`/api/realtime/*`) take the same value as the `view_as` " +
      "QUERY parameter instead: `EventSource` cannot send headers.\n\n" +
      "Every response produced under a validated persona carries `X-View-As-Active: 1`.",
    schema: { type: "string", example: "org_role=member; space=spc_…; role=preset:viewer" },
  },
  XSpaceId: {
    name: "X-Space-Id",
    in: "header" as const,
    description:
      "Space ID. Required for space-scoped routes (agents, runs, schedules, and space-scoped module routes). Not needed for API key auth (space resolved from key).",
    schema: { type: "string" },
  },
  PackageScope: {
    name: "scope",
    in: "path" as const,
    required: true,
    description: "Package scope (e.g. @myorg)",
    schema: { type: "string", pattern: "^@[a-z0-9][a-z0-9-]*$" },
  },
  PackageName: {
    name: "name",
    in: "path" as const,
    required: true,
    description: "Package name",
    schema: { type: "string" },
  },
  PackageActiveFilter: {
    name: "active",
    in: "query" as const,
    required: false,
    description:
      "When `true`, narrows the list to packages installed and enabled in the current " +
      "space — system packages with no install row drop out. Integrations are the one " +
      "exception: they are filtered on effective activation, so an environment-provided " +
      "system integration stays listed even though it has no install row.",
    schema: { type: "string", enum: ["true"] as const },
  },
} as const;
