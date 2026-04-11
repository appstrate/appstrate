# OIDC Module

End-User Identity Provider for Appstrate applications. Turns each application into an OAuth 2.1 / OpenID Connect authorization server for its end-users so satellite apps, mobile clients, and partner integrations can authenticate users through Appstrate and receive Bearer JWTs scoped to the application.

## Purpose

When an embedding app needs to delegate end-user authentication to Appstrate, this module provides the server-side Authorization Code + PKCE flow. The resulting access token is an ES256-signed JWT carrying `sub` (Better Auth user id), `endUserId`, and `applicationId` claims, accepted as `Authorization: Bearer ey…` on core routes. Core's strict end-user run-visibility filter applies automatically (the strategy sets `endUser` in context).

## Phase 1 status

Phase 1 is **complete**. All seven stages shipped, including token-issuance plugin wiring via `@better-auth/oauth-provider` (Stage 5.5), CSRF-hardened login + consent POST handlers, discovery alias endpoints, per-application email branding, and the end-to-end Authorization Code + PKCE test suite. The module is now a fully functional OAuth 2.1 / OIDC authorization server for Appstrate applications.

## Owned tables

| Table                    | Purpose                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `jwks`                   | ES256 keypair storage for the Better Auth `jwt` plugin (rotated automatically).                                                            |
| `oauth_client`           | Registered OAuth clients, scoped to an Appstrate `applicationId` via `reference_id`. SHA-256-hashed `client_secret` at rest.               |
| `oauth_access_token`     | Access-token tracking table used by `@better-auth/oauth-provider` at token exchange + introspection time.                                  |
| `oauth_refresh_token`    | Refresh-token tracking table used by `@better-auth/oauth-provider` for `grant_type=refresh_token`.                                         |
| `oauth_consent`          | Per-user consent grants written by `/api/auth/oauth2/consent` on accept.                                                                   |
| `oidc_end_user_profiles` | Shadow table linking `end_users.id` ↔ Better Auth `user.id` + verification status + `active` / `pending_verification` / `suspended` status |

The core `end_users` table is NEVER modified by this module — all OIDC-specific fields live on the shadow table. Core runs filtering continues to strict-filter by `end_users.id` alone.

## Feature flag

```ts
features: {
  oidc: true;
}
```

Frontend reads `useAppConfig().features.oidc` to conditionally show the OAuth tab on the application settings page.

## Public paths (auth bypass)

```ts
publicPaths: [
  "/api/oauth/enduser/login",
  "/api/oauth/enduser/consent",
  "/api/oauth/.well-known/openid-configuration",
  "/api/oauth/.well-known/oauth-authorization-server",
  "/.well-known/openid-configuration",
  "/.well-known/oauth-authorization-server",
];
```

The login and consent pages are anonymous — they validate `client_id` against the `oauth_client` registry before rendering. Any unknown or disabled client id returns 404 before the HTML is assembled. The discovery alias endpoints proxy Better Auth's authoritative `/api/auth/.well-known/*` payloads so OIDC clients can auto-configure from the root of the issuer URL.

## App-scoped route prefixes

```ts
appScopedPaths: ["/api/oauth"];
```

Client admin routes (`/api/oauth/clients*`) require `X-App-Id`.

## Routes

