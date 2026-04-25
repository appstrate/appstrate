// SPDX-License-Identifier: Apache-2.0

const clientListResponse = {
  type: "object",
  required: ["object", "data"],
  properties: {
    object: { type: "string", enum: ["list"] },
    data: {
      type: "array",
      items: { $ref: "#/components/schemas/OAuthClientObject" },
    },
  },
};

const orgLevelClientRequest = {
  type: "object",
  required: ["level", "name", "redirectUris", "referencedOrgId"],
  properties: {
    level: { type: "string", enum: ["org"] },
    name: { type: "string", minLength: 1, maxLength: 200 },
    redirectUris: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
    },
    postLogoutRedirectUris: {
      type: "array",
      items: { type: "string", format: "uri" },
      description: "URIs allowed for post-logout redirects (OIDC RP-Initiated Logout).",
    },
    scopes: { type: "array", items: { type: "string" } },
    referencedOrgId: { type: "string" },
    isFirstParty: { type: "boolean" },
    allowSignup: {
      type: "boolean",
      description:
        "When `true`, users signing in for the first time through this client are auto-joined to `referencedOrgId` with `signupRole`. When `false` (default), non-members are rejected. Only meaningful for org-level clients.",
    },
    signupRole: {
      type: "string",
      enum: ["admin", "member", "viewer"],
      description:
        "Role assigned on auto-join. `owner` is deliberately excluded to prevent self-promotion via a misconfigured client. Defaults to `member`.",
    },
  },
};

const applicationLevelClientRequest = {
  type: "object",
  required: ["level", "name", "redirectUris", "referencedApplicationId"],
  properties: {
    level: { type: "string", enum: ["application"] },
    name: { type: "string", minLength: 1, maxLength: 200 },
    redirectUris: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
    },
    postLogoutRedirectUris: {
      type: "array",
      items: { type: "string", format: "uri" },
      description: "URIs allowed for post-logout redirects (OIDC RP-Initiated Logout).",
    },
    scopes: { type: "array", items: { type: "string" } },
    referencedApplicationId: { type: "string" },
    isFirstParty: { type: "boolean" },
    allowSignup: {
      type: "boolean",
      description:
        "When `true`, a successful OIDC login creates the `end_users` row on the fly (JIT provisioning). When `false` (default, secure-by-default), unknown end-users are rejected with an OAuth `access_denied` error — admins must pre-create them via `POST /api/end-users` first.",
    },
  },
};

const createClientRequest = {
  oneOf: [orgLevelClientRequest, applicationLevelClientRequest],
  discriminator: { propertyName: "level" },
};

const updateClientRequest = {
  type: "object",
  properties: {
    redirectUris: {
      type: "array",
      minItems: 1,
      items: { type: "string", format: "uri" },
    },
    postLogoutRedirectUris: {
      type: "array",
      items: { type: "string", format: "uri" },
      description: "URIs allowed for post-logout redirects (OIDC RP-Initiated Logout).",
    },
    scopes: {
      type: "array",
      items: { type: "string" },
      description:
        "OAuth scopes granted to this client. Must be a subset of `/api/oauth/scopes`. Existing access tokens retain the scopes they were minted with; updating this field only affects subsequent authorizations.",
    },
    disabled: { type: "boolean" },
    isFirstParty: { type: "boolean" },
    allowSignup: {
      type: "boolean",
      description:
        "Unified signup opt-in. Instance: allows brand-new BA users platform-wide. Org: brand-new BA users + auto-join to the referenced org with `signupRole`. Application: brand-new BA users + JIT `end_users` provisioning.",
    },
    signupRole: {
      type: "string",
      enum: ["admin", "member", "viewer"],
      description:
        "Org-level only. Role assigned on auto-join. `owner` forbidden. Rejected with 400 on instance/application clients.",
    },
  },
};

const commonHeaders = {
  "Request-Id": { $ref: "#/components/headers/RequestId" },
  "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
  RateLimit: { $ref: "#/components/headers/RateLimit" },
  "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
};

