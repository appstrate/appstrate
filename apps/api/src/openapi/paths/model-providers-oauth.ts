// SPDX-License-Identifier: Apache-2.0

export const modelProvidersOAuthPaths = {
  "/api/model-providers-oauth/pairing": {
    post: {
      operationId: "createOAuthModelProviderPairing",
      tags: ["Model Provider Credentials"],
      summary: "Mint a one-shot pairing token for the connect helper",
      description:
        "Creates a single-use pairing token surfaced in the dashboard as a `npx @appstrate/connect-helper <token>` command. The user runs the command on their machine; the helper completes the loopback OAuth dance against the provider's authorization server, then POSTs the resulting credentials back to `/api/model-providers-oauth/import` using this token as Bearer credentials. The plaintext token is returned exactly once — only its SHA-256 hash is persisted. Org-scoped: only `X-Org-Id` is required (no `X-Application-Id` — the resulting credential lives in `model_provider_credentials`, which has no app affinity).",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["providerId"],
              properties: {
                providerId: {
                  type: "string",
                  pattern: "^[a-z0-9-]+$",
                  description:
                    "Canonical provider id. Must resolve to an OAuth provider registered by a loaded module (discoverable via `GET /api/model-provider-credentials/registry`) AND not soft-disabled via `MODEL_PROVIDERS_DISABLED`. Unknown ids → 404. The enum is intentionally open: OAuth providers ship as modules, so the platform spec stays model-agnostic.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Pairing token created. The plaintext is included exactly once.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "token", "command", "expiresAt"],
                properties: {
                  id: {
                    type: "string",
                    pattern: "^pair_[A-Za-z0-9_-]+$",
                    description: "Opaque pairing id, used by GET/DELETE /pairing/:id.",
                  },
                  token: {
                    type: "string",
                    description:
                      "Plaintext pairing token (`appp_<header>.<secret>`). Returned ONCE — never exposed by GET /pairing/:id. Carry as `Authorization: Bearer <token>` on POST /import.",
                  },
                  command: {
                    type: "string",
                    description:
                      "Ready-to-paste shell command (`npx @appstrate/connect-helper@latest <token>`).",
                  },
                  expiresAt: {
                    type: "string",
                    format: "date-time",
                  },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — caller lacks `model-provider-credentials:write`, OR the `providerId` is listed in `MODEL_PROVIDERS_DISABLED`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
  "/api/model-providers-oauth/pairing/{id}": {
    get: {
      operationId: "getOAuthModelProviderPairing",
      tags: ["Model Provider Credentials"],
      summary: "Read pairing status (for dashboard polling)",
      description:
        "Polled by the dashboard while the user runs the helper. Returns `pending` until the helper consumes the token, `consumed` afterwards, `expired` once the TTL elapsed without consumption. The plaintext token is never re-served — only status + timestamps.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^pair_[A-Za-z0-9_-]+$" },
        },
      ],
      responses: {
        "200": {
          description: "Pairing status",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["id", "status", "consumedAt", "expiresAt"],
                properties: {
                  id: { type: "string", pattern: "^pair_[A-Za-z0-9_-]+$" },
                  status: {
                    type: "string",
                    enum: ["pending", "consumed", "expired"],
                  },
                  consumedAt: {
                    type: ["string", "null"],
                    format: "date-time",
                  },
                  expiresAt: { type: "string", format: "date-time" },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
    delete: {
      operationId: "cancelOAuthModelProviderPairing",
      tags: ["Model Provider Credentials"],
      summary: "Cancel a pending pairing",
      description:
        "Idempotent — returns 204 even when the row is already gone (consumed, expired-and-purged, or belongs to another org). Wrong-org cancellations are silent for the same reason GET returns 404 rather than 403.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        {
          name: "id",
          in: "path",
          required: true,
          schema: { type: "string", pattern: "^pair_[A-Za-z0-9_-]+$" },
        },
      ],
      responses: {
        "204": { description: "Pairing cancelled (or no-op if absent)." },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
  "/api/model-providers-oauth/import": {
    post: {
      operationId: "importOAuthModelProviderConnection",
      tags: ["Model Provider Credentials"],
      summary: "Import an OAuth model provider token bundle from the connect helper",
      description:
        "Bearer-only — authenticated by the pairing token previously minted via `POST /api/model-providers-oauth/pairing` (carry as `Authorization: Bearer appp_<token>`). The pairing's `userId` / `orgId` / `providerId` are pinned at mint time and override anything the request body claims, so a tampered helper cannot redirect the import to a different org or provider. Cookie/API-key requests 401. Server-side this re-derives identity slots defensively via the provider's `extractTokenIdentity` hook before persisting into `model_provider_credentials`.",
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["providerId", "label", "accessToken", "refreshToken"],
              properties: {
                providerId: {
                  type: "string",
                  pattern: "^[a-z0-9-]+$",
                  description:
                    "Canonical provider id. Must match the pairing's pinned providerId AND resolve to a registered OAuth provider. Unknown ids → 404; mismatched → 400.",
                },
                label: { type: "string", minLength: 1, maxLength: 120 },
                accessToken: { type: "string", minLength: 1 },
                refreshToken: { type: "string", minLength: 1 },
                expiresAt: {
                  type: ["integer", "null"],
                  description: "Unix milliseconds since epoch — when the access token expires.",
                },
                email: {
                  type: "string",
                  format: "email",
                  maxLength: 320,
                  description:
                    "Account email — either forwarded from the OAuth response body or re-derived server-side by the provider's `extractTokenIdentity` hook.",
                },
                accountId: {
                  type: "string",
                  minLength: 1,
                  maxLength: 120,
                  description:
                    "Abstract account/tenant identifier — the well-known `accountId` slot from the provider's identity surface. When the CLI forwards it, the platform persists this value verbatim; otherwise the provider's `extractTokenIdentity` hook fills it in server-side.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Connection persisted; matching provider key created.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["credentialId", "providerId", "availableModelIds"],
                properties: {
                  credentialId: { type: "string", format: "uuid" },
                  providerId: { type: "string" },
                  email: { type: "string", format: "email" },
                  availableModelIds: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — caller lacks `model-provider-credentials:write`, OR the `providerId` is listed in `MODEL_PROVIDERS_DISABLED`.",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
