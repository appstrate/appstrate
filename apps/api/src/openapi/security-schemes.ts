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
      "API key authentication. Use `Authorization: Bearer ask_...` header. The org is resolved from the key — no `X-Org-Id` header needed.",
  },
  bearerExecToken: {
    type: "http" as const,
    scheme: "bearer",
    description: "Run token for container-to-host internal routes.",
  },
} as const;