export const oidcPaths = {
  "/api/oauth/clients": {
    post: {
      operationId: "createOAuthClient",
      tags: ["OAuth Clients"],
      summary: "Register an OAuth client",
      description:
        "Register a new OAuth 2.1 client. Polymorphic across `org` (org-scoped, dashboard users) and `application` (app-scoped, end-users) levels. The plaintext `clientSecret` is returned exactly once.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { $ref: "#/components/parameters/IdempotencyKey" },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: createClientRequest } },
      },
      responses: {
        "201": {
          description: "OAuth client registered.",
          headers: {
            ...commonHeaders,
            "Idempotent-Replayed": { $ref: "#/components/headers/IdempotentReplayed" },
          },
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthClientWithSecret" },
            },
          },
        },
      },
    },
    get: {
      operationId: "listOAuthClients",
      tags: ["OAuth Clients"],
      summary: "List OAuth clients",
      description:
        "List every OAuth client visible to the current organization — both org-level clients pinned to the org and application-level clients pinned to any application the org owns.",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "List of OAuth clients.",
          headers: commonHeaders,
          content: { "application/json": { schema: clientListResponse } },
        },
      },
    },
  },
  "/api/oauth/clients/{clientId}": {
    get: {
      operationId: "getOAuthClient",
      tags: ["OAuth Clients"],
      summary: "Get OAuth client",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "clientId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "OAuth client detail.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthClientObject" },
            },
          },
        },
        "404": { description: "Client not found." },
      },
    },
    patch: {
      operationId: "updateOAuthClient",
      tags: ["OAuth Clients"],
      summary: "Update OAuth client",
      description:
        "Update the redirect URIs, post-logout redirect URIs, scopes, `disabled` flag, or `isFirstParty` flag. Client type and pinned references are immutable.",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "clientId", in: "path", required: true, schema: { type: "string" } },
      ],
      requestBody: {
        required: true,
        content: { "application/json": { schema: updateClientRequest } },
      },
      responses: {
        "200": {
          description: "Client updated.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthClientObject" },
            },
          },
        },
        "404": { description: "Client not found." },
      },
    },
    delete: {
      operationId: "deleteOAuthClient",
      tags: ["OAuth Clients"],
      summary: "Delete OAuth client",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "clientId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "204": { description: "Client deleted." },
        "404": { description: "Client not found." },
      },
    },
  },
  "/api/oauth/scopes": {
    get: {
      operationId: "listOAuthScopes",
      tags: ["OAuth Clients"],
      summary: "List supported OAuth scopes",
      parameters: [{ $ref: "#/components/parameters/XOrgId" }],
      responses: {
        "200": {
          description: "List of supported OAuth scopes.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["data"],
                properties: {
                  data: { type: "array", items: { type: "string" } },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/oauth/clients/{clientId}/rotate": {
    post: {
      operationId: "rotateOAuthClientSecret",
      tags: ["OAuth Clients"],
      summary: "Rotate client secret",
      parameters: [
        { $ref: "#/components/parameters/XOrgId" },
        { name: "clientId", in: "path", required: true, schema: { type: "string" } },
      ],
      responses: {
        "200": {
          description: "Client secret rotated.",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/OAuthClientWithSecret" },
            },
          },
        },
        "404": { description: "Client not found." },
      },
    },
  },

  // ─── OAuth 2.1 / OIDC protocol endpoints ────────────────────────────────
  // Mounted by the `@better-auth/oauth-provider` + `jwt` plugins contributed
  // via `betterAuthPlugins()`. Documented here (rather than in a generated
  // plugin spec) so external integrators can discover the public surface
  // from `/api/docs` alone.

  "/api/auth/oauth2/authorize": {
    get: {
      operationId: "oauth2Authorize",
      tags: ["OAuth Clients"],
      summary: "OAuth 2.1 authorization endpoint",
      description:
        "Authorization Code + PKCE entry point. Unauthenticated browsers are redirected to `/api/oauth/login` → `/api/oauth/consent` → back here on accept. Returns `302` to the client `redirect_uri` with `code` + `state`.",
      parameters: [
        { name: "client_id", in: "query", required: true, schema: { type: "string" } },
        {
          name: "redirect_uri",
          in: "query",
          required: true,
          schema: { type: "string", format: "uri" },
        },
        {
          name: "response_type",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["code"] },
        },
        { name: "scope", in: "query", required: true, schema: { type: "string" } },
        { name: "state", in: "query", required: false, schema: { type: "string" } },
        { name: "code_challenge", in: "query", required: true, schema: { type: "string" } },
        {
          name: "code_challenge_method",
          in: "query",
          required: true,
          schema: { type: "string", enum: ["S256"] },
        },
        {
          name: "resource",
          in: "query",
          required: false,
          schema: { type: "string", format: "uri" },
          description: "RFC 8707 resource indicator.",
        },
      ],
      responses: {
        "200": {
          description:
            "HTML login/consent page when the browser is unauthenticated or consent is required.",
        },
        "302": {
          description:
            "Redirect to `redirect_uri` with `code`+`state`, or to the login/consent pages.",
        },
      },
    },
  },
  "/api/auth/oauth2/token": {
    post: {
      operationId: "oauth2Token",
      tags: ["OAuth Clients"],
      summary: "OAuth 2.1 token endpoint",
      description:
        "Exchanges an authorization `code` (+ PKCE verifier) for an access + refresh token, or refreshes an existing token. Rate-limited to 30 req/min/IP. RFC 8707 `resource` required.",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["grant_type", "client_id", "resource"],
              properties: {
                grant_type: { type: "string", enum: ["authorization_code", "refresh_token"] },
                client_id: { type: "string" },
                client_secret: { type: "string" },
                code: { type: "string" },
                code_verifier: { type: "string" },
                redirect_uri: { type: "string", format: "uri" },
                refresh_token: { type: "string" },
                resource: { type: "string", format: "uri" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Token response.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["access_token", "token_type", "expires_in"],
                properties: {
                  access_token: {
                    type: "string",
                    description:
                      "ES256-signed JWT carrying `sub`, `endUserId`, `applicationId`, `orgId`.",
                  },
                  token_type: { type: "string", enum: ["Bearer"] },
                  expires_in: { type: "integer" },
                  refresh_token: { type: "string" },
                  id_token: {
                    type: "string",
                    description: "Present when `openid` scope is granted.",
                  },
                  scope: { type: "string" },
                },
              },
            },
          },
        },
        "400": { description: "`invalid_grant`, `invalid_request`, or RFC 8707 mismatch." },
        "429": { description: "Rate limit exceeded." },
      },
    },
  },
  "/api/auth/oauth2/userinfo": {
    get: {
      operationId: "oauth2Userinfo",
      tags: ["OAuth Clients"],
      summary: "OIDC UserInfo endpoint",
      description:
        "Returns claims for the end-user identified by the `Authorization: Bearer ey…` OIDC access token (JWT).",
      responses: {
        "200": { description: "UserInfo claims." },
        "401": { description: "Missing/invalid Bearer token." },
      },
    },
  },
  "/api/auth/oauth2/introspect": {
    post: {
      operationId: "oauth2Introspect",
      tags: ["OAuth Clients"],
      summary: "RFC 7662 token introspection",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["token"],
              properties: { token: { type: "string" }, token_type_hint: { type: "string" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Introspection response.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["active"],
                properties: {
                  active: { type: "boolean" },
                  scope: { type: "string" },
                  client_id: { type: "string" },
                  exp: { type: "integer" },
                  sub: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/auth/oauth2/revoke": {
    post: {
      operationId: "oauth2Revoke",
      tags: ["OAuth Clients"],
      summary: "RFC 7009 token revocation",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["token"],
              properties: { token: { type: "string" }, token_type_hint: { type: "string" } },
            },
          },
        },
      },
      responses: {
        "200": { description: "Revocation succeeded (even on unknown token, per RFC 7009)." },
      },
    },
  },
  "/api/auth/jwks": {
    get: {
      operationId: "oauth2Jwks",
      tags: ["OAuth Clients"],
      summary: "JWKS endpoint",
      description: "Public ES256 signing keys used to verify access tokens. Cacheable.",
      responses: {
        "200": {
          description: "JSON Web Key Set.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { keys: { type: "array", items: { type: "object" } } },
              },
            },
          },
        },
      },
    },
  },

  // ─── OIDC discovery (RFC-compliant, root-mounted) ───────────────────────

  "/.well-known/openid-configuration": {
    get: {
      operationId: "oidcDiscovery",
      tags: ["OAuth Clients"],
      summary: "OpenID Connect discovery document",
      description:
        "RFC-compliant discovery endpoint. Mounted at the HTTP origin root (NOT under `/api`) per OIDC Discovery 1.0 §4.",
      responses: { "200": { description: "OpenID Configuration document." } },
    },
  },
  "/.well-known/oauth-authorization-server": {
    get: {
      operationId: "oauthServerMetadata",
      tags: ["OAuth Clients"],
      summary: "OAuth 2.0 Authorization Server Metadata (RFC 8414)",
      responses: { "200": { description: "Authorization server metadata document." } },
    },
  },

  // ─── Logout ─────────────────────────────────────────────────────────────

  "/api/oauth/logout": {
    get: {
      operationId: "oauthLogout",
      tags: ["OAuth Clients"],
      summary: "Clear session + RP-initiated logout redirect",
      description:
        "Clears the Better Auth session cookie and, if `post_logout_redirect_uri` matches one registered on the client, redirects there. Otherwise redirects to `/`.",
      parameters: [
        { name: "client_id", in: "query", required: false, schema: { type: "string" } },
        {
          name: "post_logout_redirect_uri",
          in: "query",
          required: false,
          schema: { type: "string", format: "uri" },
        },
      ],
      responses: {
        "200": { description: "Not typically returned — logout always redirects." },
        "302": { description: "Redirect to validated URI or `/`." },
      },
    },
  },
  "/api/applications/{id}/smtp-config": {
    get: {
      tags: ["Application Auth Config"],
      operationId: "getApplicationSmtpConfig",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      summary: "Get per-application SMTP configuration",
      description:
        "Returns the SMTP configuration for an application. Password is NEVER returned. Drives email features (verification, magic-link, reset-password) for OAuth clients with `level: application` scoped to this app.",
      security: [{ cookieAuth: [] }, { bearerApiKey: [] }],
      responses: {
        "200": {
          description: "SMTP configuration",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SmtpConfigView" },
            },
          },
        },
        "404": { description: "Application or configuration not found" },
      },
    },
    put: {
      tags: ["Application Auth Config"],
      operationId: "upsertApplicationSmtpConfig",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      summary: "Upsert per-application SMTP configuration",
      description:
        "Creates or replaces the SMTP configuration for an application. The `pass` field is encrypted at rest and never returned in any response.",
      security: [{ cookieAuth: [] }, { bearerApiKey: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["host", "port", "username", "pass", "fromAddress"],
              properties: {
                host: { type: "string", minLength: 1, maxLength: 253 },
                port: { type: "integer", minimum: 1, maximum: 65535 },
                username: { type: "string", minLength: 1, maxLength: 320 },
                pass: { type: "string", writeOnly: true, minLength: 1, maxLength: 1024 },
                fromAddress: { type: "string", format: "email" },
                fromName: {
                  type: "string",
                  maxLength: 200,
                  pattern: '^[^"\\r\\n]*$',
                  description:
                    "Rejects quotes and CRLF to prevent email-header injection at send time.",
                },
                secureMode: { type: "string", enum: ["auto", "tls", "starttls", "none"] },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "SMTP configuration saved",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SmtpConfigView" },
            },
          },
        },
        "400": { description: "Validation error (invalid host / SSRF block)" },
        "404": { description: "Application or configuration not found" },
      },
    },
    delete: {
      tags: ["Application Auth Config"],
      operationId: "deleteApplicationSmtpConfig",
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      summary: "Delete per-application SMTP configuration",
      security: [{ cookieAuth: [] }, { bearerApiKey: [] }],
      responses: {
        "204": { description: "Deleted" },
        "404": { description: "Application or configuration not found" },
      },
    },
  },
  "/api/applications/{id}/smtp-config/test": {
    post: {
      tags: ["Application Auth Config"],
      operationId: "testApplicationSmtpConfig",
      summary: "Send a test email using the stored per-app SMTP configuration",
      description:
        "Rate-limited. Uses the persisted config — upsert first, then test. SMTP server errors are surfaced verbatim so DKIM/SPF/auth issues reach the operator.",
      security: [{ cookieAuth: [] }, { bearerApiKey: [] }],
      parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["to"],
              properties: { to: { type: "string", format: "email" } },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Test email sent",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  ok: { type: "boolean" },
                  messageId: { type: "string" },
                  error: { type: "string" },
                },
              },
            },
          },
        },
        "404": { description: "Application or configuration not found" },
      },
    },
  },
  "/api/applications/{id}/social-providers/{provider}": {
    get: {
      tags: ["Application Auth Config"],
      operationId: "getApplicationSocialProvider",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "provider",
          in: "path",
          required: true,
          schema: { type: "string", enum: ["google", "github"] },
        },
      ],
      summary: "Get per-application social auth provider configuration",
      description:
        "Returns the stored OAuth App credentials for a given provider on this application. The client secret is NEVER returned. When absent, the provider's button is hidden on the tenant's login/register pages for `level: application` OAuth clients — no fallback to the instance env OAuth App.",
      security: [{ cookieAuth: [] }, { bearerApiKey: [] }],
      responses: {
        "200": {
          description: "Social provider configuration",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SocialProviderView" },
            },
          },
        },
        "404": { description: "Application or configuration not found" },
      },
    },
    put: {
      tags: ["Application Auth Config"],
      operationId: "upsertApplicationSocialProvider",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "provider",
          in: "path",
          required: true,
          schema: { type: "string", enum: ["google", "github"] },
        },
      ],
      summary: "Upsert per-application social auth provider configuration",
      description:
        "Creates or replaces the OAuth App credentials for a given provider on this application. The `clientSecret` field is encrypted at rest and never returned in any response.",
      security: [{ cookieAuth: [] }, { bearerApiKey: [] }],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: {
              type: "object",
              required: ["clientId", "clientSecret"],
              properties: {
                clientId: { type: "string", minLength: 1, maxLength: 512 },
                clientSecret: {
                  type: "string",
                  writeOnly: true,
                  minLength: 1,
                  maxLength: 2048,
                },
                scopes: {
                  type: "array",
                  items: { type: "string", minLength: 1, maxLength: 128 },
                  maxItems: 32,
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Social provider configuration saved",
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/SocialProviderView" },
            },
          },
        },
        "400": { description: "Validation error" },
        "404": { description: "Application or configuration not found" },
      },
    },
    delete: {
      tags: ["Application Auth Config"],
      operationId: "deleteApplicationSocialProvider",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string" } },
        {
          name: "provider",
          in: "path",
          required: true,
          schema: { type: "string", enum: ["google", "github"] },
        },
      ],
      summary: "Delete per-application social auth provider configuration",
      security: [{ cookieAuth: [] }, { bearerApiKey: [] }],
      responses: {
        "204": { description: "Deleted" },
        "404": { description: "Application or configuration not found" },
      },
    },
  },
  "/api/auth/device/code": {
    post: {
      tags: ["Device Authorization"],
      operationId: "deviceAuthorizationCode",
      summary: "Request a device + user code (RFC 8628 §3.2)",
      description:
        "Initiates a device-authorization grant. The CLI calls this first and receives a short `user_code` to display plus an opaque `device_code` to poll `/api/auth/device/token` with. Accepts both `application/x-www-form-urlencoded` (RFC 8628 §3.2, preferred) and `application/json` — the server normalizes form-urlencoded bodies to JSON before Better Auth's `deviceAuthorization()` plugin sees them. Clients are gated by `validateClient` — only OAuth clients registered with the device-code grant are accepted.",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["client_id"],
              properties: {
                client_id: { type: "string", description: "Public client identifier." },
                scope: {
                  type: "string",
                  description: "Space-separated scopes. Defaults to the client's registered set.",
                },
              },
            },
          },
          "application/json": {
            schema: {
              type: "object",
              required: ["client_id"],
              properties: {
                client_id: { type: "string", description: "Public client identifier." },
                scope: {
                  type: "string",
                  description: "Space-separated scopes. Defaults to the client's registered set.",
                },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "Device + user codes issued.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: [
                  "device_code",
                  "user_code",
                  "verification_uri",
                  "verification_uri_complete",
                  "expires_in",
                  "interval",
                ],
                properties: {
                  device_code: { type: "string" },
                  user_code: { type: "string" },
                  verification_uri: { type: "string", format: "uri" },
                  verification_uri_complete: { type: "string", format: "uri" },
                  expires_in: { type: "integer" },
                  interval: { type: "integer" },
                },
              },
            },
          },
        },
        "400": {
          description: "Invalid client or request.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: { type: "string", enum: ["invalid_client", "invalid_request"] },
                  error_description: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/api/auth/device/token": {
    post: {
      tags: ["Device Authorization"],
      operationId: "deviceAuthorizationToken",
      summary: "Exchange approved device_code for an access token (RFC 8628 §3.4)",
      description:
        "Polled by the CLI until the user approves or the code expires. On success, returns a BA session token as `access_token`. The token is opaque (not a JWT) and must be sent back as `Authorization: Bearer <token>` on subsequent requests. Accepts both `application/x-www-form-urlencoded` (RFC 8628 §3.4, preferred) and `application/json` — the server normalizes form-urlencoded bodies to JSON before Better Auth's `deviceAuthorization()` plugin sees them.",
      requestBody: {
        required: true,
        content: {
          "application/x-www-form-urlencoded": {
            schema: {
              type: "object",
              required: ["grant_type", "device_code", "client_id"],
              properties: {
                grant_type: {
                  type: "string",
                  enum: ["urn:ietf:params:oauth:grant-type:device_code"],
                },
                device_code: { type: "string" },
                client_id: { type: "string" },
              },
            },
          },
          "application/json": {
            schema: {
              type: "object",
              required: ["grant_type", "device_code", "client_id"],
              properties: {
                grant_type: {
                  type: "string",
                  enum: ["urn:ietf:params:oauth:grant-type:device_code"],
                },
                device_code: { type: "string" },
                client_id: { type: "string" },
              },
            },
          },
        },
      },
      responses: {
        "200": {
          description: "User approved — access token issued.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["access_token", "token_type", "expires_in"],
                properties: {
                  access_token: { type: "string" },
                  token_type: { type: "string", enum: ["Bearer"] },
                  expires_in: { type: "integer" },
                  scope: { type: "string" },
                },
              },
            },
          },
        },
        "400": {
          description: "Authorization pending, slow down, or terminal error.",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  error: {
                    type: "string",
                    enum: [
                      "authorization_pending",
                      "slow_down",
                      "expired_token",
                      "access_denied",
                      "invalid_request",
                      "invalid_grant",
                    ],
                  },
                  error_description: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
  "/activate": {
    get: {
      tags: ["Device Authorization"],
      operationId: "deviceActivateGet",
      summary: "User-facing verification page",
      description:
        "Server-rendered HTML page where the user types the short `user_code` shown by the CLI. When called with `?user_code=...` and a valid session, resolves to a consent panel; otherwise shows the entry form or redirects to `/auth/login` with a `returnTo` that preserves the code.",
      parameters: [
        {
          name: "user_code",
          in: "query",
          required: false,
          schema: {
            type: "string",
            // Mirrors the HTML form `pattern` in `pages/activate.ts` +
            // the generator's alphabet in `auth/plugins.ts::USER_CODE_ALPHABET`
            // (GitHub-style: no vowels, no visually-ambiguous pairs, no
            // digits). The server accepts either casing (it uppercases
            // before lookup) and the optional `-` inside `XXXX-XXXX` is
            // stripped. 8 or 9 chars lets us accept the dash-separated
            // display form AND the raw form in the same schema.
            pattern: "^[BCDFGHJKLMNPQRSTVWXZbcdfghjklmnpqrstvwxz-]{8,9}$",
          },
        },
      ],
      responses: {
        "200": { description: "HTML page rendered." },
        "302": { description: "Redirect to `/auth/login` when unauthenticated." },
        "400": { description: "Invalid code format." },
        "404": { description: "Code not found or already used." },
      },
    },
    post: {
      tags: ["Device Authorization"],
      operationId: "deviceActivateSubmit",
      summary: "Normalize a submitted user_code and redirect to the consent panel",
      responses: {
        "303": { description: "Redirect to `GET /activate?user_code=...`." },
        "400": { description: "Empty user_code." },
        "403": { description: "CSRF check failed." },
      },
    },
  },
  "/activate/approve": {
    post: {
      tags: ["Device Authorization"],
      operationId: "deviceActivateApprove",
      summary: "Approve a pending device authorization",
      description:
        "Delegates to Better Auth's `/api/auth/device/approve`. The realm/level guard registered by `oidcGuardsPlugin` enforces that the approving user's realm matches the target client's level — a cross-audience approval is rejected with 403.",
      responses: {
        "200": { description: "Approved — renders the success page." },
        "400": { description: "Approval failed (expired, already processed, realm mismatch)." },
        "403": { description: "CSRF check failed." },
      },
    },
  },
  "/activate/deny": {
    post: {
      tags: ["Device Authorization"],
      operationId: "deviceActivateDeny",
      summary: "Deny a pending device authorization",
      responses: {
        "200": { description: "Denied — renders the refusal page." },
        "403": { description: "CSRF check failed." },
      },
    },
  },

  // ── Phase 3 admin oversight (#251) ────────────────────────────────────────

  "/api/orgs/{orgId}/cli-sessions": {
    get: {
      tags: ["Device Authorization"],
      operationId: "listOrgCliSessions",
      summary: "List CLI sessions for org members (admin)",
      description:
        "Admin oversight of every active CLI session belonging to a member of `orgId`. Returns the same per-device shape as the personal `/api/auth/cli/sessions` endpoint, plus the owning member's id/email/name. Visibility scoped to the org's CURRENT roster — a member who left no longer surfaces here. Owner/admin only.",
      parameters: [
        {
          name: "orgId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "200": {
          description: "Active org CLI sessions",
          headers: commonHeaders,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["sessions"],
                properties: {
                  sessions: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        familyId: { type: "string" },
                        userId: { type: "string" },
                        userEmail: { type: ["string", "null"] },
                        userName: { type: ["string", "null"] },
                        deviceName: { type: ["string", "null"] },
                        userAgent: { type: ["string", "null"] },
                        createdIp: { type: ["string", "null"] },
                        lastUsedIp: { type: ["string", "null"] },
                        lastUsedAt: {
                          type: ["string", "null"],
                          format: "date-time",
                        },
                        createdAt: { type: "string", format: "date-time" },
                        expiresAt: { type: "string", format: "date-time" },
                        current: { type: "boolean" },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        "401": { description: "Authentication required." },
        "403": { description: "Caller is not an admin/owner of the org." },
      },
    },
  },

  "/api/orgs/{orgId}/cli-sessions/{familyId}": {
    delete: {
      tags: ["Device Authorization"],
      operationId: "revokeOrgCliSession",
      summary: "Revoke a member's CLI session (admin)",
      description:
        "Force a member's CLI session out from the dashboard. Logged with `revoked_reason='org_admin_revoked'` so the audit trail distinguishes admin force-outs from user-initiated logouts and reuse-detection revocations. Returns 404 when the family is unknown, doesn't belong to a current member of `orgId`, or has already been revoked — the route layer collapses these cases so an admin cannot probe membership outside the org through this endpoint.",
      parameters: [
        {
          name: "orgId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
        {
          name: "familyId",
          in: "path",
          required: true,
          schema: { type: "string" },
        },
      ],
      responses: {
        "204": { description: "Revoked." },
        "401": { description: "Authentication required." },
        "403": { description: "Caller is not an admin/owner of the org." },
        "404": { description: "Session not found / not in this org / already revoked." },
      },
    },
  },
};
