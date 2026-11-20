// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/** OpenAPI 3.1 contribution of enterprise sign-in (`/api/org-sso`). */

const TAG = "Enterprise sign-in";
const settingsRef = { $ref: "#/components/schemas/SsoSettings" } as const;
const problemRef = { $ref: "#/components/schemas/ProblemDetail" } as const;
const orgHeader = { $ref: "#/components/parameters/XOrgId" } as const;
const domainIdParam = {
  name: "domainId",
  in: "path",
  required: true,
  schema: { type: "string", format: "uuid" },
} as const;

const WRITE_RULE =
  "Requires `org-sso:write` (owners) AND a dashboard session: an API key, an OAuth client, an MCP or CLI token is refused with 403 `dashboard_session_required`, even for an owner.";

function problem(description: string) {
  return { description, content: { "application/problem+json": { schema: problemRef } } };
}

function settings(description: string) {
  return { description, content: { "application/json": { schema: settingsRef } } };
}

const writeErrors = {
  "403": problem("Not an owner, or not a dashboard session (`dashboard_session_required`)"),
};

export function openApiTags() {
  return [
    {
      name: TAG,
      description:
        "An organization binds its Microsoft Entra tenant and proves its email domains; people at those domains then sign in with Microsoft and join the organization. Contributed by `@appstrate/ee`.",
    },
  ];
}

export function openApiComponentSchemas(): Record<string, unknown> {
  return {
    SsoDomain: {
      type: "object",
      required: [
        "id",
        "domain",
        "verified",
        "verified_at",
        "txt_record_name",
        "txt_record_value",
        "createdAt",
      ],
      properties: {
        id: { type: "string", format: "uuid" },
        domain: { type: "string", description: "Lowercase, no subdomain implied." },
        verified: { type: "boolean" },
        verified_at: { type: ["string", "null"], format: "date-time" },
        txt_record_name: {
          type: "string",
          description: "The DNS name to publish the TXT record at: `_appstrate.<domain>`.",
        },
        txt_record_value: {
          type: "string",
          description: "The TXT value: `appstrate-domain-verification=<token>`.",
        },
        createdAt: { type: "string", format: "date-time" },
      },
    },
    SsoSettings: {
      type: "object",
      required: [
        "tenant_id",
        "tenant_linked_at",
        "join_role",
        "enforced",
        "enforced_at",
        "caller_tenant_id",
        "domains",
      ],
      properties: {
        tenant_id: {
          type: ["string", "null"],
          description: "The bound Entra tenant id (`tid`), read off an owner's Microsoft sign-in.",
        },
        tenant_linked_at: { type: ["string", "null"], format: "date-time" },
        join_role: {
          type: "string",
          enum: ["member", "guest"],
          description: "The org role given to a newcomer who joins by signing in with Microsoft.",
        },
        enforced: {
          type: "boolean",
          description:
            "Whether only a Microsoft sign-in from the bound tenant opens a session for an address of a verified domain.",
        },
        enforced_at: { type: ["string", "null"], format: "date-time" },
        caller_tenant_id: {
          type: ["string", "null"],
          description:
            "The tenant of the caller's own session when a Microsoft sign-in opened it, else `null`. Enforcing needs it equal to `tenant_id`.",
        },
        domains: { type: "array", items: { $ref: "#/components/schemas/SsoDomain" } },
      },
    },
  };
}

