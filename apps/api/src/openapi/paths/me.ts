// SPDX-License-Identifier: Apache-2.0

/**
 * User-scoped identity routes (`/api/me/*`).
 *
 * `/api/me/orgs` is the prerequisite to picking an org and setting
 * `X-Org-Id` — every auth method that represents a single user (cookie
 * session, API key, OAuth2 instance/dashboard/end-user JWTs) is accepted,
 * and the route does NOT require `X-Org-Id` itself.
 *
 * `/api/me/models` runs inside org context and returns the catalog the SPA
 * model picker consumes.
 */

export const mePaths = {
  "/api/me/orgs": {
    get: {
      operationId: "listMyOrgs",
      tags: ["Profile"],
      summary: "List orgs the authenticated caller belongs to",
      description:
        "Returns every org the caller can access. Cookie sessions and OIDC dashboard JWTs see " +
        "every org the user is a member of. API keys see only their bound org. OIDC end-user " +
        "JWTs see the single org owning their application's owning org. " +
        "**Does NOT require `X-Org-Id`** — this endpoint is the prerequisite to setting it.",
      responses: {
        "200": {
          description: "Orgs accessible to the caller",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  orgs: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["id", "name", "slug", "role", "createdAt"],
                      properties: {
                        id: { type: "string" },
                        name: { type: "string" },
                        slug: { type: "string" },
                        role: {
                          type: "string",
                          enum: ["owner", "admin", "member", "viewer", "end_user"],
                          description:
                            "Org role for member callers; `end_user` for OIDC end-user JWTs.",
                        },
                        createdAt: { type: "string", format: "date-time" },
                      },
                    },
                  },
                },
              },
              example: {
                orgs: [
                  {
                    id: "org_abc123",
                    name: "Acme Corp",
                    slug: "acme",
                    role: "owner",
                    createdAt: "2026-01-10T08:00:00Z",
                  },
                ],
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
      },
    },
  },
  "/api/me/models": {
    get: {
      operationId: "listMyModels",
      tags: ["Profile"],
      summary: "List models available in the active org",
      description:
        "Returns the model catalog for the active org (built-in + custom). Same shape as " +
        "`GET /api/models`. Org context is set by the `X-Org-Id` header (cookie session) " +
        "or pinned by the strategy (API key, OIDC). Requires `models:read`.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "Model catalog",
          headers: {
            "Request-Id": { $ref: "#/components/headers/RequestId" },
            "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
          },
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  models: {
                    type: "array",
                    items: { $ref: "#/components/schemas/OrgModel" },
                  },
                },
              },
            },
          },
        },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": { $ref: "#/components/responses/Forbidden" },
      },
    },
  },
} as const;