| Method | Path                                          | Permission             | Purpose                                                                                                                                         |
| ------ | --------------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/api/oauth/clients`                          | `oauth-clients:write`  | Register a new client. Returns plaintext `clientSecret` once.                                                                                   |
| GET    | `/api/oauth/clients`                          | `oauth-clients:read`   | List clients for the current app.                                                                                                               |
| GET    | `/api/oauth/clients/:clientId`                | `oauth-clients:read`   | Get one client (secret hidden).                                                                                                                 |
| PATCH  | `/api/oauth/clients/:clientId`                | `oauth-clients:write`  | Update `redirectUris` / `disabled`.                                                                                                             |
| DELETE | `/api/oauth/clients/:clientId`                | `oauth-clients:delete` | Delete a client.                                                                                                                                |
| POST   | `/api/oauth/clients/:clientId/rotate`         | `oauth-clients:write`  | Issue a fresh plaintext secret.                                                                                                                 |
| GET    | `/api/oauth/enduser/login`                    | public                 | Server-rendered login form. Validates `client_id`, loads app branding, issues a one-shot CSRF token paired with an httpOnly `oidc_csrf` cookie. |
| POST   | `/api/oauth/enduser/login`                    | public                 | Verifies CSRF, calls `auth.api.signInEmail`, redirects to `/api/auth/oauth2/authorize` on success (preserving the signed query string).         |
| GET    | `/api/oauth/enduser/consent`                  | public                 | Server-rendered consent form with app branding + scope descriptions + CSRF token.                                                               |
| POST   | `/api/oauth/enduser/consent`                  | public                 | Verifies CSRF, calls `auth.api.oauth2Consent` (accept/deny), forwards the plugin's redirect response.                                           |
| GET    | `/.well-known/openid-configuration`           | public                 | OIDC discovery alias proxying Better Auth's metadata endpoint. Root-level alias for strict OIDC clients.                                        |
| GET    | `/api/oauth/.well-known/openid-configuration` | public                 | Module-prefixed alias for callers that speak the module path layout.                                                                            |

`oauth-clients` is a new core RBAC resource added to `apps/api/src/lib/permissions.ts` in the same PR as Stage 4 (per CLAUDE.md: modules that introduce new RBAC resources must edit `permissions.ts` alongside).

## Auth strategy contributed

A single strategy (`oidc-enduser-jwt`) matching `Authorization: Bearer ey…` (fast-path rejection on any other prefix, per Phase 0 discipline rule). It verifies the JWT against the local JWKS (`APP_URL/api/auth/jwks`), looks up the end-user via `lookupEndUser`, resolves the owning org via `applications.orgId`, fetches the Better Auth user row for name/email, maps OAuth scopes to core RBAC permissions, and emits a full `AuthResolution` with `endUser` in context. Core's strict run-visibility filter then scopes everything to the end-user automatically — no core edit, no RBAC bypass.

Refuses when:

- token `sub` claim is missing
- `endUserId` / `applicationId` custom claims are missing
- the end-user does not exist
- the profile is not `active`
- the claim `applicationId` mismatches the end-user's real `applicationId` (cross-app confusion guard)

## Better Auth plugins contributed

`betterAuthPlugins()` returns `[jwt, oauthProvider]` (both from `better-auth/plugins` and `@better-auth/oauth-provider@^1.6`).

- **`jwt`**: configured with ES256 keypair. Populates the module's `jwks` table and serves `/api/auth/jwks` automatically. Required by `@better-auth/oauth-provider` (it throws `jwt_config` at token mint time otherwise).
- **`oauthProvider`**: OAuth 2.1 authorization server. Wires `/api/auth/oauth2/authorize`, `/token`, `/userinfo`, `/revoke`, `/introspect`, plus `/api/auth/.well-known/openid-configuration`. Reads and writes the module-owned `oauth_client`, `oauth_access_token`, `oauth_refresh_token`, and `oauth_consent` tables through the `drizzleSchemas()` hook on the module manifest (which merges them into the Better Auth Drizzle adapter's model map at boot).

Plugin configuration highlights:

- `loginPage: "/api/oauth/enduser/login"` + `consentPage: "/api/oauth/enduser/consent"` — Better Auth redirects unauthenticated authorize attempts here with a signed query string, and the module's POST handlers orchestrate the rest.
- `scopes` — OIDC identity scopes (`openid`, `profile`, `email`, `offline_access`) concatenated with every entry of `OIDC_ALLOWED_SCOPES` from `apps/api/src/lib/permissions.ts`. The OIDC module uses core `Permission` strings directly as OAuth scope values — there is no translation layer. The scope `agents:run` grants the `agents:run` permission verbatim, and only permissions listed in `OIDC_ALLOWED_SCOPES` can be requested through an OAuth client (admin-only permissions are unreachable through end-user JWTs by design).
- `storeClientSecret` — custom `hash` + `verify` functions matching the module's `oauth-admin` service (SHA-256 hex) so secrets created by the admin API verify correctly at token exchange.
- `customAccessTokenClaims` — on every access token mint (including refresh), calls `resolveOrCreateEndUser()` with the Better Auth user + the client's `referenceId` (= Appstrate `applicationId`), then injects `{ endUserId, applicationId, orgId }` as custom claims. The OIDC auth strategy then picks these up from the Bearer JWT and sets `endUser` context for every subsequent core request. `UnverifiedEmailConflictError` propagates as a token-issuance failure so unverified-email attempts fail loudly instead of silently taking over an existing row.
- `customUserInfoClaims` — surfaces the same `endUserId` + `applicationId` on the `/userinfo` endpoint so satellites can read them without decoding the JWT.

## Services

| Service                                                                                                                                       | Purpose                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveOrCreateEndUser`                                                                                                                      | Three-step link-or-create: already-linked → verified-email adopt → fresh insert + profile row. Throws `UnverifiedEmailConflictError` when an unverified email would silently take over an existing row.                                                                             |
| `lookupEndUser`                                                                                                                               | LEFT-JOIN read used by the auth strategy to resolve `endUserId` → `{ applicationId, orgId, email, name, status }`.                                                                                                                                                                  |
| `verifyEndUserAccessToken`                                                                                                                    | Pure ES256 JWT verification via `jose` + remote JWKS. Issuer/audience/expiry/signature checks, never throws — returns `null` on any failure.                                                                                                                                        |
| `scopesToPermissions`                                                                                                                         | OAuth scope → core `Permission` set filter. Identity scopes (`openid`/`profile`/`email`/`offline_access`) drop silently; values in `OIDC_ALLOWED_SCOPES` (e.g. `agents:run`, `runs:read`, `connections:connect`) pass through verbatim; everything else is dropped with a warn log. |
| `listClientsForApp` / `getClient` / `createClient` / `deleteClient` / `rotateClientSecret` / `setClientDisabled` / `updateClientRedirectUris` | OAuth client CRUD (direct DB, scoped by `reference_id`). Client secrets generated as 32 random bytes base64url-encoded, hashed SHA-256 at rest.                                                                                                                                     |

