# OIDC Module

End-User Identity Provider for Appstrate applications. Turns each application into an OAuth 2.1 / OpenID Connect authorization server for its end-users, so satellite apps and partner integrations can authenticate users through Appstrate and receive Bearer JWTs scoped to the application.

## Purpose

When an embedding app (portal, mobile, satellite) needs to delegate end-user authentication to Appstrate, this module provides the server-side of the OAuth 2.1 Authorization Code + PKCE flow. The resulting access token is an ES256-signed JWT carrying `endUserId` and `applicationId` claims, accepted as `Authorization: Bearer ey…` on core routes. Core's strict end-user run-visibility filter applies automatically (the strategy sets `endUser` in context).

## Owned tables

| Table                    | Purpose                                                                     |
| ------------------------ | --------------------------------------------------------------------------- |
| `jwks`                   | Better Auth `jwt` plugin key storage (ES256 keypair, rotated every 90 days) |
| `oauth_client`           | Registered OAuth clients (one per embedding app, scoped via `reference_id`) |
| `oauth_access_token`     | Issued access tokens (Better Auth tracks these for revocation)              |
| `oauth_refresh_token`    | Refresh tokens (24h lifetime)                                               |
| `oauth_consent`          | Per-user consent grants                                                     |
| `oidc_end_user_profiles` | Shadow table linking `end_users.id` ↔ Better Auth `user.id` + status        |

The core `end_users` table is NEVER modified by this module — all OIDC-specific fields (global auth identity link, verification status) live on the shadow table. Core runs filtering continues to strict-filter by `end_users.id` alone.

## Feature flags contributed

```ts
features: {
  oidc: true;
}
```

## App-scoped route prefixes

```ts
appScopedPaths: ["/api/oauth"]; // /api/oauth/clients, /api/oauth/clients/:id, ...
```

## Public paths (auth bypass)

```ts
publicPaths: ["/oauth/enduser/login", "/oauth/enduser/consent"];
```

Better Auth's own `/api/auth/oauth2/*` and `/.well-known/*` endpoints are already public via the core Better Auth handler mount.

## Better Auth plugins contributed

- `jwt()` — ES256 signing, 90-day key rotation, 7-day grace
- `oauthProvider()` — Authorization Code + PKCE, 15-min access tokens, 24h refresh, custom access token claims injecting `endUserId` + `applicationId` via the module's `resolveOrCreateEndUser()` service

Plugins are contributed via `betterAuthPlugins()` and merged at boot in `apps/api/src/lib/boot.ts` via `createAuth()` (Phase 0 extension point).

## Auth strategies contributed

A single strategy matching `Authorization: Bearer ey…` (fast-path rejection on any other prefix, per Phase 0 discipline rule). It verifies the JWT against the local JWKS, joins `end_users` with `oidc_end_user_profiles`, checks the profile status, and emits an `AuthResolution` with `endUser` in context. Core's middleware chain then applies the strict run-visibility filter.

## Enabling OAuth for an application

Admin UI: Settings → Application → End-User Auth tab → Enable. Captures the initial redirect URIs and displays the one-time `clientSecret`. Subsequent operations (rotate secret, disable, update URIs) go through `/api/oauth/clients/:id`.

Headless: `POST /api/oauth/clients` with `{ redirectUris: string[] }` + an admin API key.

## Security notes

- **JWKS rotation**: the `jwt` plugin auto-rotates the ES256 keypair every 90 days with a 7-day grace window. Clients that cache JWKS for longer may see transient verification failures at rotation time.
- **Consent CSRF**: the consent page is protected by Better Auth's CSRF token (one-time, session-bound).
- **`referenceId` → `applicationId` invariant**: every OAuth client row MUST carry a `reference_id` matching an existing `applications.id`. The admin route enforces this on create; the `customAccessTokenClaims` closure enforces it on every token issuance.
- **Admin bypass is not shipped**: Phase 0 made core runs filtering strict with no hook. Embedding apps that want an "admin sees all runs" view authenticate admins via API key (no `endUser` in context), not via an OIDC JWT. See `apps/api/src/modules/README.md#end-user-run-visibility`.
