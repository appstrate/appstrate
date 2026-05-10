// SPDX-License-Identifier: Apache-2.0

export const modelProvidersOAuthPaths = {
  "/api/model-providers-oauth/initiate": {
    post: {
      operationId: "initiateOAuthModelProvider",
      tags: ["Model Provider Keys"],
      summary: "Initiate OAuth flow for a model provider",
      description:
        "Starts the OAuth (Authorization Code + PKCE) flow for an OAuth-billed model provider (e.g. Codex via ChatGPT subscription, Claude Code via Anthropic subscription). Returns the authorization URL the browser must be redirected to.",
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
              required: ["providerPackageId", "label"],
              properties: {
                providerPackageId: {
                  type: "string",
                  description:
                    "Whitelisted OAuth model provider package id (e.g. '@appstrate/provider-codex').",
                  enum: ["@appstrate/provider-codex", "@appstrate/provider-claude-code"],
                },
                label: {
                  type: "string",
                  minLength: 1,
                  maxLength: 120,
                  description: "Display label for the resulting orgSystemProviderKeys row.",
                },
              },
            },
            example: {
              providerPackageId: "@appstrate/provider-codex",
              label: "ChatGPT Pro de l'équipe",
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Authorization URL ready to redirect the browser.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["authorizationUrl", "state"],
                properties: {
                  authorizationUrl: { type: "string", format: "uri" },
                  state: { type: "string" },
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
  "/api/model-providers-oauth/callback": {
    get: {
      operationId: "handleOAuthModelProviderCallback",
      tags: ["Model Provider Keys"],
      summary: "OAuth callback for model providers",
      description:
        "Handles the OAuth redirect from the provider. Exchanges the authorization code for tokens (PKCE-only public client — no client_secret), creates the userProviderConnections + orgSystemProviderKeys rows, then 302-redirects the browser to the settings page with the new providerKeyId.",
      parameters: [
        {
          name: "code",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Authorization code returned by the provider on success.",
        },
        {
          name: "state",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "State token previously returned by /initiate.",
        },
        {
          name: "error",
          in: "query",
          required: false,
          schema: { type: "string" },
          description:
            "OAuth error code (e.g. 'access_denied'). When present, redirects to settings with the error surfaced.",
        },
        {
          name: "error_description",
          in: "query",
          required: false,
          schema: { type: "string" },
          description: "Human-readable description of the OAuth error.",
        },
      ],
      responses: {
        "302": {
          description: "Redirect to /settings/models with the new providerKeyId or an error code.",
          headers: {
            Location: {
              description: "Target URL on the Appstrate dashboard.",
              schema: { type: "string", format: "uri" },
            },
          },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
      },
    },
  },
} as const;