## Pages

`pages/html.ts` provides a zero-dependency XSS-safe tagged template. Every dynamic value interpolated into `html\`…\``is escaped unless wrapped in a`RawHtml` instance — making it impossible to inject raw HTML by accident.

`pages/login.ts` and `pages/consent.ts` render the public-facing forms. Login accepts an optional `error` banner + prefilled `email`; consent shows French-localized descriptions for the identity scopes (`openid`/`profile`/`email`/`offline_access`) and for every `OIDC_ALLOWED_SCOPES` permission (`agents:read`, `agents:run`, `runs:read`, `runs:cancel`, `connections:read`, `connections:connect`, `connections:disconnect`), and falls back to the raw scope name (escaped) for anything else.

## Emails

Three module-owned email templates in `emails/`:

- `enduser-welcome.ts` — sent on first successful sign-in (application name in subject)
- `enduser-verification.ts` — email verification link (1h expiry)
- `enduser-reset-password.ts` — password reset link (1h expiry)

Rendered directly by the module — they do **not** go through `@appstrate/emails`'s strictly-typed `EmailType` registry, since adding new keys there would require a core edit. Every dynamic string (name, application name, URL) passes through `escapeHtml` before reaching the HTML body.

### Per-application branding

Each template + the login/consent pages accept an optional `branding: ResolvedAppBranding` prop, loaded at request time via `services/branding.ts → resolveAppBranding(applicationId)`. The helper reads `applications.settings.branding` (shape defined by the module-owned `AppBrandingSchema` Zod schema) and falls back to the application's raw `name` field when the setting is missing or malformed. Fields supported:

```ts
{
  name?: string;           // Display name (defaults to applications.name)
  logoUrl?: string;        // Header logo URL (escaped)
  primaryColor?: string;   // Hex #RRGGBB — sanitized, falls back to #4f46e5
  accentColor?: string;    // Hex #RRGGBB — sanitized
  supportEmail?: string;
  fromName?: string;       // Email sender display name
}
```

Malformed hex values are replaced with the platform default so a misconfigured branding JSONB never breaks the render. The shell header, button colors, email subject lines, and `<title>` tags all reflect the resolved branding — an end-user receives an email titled "Bienvenue sur Mon Workspace" instead of "Bienvenue sur Appstrate".

## Enabling OAuth for an application

**Admin UI:** Settings → Application → OAuth tab → "New client". Captures the name + redirect URIs; displays `clientId` + `clientSecret` exactly once. Subsequent operations (rotate secret, disable, delete, update URIs) happen through the same tab.

**Headless:** `POST /api/oauth/clients` with `{ name, redirectUris, scopes? }` + an admin API key with `oauth-clients:write`.

## Security notes

- **JWKS rotation**: once Stage 5.5 wires the `jwt` plugin, it auto-rotates the ES256 keypair every 90 days with a 7-day grace window. Clients that cache JWKS for longer may see transient verification failures at rotation time.
- **Client secret hashing**: secrets are stored as 64-char hex SHA-256 hashes; the plaintext is returned exactly once on create and rotate. No "show secret" UI — lose it and rotate.
- **Unverified email guard**: `resolveOrCreateEndUser` throws `UnverifiedEmailConflictError` when an auth identity with an unverified email clashes with an existing `end_users` row in the same application. This prevents silent account takeover via SMTP verification being disabled or an auth provider reporting `emailVerified: false`.
- **`reference_id` → `applicationId` invariant**: every OAuth client row carries a `reference_id` matching an existing `applications.id`. The admin route enforces this on create, and the auth strategy double-checks `endUser.applicationId === claims.applicationId` on every request.
- **Admin bypass is not shipped**: Phase 0 made core runs filtering strict with no hook. Embedding apps that want an "admin sees all runs" view authenticate admins via API key (no `endUser` in context), not via an OIDC JWT. See `apps/api/src/modules/README.md` for the end-user run-visibility contract.
- **Production guards plugin** (`auth/guards.ts`): a small Better Auth plugin mounted before `@better-auth/oauth-provider` that uses `hooks.before` on `/oauth2/token`, `/oauth2/authorize`, `/oauth2/introspect`, `/oauth2/revoke` to (1) enforce RFC 8707 resource indicators on token requests and (2) rate-limit each endpoint per client IP via the shared `rate-limiter-flexible` Redis backend. Limits: token 30/min, authorize 30/min, introspect 60/min, revoke 60/min. Rejections surface as `better-call` `APIError` → OAuth2-shaped 400/429 bodies.

