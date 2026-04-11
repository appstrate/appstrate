// SPDX-License-Identifier: Apache-2.0

export const oidcSchemas = {
  OAuthClientObject: {
    type: "object",
    description: "OAuth 2.1 client registered against an Appstrate application.",
    required: ["id", "object", "clientId", "applicationId", "redirectUris", "scopes", "disabled"],
    properties: {
      id: { type: "string", description: "Row ID (oac_ prefix)." },
      object: { type: "string", enum: ["oauth_client"] },
      clientId: { type: "string", description: "Public OAuth client identifier." },
      applicationId: { type: "string", description: "Owning Appstrate application (app_ prefix)." },
      name: { type: ["string", "null"] },
      redirectUris: { type: "array", items: { type: "string", format: "uri" } },
      scopes: { type: "array", items: { type: "string" } },
      disabled: { type: "boolean" },
      createdAt: { type: ["string", "null"], format: "date-time" },
      updatedAt: { type: ["string", "null"], format: "date-time" },
    },
  },
  OAuthClientWithSecret: {
    type: "object",
    description: "OAuth client object plus one-time plaintext clientSecret.",
    allOf: [
      { $ref: "#/components/schemas/OAuthClientObject" },
      {
        type: "object",
        required: ["clientSecret"],
        properties: {
          clientSecret: {
            type: "string",
            description: "Plaintext client secret — returned exactly once at create or rotate.",
          },
        },
      },
    ],
  },
};
