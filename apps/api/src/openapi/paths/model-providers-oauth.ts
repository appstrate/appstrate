// SPDX-License-Identifier: Apache-2.0

export const modelProvidersOAuthPaths = {
  "/api/model-providers-oauth/import": {
    post: {
      operationId: "importOAuthModelProviderConnection",
      tags: ["Model Provider Credentials"],
      summary: "Import an OAuth model provider token bundle from the CLI",
      description:
        "Persists an OAuth token bundle obtained on the user's machine via `appstrate connect <provider>`. The CLI runs the loopback OAuth dance against the provider's authorization server because the public CLI client_ids only allowlist `http://localhost:PORT/...` redirect_uris. Server-side this re-derives provider claims (Codex JWT account_id) defensively, then persists via the same shared helper the legacy callback used.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/XAppId" },
      ],
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
                  enum: ["codex", "claude-code"],
                },
                label: { type: "string", minLength: 1, maxLength: 120 },
                accessToken: { type: "string", minLength: 1 },
                refreshToken: { type: "string", minLength: 1 },
                expiresAt: {
                  type: ["integer", "null"],
                  description: "Unix milliseconds since epoch — when the access token expires.",
                },
                connectionProfileId: {
                  type: "string",
                  format: "uuid",
                  description:
                    "Optional connection profile to attach the connection to. Defaults to the user's default profile when absent.",
                },
                subscriptionType: {
                  type: "string",
                  maxLength: 40,
                  description:
                    "Claude-only: subscription tier (`pro`, `max`, `team`, `enterprise`).",
                },
                email: {
                  type: "string",
                  format: "email",
                  maxLength: 320,
                  description: "Account email — Codex re-derives from JWT, Claude relies on this.",
                },
                accountId: {
                  type: "string",
                  minLength: 1,
                  maxLength: 64,
                  pattern: "^[A-Za-z0-9_-]+$",
                  description:
                    "Codex-only: pi-ai surfaces the JWT's `chatgpt_account_id` claim as a top-level field. Forwarded here so the platform persists the canonical value rather than re-deriving it.",
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
                required: ["providerKeyId", "connectionId", "providerId", "availableModelIds"],
                properties: {
                  providerKeyId: { type: "string", format: "uuid" },
                  connectionId: { type: "string", format: "uuid" },
                  providerId: { type: "string" },
                  email: { type: "string", format: "email" },
                  subscriptionType: { type: "string" },
                  availableModelIds: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
        "404": { $ref: "#/components/responses/NotFound" },
      },
    },
  },
} as const;
