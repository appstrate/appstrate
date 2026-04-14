// SPDX-License-Identifier: Apache-2.0

/**
 * OpenAPI component schemas for the OIDC module.
 *
 * Hand-written JSON schema — kept in lockstep with the `OAuthClientRecord`
 * interface in `../services/oauth-admin.ts`. `verify-openapi` will flag
 * any drift between the runtime responses and this shape.
 */

const oauthClientObject: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "id",
    "clientId",
    "name",
    "level",
    "referencedOrgId",
    "referencedApplicationId",
    "redirectUris",
    "postLogoutRedirectUris",
    "scopes",
    "disabled",
    "isFirstParty",
    "allowSignup",
    "signupRole",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    id: { type: "string" },
    clientId: { type: "string" },
    name: { type: ["string", "null"] },
    level: { type: "string", enum: ["instance", "org", "application"] },
    referencedOrgId: { type: ["string", "null"] },
    referencedApplicationId: { type: ["string", "null"] },
    redirectUris: { type: "array", items: { type: "string", format: "uri" } },
    postLogoutRedirectUris: { type: "array", items: { type: "string", format: "uri" } },
    scopes: { type: "array", items: { type: "string" } },
    disabled: { type: "boolean" },
    isFirstParty: { type: "boolean" },
    allowSignup: { type: "boolean" },
    signupRole: { type: "string", enum: ["admin", "member", "viewer"] },
    createdAt: { type: ["string", "null"] },
    updatedAt: { type: ["string", "null"] },
  },
};

/**
 * `application_smtp_configs` row as returned by the admin API.
 * Kept in lockstep with `SmtpConfigView` in `../services/smtp.ts` —
 * the encrypted password column is intentionally omitted (never returned).
 */
const smtpConfigView: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "applicationId",
    "host",
    "port",
    "username",
    "fromAddress",
    "fromName",
    "secureMode",
    "createdAt",
    "updatedAt",
  ],
  properties: {
    applicationId: { type: "string" },
    host: { type: "string" },
    port: { type: "integer", minimum: 1, maximum: 65535 },
    username: { type: "string" },
    fromAddress: { type: "string", format: "email" },
    fromName: { type: ["string", "null"] },
    secureMode: { type: "string", enum: ["auto", "tls", "starttls", "none"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
};

/**
 * `application_social_providers` row as returned by the admin API.
 * Kept in lockstep with `SocialProviderView` in `../services/social.ts`
 * — the encrypted client secret is intentionally omitted (never returned).
 */
const socialProviderView: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["applicationId", "provider", "clientId", "scopes", "createdAt", "updatedAt"],
  properties: {
    applicationId: { type: "string" },
    provider: { type: "string", enum: ["google", "github"] },
    clientId: { type: "string" },
    scopes: {
      type: ["array", "null"],
      items: { type: "string" },
    },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
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
};
