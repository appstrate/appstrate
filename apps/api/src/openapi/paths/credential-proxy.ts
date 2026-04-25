// SPDX-License-Identifier: Apache-2.0

/**
 * Credential proxy endpoint (AFPS 1.3 — BYOI for external runners).
 *
 * Wire-compatible with the runtime-pi sidecar `/proxy` contract. Accepts
 * bearer auth: API keys (headless / GitHub Action) or OIDC-issued JWTs
 * (interactive CLI device-flow, dashboard second-party apps). Cookie
 * sessions are rejected.
 */

export const credentialProxyPaths = {
  "/api/credential-proxy/proxy": {
    post: {
      operationId: "credentialProxy",
      tags: ["Credential Proxy"],
      summary: "Proxy a request to a provider with server-side credential injection",
      description:
        "High-value endpoint. Accepts an upstream HTTP request and forwards it to the " +
        "provider after injecting the stored credentials server-side. Credentials never " +
        "leave Appstrate.\n\n" +
        "Authentication: bearer only — either an API key with the `credential-proxy:call` " +
        "scope (NOT granted by default) or an OIDC-issued JWT (device-flow access token " +
        "for the interactive CLI, dashboard access token for second-party apps). Cookie " +
        "sessions are rejected. Session binding pins the `X-Session-Id` to the first " +
        "principal (API key or JWT user) that used it.\n\n" +
        "Optional `Appstrate-User` header scopes the call to an end-user's connection " +
        "profile (API-key auth only).\n\n" +
        "The request method + body are forwarded as-is. URL and headers can contain " +
        "`{{credential_field}}` placeholders substituted against the provider's credential " +
        "schema. Set `X-Substitute-Body: true` to run the same substitution on the body.",
      security: [{ bearerApiKey: [] }, { bearerJwt: [] }],
      parameters: [
        {
          name: "X-App-Id",
          in: "header",
          required: true,
          description: "Application id (app_…) the API key is scoped to.",
          schema: { type: "string" },
        },
        {
          name: "X-Provider",
          in: "header",
          required: true,
          description: "Scoped provider name (e.g. `@afps/gmail`).",
          schema: { type: "string" },
        },
        {
          name: "X-Target",
          in: "header",
          required: true,
          description:
            "Absolute URL of the upstream endpoint. Must match the provider manifest's " +
            "`authorizedUris` unless `allowAllUris: true`.",
          schema: { type: "string", format: "uri" },
        },
        {
          name: "X-Session-Id",
          in: "header",
          required: true,
          description:
            "Caller-chosen session id; scopes the cookie jar. Fresh UUID per CLI invocation " +
            "is typical.",
          schema: { type: "string" },
        },
        {
          name: "X-Substitute-Body",
          in: "header",
          required: false,
          description:
            "When `true`, the request body is decoded as UTF-8 and `{{field}}` placeholders " +
            "are substituted.",
          schema: { type: "string", enum: ["true", "false"] },
        },
        {
          name: "Appstrate-User",
          in: "header",
          required: false,
          description:
            "Impersonation header — scopes the call to this end-user's connection profile.",
          schema: { type: "string", pattern: "^eu_" },
        },
      ],
      responses: {
        "200": {
          description: "Upstream response (status code, headers, body forwarded verbatim).",
          content: { "*/*": {} },
        },
        "400": { $ref: "#/components/responses/ValidationError" },
        "401": { $ref: "#/components/responses/Unauthorized" },
        "403": {
          description:
            "Forbidden — principal lacks `credential-proxy:call`, target not in " +
            "`authorizedUris`, session bound to a different principal, or cookie session used.",
        },
        "404": {
          description: "No credentials or connection profile for the requested provider.",
        },
        "429": { $ref: "#/components/responses/RateLimited" },
      },
    },
  },
} as const;