export function openApiPaths(): Record<string, unknown> {
  return {
    "/api/org-sso": {
      get: {
        operationId: "getOrgSso",
        tags: [TAG],
        summary: "Read the organization's enterprise sign-in settings",
        description: "Requires `org-sso:read` (owners and admins).",
        parameters: [orgHeader],
        responses: {
          "200": settings("The settings"),
          "403": problem("Caller lacks `org-sso:read`"),
        },
      },
      patch: {
        operationId: "updateOrgSso",
        tags: [TAG],
        summary: "Set the role given to people who join by signing in with Microsoft",
        description: `\`member\` or \`guest\`, never a privileged role. ${WRITE_RULE}`,
        parameters: [orgHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["join_role"],
                additionalProperties: false,
                properties: { join_role: { type: "string", enum: ["member", "guest"] } },
              },
            },
          },
        },
        responses: { "200": settings("The settings"), ...writeErrors },
      },
    },
    "/api/org-sso/tenant": {
      post: {
        operationId: "linkOrgSsoTenant",
        tags: [TAG],
        summary: "Bind the tenant of the caller's own Microsoft sign-in",
        description: `The tenant id is never typed: it is the \`tid\` of the Microsoft sign-in that opened the caller's session, less than 15 minutes ago (409 \`microsoft_session_required\` otherwise). Replacing another tenant already bound takes \`replace: true\` (409 \`tenant_already_linked\` otherwise). ${WRITE_RULE}`,
        parameters: [orgHeader],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  replace: {
                    type: "boolean",
                    description: "Replace a different tenant already bound. Absent means false.",
                  },
                },
              },
            },
          },
        },
        responses: {
          "200": settings("The settings"),
          ...writeErrors,
          "409": problem(
            "`microsoft_session_required`, `tenant_already_linked`, or `sso_enforced` when another tenant is bound under enforcement",
          ),
        },
      },
      delete: {
        operationId: "unlinkOrgSsoTenant",
        tags: [TAG],
        summary: "Unbind the tenant",
        description: `409 \`sso_enforced\` while enforcement is on. ${WRITE_RULE}`,
        parameters: [orgHeader],
        responses: {
          "200": settings("The settings"),
          ...writeErrors,
          "409": problem("`sso_enforced`"),
        },
      },
    },
    "/api/org-sso/domains": {
      post: {
        operationId: "addOrgSsoDomain",
        tags: [TAG],
        summary: "Claim an email domain",
        description: `Returns the TXT record to publish before verifying. ${WRITE_RULE}`,
        parameters: [orgHeader],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["domain"],
                additionalProperties: false,
                properties: { domain: { type: "string", minLength: 1, maxLength: 253 } },
              },
            },
          },
        },
        responses: {
          "201": settings("The settings, the new domain included"),
          "400": problem("`invalid_domain`"),
          ...writeErrors,
          "409": problem("`domain_exists`, or `domain_taken` by another organization"),
        },
      },
    },
    "/api/org-sso/domains/{domainId}/verify": {
      post: {
        operationId: "verifyOrgSsoDomain",
        tags: [TAG],
        summary: "Verify a domain by its DNS TXT record",
        description: `Looks up \`_appstrate.<domain>\`. A verified domain belongs to one organization of the instance. ${WRITE_RULE}`,
        parameters: [orgHeader, domainIdParam],
        responses: {
          "200": settings("The settings"),
          ...writeErrors,
          "404": problem("No such domain in this organization"),
          "409": problem("`domain_taken`: another organization verified it first"),
          "422": problem("`domain_not_verified`: the record is absent or carries another value"),
          "502": problem("`dns_lookup_failed`"),
        },
      },
    },
    "/api/org-sso/domains/{domainId}": {
      delete: {
        operationId: "removeOrgSsoDomain",
        tags: [TAG],
        summary: "Remove a domain",
        description: `409 \`sso_enforced\` for a verified domain while enforcement is on. ${WRITE_RULE}`,
        parameters: [orgHeader, domainIdParam],
        responses: {
          "200": settings("The settings"),
          ...writeErrors,
          "404": problem("No such domain in this organization"),
          "409": problem("`sso_enforced`"),
        },
      },
    },
    "/api/org-sso/enforcement": {
      post: {
        operationId: "enforceOrgSso",
        tags: [TAG],
        summary: "Require Microsoft sign-in for the verified domains",
        description: `Only from a session a Microsoft sign-in of the bound tenant opened (409 \`microsoft_session_required\`), so the owner cannot lock themselves out. Ends every other session of the domains' accounts. ${WRITE_RULE}`,
        parameters: [orgHeader],
        responses: {
          "200": settings("The settings"),
          ...writeErrors,
          "409": problem("`sso_not_ready` or `microsoft_session_required`"),
        },
      },
      delete: {
        operationId: "liftOrgSsoEnforcement",
        tags: [TAG],
        summary: "Lift the enforcement",
        description: `Passwords and other sign-in methods work again. ${WRITE_RULE}`,
        parameters: [orgHeader],
        responses: { "200": settings("The settings"), ...writeErrors },
      },
    },
  };
}
