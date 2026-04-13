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
};