## Production deployment checklist

Before exposing the module to external satellites:

- **`APP_URL` must match the public issuer**: `validAudiences` is derived from `env.APP_URL` (accepts both `APP_URL` and `APP_URL/api/auth`). Satellites will use one of these as their `resource=` value — a mismatch causes `invalid_request` at token exchange.
- **Rate-limit backend must be Redis** in multi-instance deployments: the guards plugin uses `getRateLimiterFactory()` which falls back to in-memory when `REDIS_URL` is unset. In-memory limits are per-instance and trivially bypassed by round-robin.
- **Audit log shipping**: the consent POST handler emits `logger.info("oidc: consent decision", { audit: true, ... })` on every accept/deny. Route `module=oidc audit=true` log lines to your SIEM / compliance storage for the full decision trail (RGPD proof-of-consent).
- **JWKS rotation**: Better Auth's `jwt` plugin auto-rotates the ES256 keypair every 90 days with a 7-day grace window. Satellites that cache JWKS for longer WILL see transient `invalid_signature` errors. Document a 7-day cache ceiling in your satellite integration guide.
- **`resource` parameter is now enforced**: `/oauth2/token` rejects `authorization_code` / `refresh_token` grants without a whitelisted `resource=` parameter. This is a **compat-break** vs. earlier Stage 5.5 builds which silently issued opaque tokens — satellites that previously "worked" (received opaque tokens) now fail fast with a diagnosable 400. See the satellite integration example below for the correct shape.

## Satellite integration example

A minimal "Login with Appstrate" flow from a satellite app (PKCE + authorization code grant):

```ts
// 1. Generate PKCE verifier + challenge on the satellite backend.
const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
const challenge = base64url(
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))),
);
const state = base64url(crypto.getRandomValues(new Uint8Array(16)));
// Store `verifier` + `state` in a short-lived session cookie.

// 2. Redirect the user to Appstrate's authorize endpoint.
const authorizeUrl =
  `${APPSTRATE_URL}/api/auth/oauth2/authorize?` +
  new URLSearchParams({
    response_type: "code",
    client_id: APPSTRATE_CLIENT_ID,
    redirect_uri: "https://satellite.example.com/callback",
    scope: "openid profile email offline_access runs:read agents:run",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
// res.redirect(authorizeUrl);

// 3. Callback handler exchanges the code for tokens.
//    IMPORTANT: `resource=<APPSTRATE_URL>` is REQUIRED for the plugin
//    to issue a JWT access token (RFC 8707 resource indicator). Without
//    it, `@better-auth/oauth-provider` mints an opaque token that the
//    module's `Bearer ey…` auth strategy cannot match — all scoped
//    requests would 401. The module's `validAudiences` config accepts
//    both `APPSTRATE_URL` and `APPSTRATE_URL/api/auth`.
const body = new URLSearchParams({
  grant_type: "authorization_code",
  code, // from ?code= on the callback URL
  redirect_uri: "https://satellite.example.com/callback",
  client_id: APPSTRATE_CLIENT_ID,
  client_secret: APPSTRATE_CLIENT_SECRET,
  code_verifier: verifier,
  resource: APPSTRATE_URL, // REQUIRED — drives JWT vs opaque issuance
});
const tokenRes = await fetch(`${APPSTRATE_URL}/api/auth/oauth2/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body,
});
const { access_token, refresh_token } = await tokenRes.json();

// 4. Call Appstrate APIs as the end-user.
const runs = await fetch(`${APPSTRATE_URL}/api/runs`, {
  headers: { Authorization: `Bearer ${access_token}` },
}).then((r) => r.json());
// Core's strict end-user visibility filter scopes the result to this user.
```

Discovery is available at `${APPSTRATE_URL}/.well-known/openid-configuration` for clients that auto-configure.
