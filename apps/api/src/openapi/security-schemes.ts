// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI security scheme definitions.
 */
export const securitySchemes = {
  cookieAuth: {
    type: "apiKey" as const,
    in: "cookie" as const,
    name: "better-auth.session_token",
    description:
      "Cookie session from Better Auth. Requires `X-Org-Id` header for org-scoped routes.",
  },
  bearerApiKey: {
    type: "http" as const,
    scheme: "bearer",
    description:
      "API key authentication. Use `Authorization: Bearer apst_...` header. The org is resolved from the key — no `X-Org-Id` header needed. A key is `apst_` + 30 base62 characters + a 6-character base62 CRC32 of those 30, so a malformed key is refused without a lookup.",
  },
  bearerJwt: {
    type: "http" as const,
    scheme: "bearer",
    bearerFormat: "JWT",
    description:
      "OIDC-issued JWT (device-flow access token for the interactive CLI, or authorization-code access token for dashboard second-party apps). `X-Org-Id` is required for org-scoped routes when the token is instance-level.",
  },
  bearerExecToken: {
    type: "http" as const,
    scheme: "bearer",
    description: "Run token for container-to-host internal routes.",
  },
} as const;
