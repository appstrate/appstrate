// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI component schemas for the OIDC module.
 *
 * Hand-written JSON schema — kept in lockstep with the `OAuthClientRecord`
 * interface in `../services/oauth-admin.ts`. `verify-openapi` will flag
 * any drift between the runtime responses and this shape.
 */

import { ASSIGNABLE_ORG_ROLES } from "@appstrate/shared-types";

const oauthClientObject: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "clientId",
    "name",
    "level",
    "referencedOrgId",
    "referencedSpaceId",
    "redirectUris",
    "postLogoutRedirectUris",
    "scopes",
    "disabled",
    "isFirstParty",
    "allowSignup",
    "signupRole",
    "signupSpaceAssignments",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    clientId: { type: "string" },
    name: { type: ["string", "null"] },
    level: { type: "string", enum: ["instance", "org", "space"] },
    referencedOrgId: { type: ["string", "null"] },
    referencedSpaceId: { type: ["string", "null"] },
    redirectUris: { type: "array", items: { type: "string", format: "uri" } },
    postLogoutRedirectUris: { type: "array", items: { type: "string", format: "uri" } },
    scopes: { type: "array", items: { type: "string" } },
    disabled: { type: "boolean" },
    isFirstParty: { type: "boolean" },
    allowSignup: { type: "boolean" },
    signupRole: { type: "string", enum: [...ASSIGNABLE_ORG_ROLES] },
    signupSpaceAssignments: {
      type: "array",
      items: { $ref: "#/components/schemas/SpaceAssignment" },
    },
    createdAt: { type: ["string", "null"] },
    updatedAt: { type: ["string", "null"] },
  },
};

/**
 * `space_smtp_configs` row as returned by the admin API.
 * Kept in lockstep with `SmtpConfigView` in `@appstrate/shared-types` —
 * the encrypted password column is intentionally omitted (never returned).
 */
const smtpConfigView: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "spaceId",
    "host",
    "port",
    "username",
    "from_address",
    "from_name",
    "secure_mode",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    spaceId: { type: "string" },
    host: { type: "string" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    username: { type: "string" },
    from_address: { type: "string", format: "email" },
    from_name: { type: ["string", "null"] },
    secure_mode: { type: "string", enum: ["auto", "tls", "starttls", "none"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

/**
 * `space_social_providers` row as returned by the admin API.
 * Kept in lockstep with `SocialProviderView` in `@appstrate/shared-types`
 * — the encrypted client secret is intentionally omitted (never returned).
 */
const socialProviderView: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["spaceId", "provider", "client_id", "scopes", "createdAt", "updatedAt"],
  properties: {
    spaceId: { type: "string" },
    provider: { type: "string", enum: ["google", "github"] },
    client_id: { type: "string" },
    scopes: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

const nullableString = { type: ["string", "null"] };
const nullableDate = { type: ["string", "null"], format: "date-time" };

/** One access grant — `AccessGrantDto` in `../services/access-grants.ts`. */
const accessGrant: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "kind",
    "client_name",
    "client_origin",
    "client_registration",
    "device_name",
    "user_agent",
    "last_used_ip",
    "target",
    "session_count",
    "lastUsedAt",
    "createdAt",
  ],
  properties: {
    id: {
      type: "string",
      description: "`crf_…` for a CLI session, `mcg_…` for an MCP client grant.",
    },
    kind: { type: "string", enum: ["cli", "mcp"] },
    client_name: {
      ...nullableString,
      description:
        "The name the client declared when it registered. `null` for a CLI session (the platform's own CLI).",
    },
    client_origin: {
      ...nullableString,
      description:
        "The client's verifiable origin: the host of its metadata document URL (CIMD), or of a non-loopback redirect URI.",
    },
    client_registration: {
      type: ["string", "null"],
      enum: ["metadata_document", "dynamic", "managed", null],
      description:
        "How the client is known: a fetched metadata document (CIMD), a dynamic registration (RFC 7591), or an operator. `null` for a CLI session.",
    },
    device_name: {
      ...nullableString,
      description: "The device name a CLI session was opened with.",
    },
    user_agent: {
      ...nullableString,
      description: "The CLI's user agent. `null` for an MCP grant.",
    },
    last_used_ip: {
      ...nullableString,
      description:
        "Where the grant was last used from (a CLI session that never refreshed: where it signed in).",
    },
    target: {
      description:
        "What the grant reaches. `null` for a CLI session, which acts in every organization of its owner.",
      oneOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["orgId", "org_name", "spaceId", "space_name"],
          properties: {
            orgId: { type: "string" },
            org_name: { type: "string" },
            spaceId: nullableString,
            space_name: nullableString,
          },
        },
      ],
    },
    session_count: {
      type: "integer",
      minimum: 0,
      description: "Live authorizations held under the grant (devices sharing one MCP client).",
    },
    lastUsedAt: nullableDate,
    createdAt: { type: "string", format: "date-time" },
  },
};

const orgAccessGrant: Record<string, unknown> = {
  ...accessGrant,
  required: [...(accessGrant.required as string[]), "user", "revocable"],
  properties: {
    ...(accessGrant.properties as Record<string, unknown>),
    user: {
      type: "object",
      additionalProperties: false,
      required: ["id", "name", "email"],
      properties: { id: { type: "string" }, name: nullableString, email: nullableString },
    },
    revocable: {
      type: "boolean",
      description:
        "`false` for a CLI session of a member who also belongs to another organization: it serves every organization of its owner, so an admin of one cannot end it.",
    },
  },
};

export const oidcSchemas = {
  OAuthClientObject: oauthClientObject,
  OAuthClientWithSecret: {
    ...oauthClientObject,
    required: [...(oauthClientObject.required as string[]), "clientSecret"],
    properties: {
      ...(oauthClientObject.properties as Record<string, unknown>),
      clientSecret: { type: "string" },
    },
  },
  SmtpConfigView: smtpConfigView,
  SocialProviderView: socialProviderView,
  AccessGrant: accessGrant,
  OrgAccessGrant: orgAccessGrant,
};
