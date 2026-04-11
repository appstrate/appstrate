# OIDC Module

End-User Identity Provider for Appstrate applications. Turns each application into an OAuth 2.1 / OpenID Connect authorization server for its end-users so satellite apps, mobile clients, and partner integrations can authenticate users through Appstrate and receive Bearer JWTs scoped to the application.

## Purpose

When an embedding app needs to delegate end-user authentication to Appstrate, this module provides the server-side Authorization Code + PKCE flow. The resulting access token is an ES256-signed JWT carrying `sub` (Better Auth user id), `endUserId`, and `applicationId` claims, accepted as `Authorization: Bearer ey…` on core routes. Core's strict end-user run-visibility filter applies automatically (the strategy sets `endUser` in context).

## Phase 1 status

Phase 1 shipped in seven stages. Stages 1–4 and 6–7 are complete; Stage 5 is **partial** — login/consent pages + emails landed, but token-issuance plugin wiring is deferred to Stage 5.5. See the "Deferred to Stage 5.5" section at the bottom.

## Owned tables

| Table                    | Purpose                                                                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `jwks`                   | ES256 keypair storage for the Better Auth `jwt` plugin (90-day rotation, 7-day grace) — **schema ready, plugin not wired yet**             |
| `oauth_client`           | Registered OAuth clients, scoped to an Appstrate `applicationId` via `reference_id`. SHA-256-hashed `client_secret` at rest.               |
| `oauth_access_token`     | Access-token tracking table for the OAuth provider plugin — unused until Stage 5.5                                                         |
| `oauth_refresh_token`    | Refresh-token tracking table — unused until Stage 5.5                                                                                      |
| `oauth_consent`          | Per-user consent grants — unused until Stage 5.5                                                                                           |
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
publicPaths: ["/api/oauth/enduser/login", "/api/oauth/enduser/consent"];
```

The login and consent pages are anonymous — they validate `client_id` against the `oauth_client` registry before rendering. Any unknown or disabled client id returns 404 before the HTML is assembled.

## App-scoped route prefixes

```ts
appScopedPaths: ["/api/oauth"];
```

Client admin routes (`/api/oauth/clients*`) require `X-App-Id`.

## Routes

| Method | Path                                  | Permission             | Purpose                                                       |
| ------ | ------------------------------------- | ---------------------- | ------------------------------------------------------------- |
| POST   | `/api/oauth/clients`                  | `oauth-clients:write`  | Register a new client. Returns plaintext `clientSecret` once. |
| GET    | `/api/oauth/clients`                  | `oauth-clients:read`   | List clients for the current app.                             |
| GET    | `/api/oauth/clients/:clientId`        | `oauth-clients:read`   | Get one client (secret hidden).                               |
| PATCH  | `/api/oauth/clients/:clientId`        | `oauth-clients:write`  | Update `redirectUris` / `disabled`.                           |
| DELETE | `/api/oauth/clients/:clientId`        | `oauth-clients:delete` | Delete a client.                                              |
| POST   | `/api/oauth/clients/:clientId/rotate` | `oauth-clients:write`  | Issue a fresh plaintext secret.                               |
| GET    | `/api/oauth/enduser/login`            | public                 | Server-rendered login form. Validates `client_id`.            |
| POST   | `/api/oauth/enduser/login`            | public                 | **501 — pending Stage 5.5 plugin wiring.**                    |
| GET    | `/api/oauth/enduser/consent`          | public                 | Server-rendered consent form with scope descriptions.         |
| POST   | `/api/oauth/enduser/consent`          | public                 | **501 — pending Stage 5.5 plugin wiring.**                    |

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

Stage 3 ships `betterAuthPlugins()` returning an **empty array**. The strategy is fully wired and unit-tested via a local JWKS server harness — it will verify tokens issued by whatever plugin Stage 5.5 lands without further changes.

## Services

| Service                                                                                                                                       | Purpose                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolveOrCreateEndUser`                                                                                                                      | Three-step link-or-create: already-linked → verified-email adopt → fresh insert + profile row. Throws `UnverifiedEmailConflictError` when an unverified email would silently take over an existing row.                                 |
| `lookupEndUser`                                                                                                                               | LEFT-JOIN read used by the auth strategy to resolve `endUserId` → `{ applicationId, orgId, email, name, status }`.                                                                                                                      |
| `verifyEndUserAccessToken`                                                                                                                    | Pure ES256 JWT verification via `jose` + remote JWKS. Issuer/audience/expiry/signature checks, never throws — returns `null` on any failure.                                                                                            |
| `scopesToPermissions`                                                                                                                         | OAuth scope → core `Permission` set mapper. `openid`/`profile`/`email` drop to empty; `runs`, `runs:write`, `agents`, `agents:write`, `connections`, `connections:write` expand to their read/write/cancel/connect/disconnect siblings. |
| `listClientsForApp` / `getClient` / `createClient` / `deleteClient` / `rotateClientSecret` / `setClientDisabled` / `updateClientRedirectUris` | OAuth client CRUD (direct DB, scoped by `reference_id`). Client secrets generated as 32 random bytes base64url-encoded, hashed SHA-256 at rest.                                                                                         |

## Pages

`pages/html.ts` provides a zero-dependency XSS-safe tagged template. Every dynamic value interpolated into `html\`…\``is escaped unless wrapped in a`RawHtml` instance — making it impossible to inject raw HTML by accident.

`pages/login.ts` and `pages/consent.ts` render the public-facing forms. Login accepts an optional `error` banner + prefilled `email`; consent shows French-localized scope descriptions for known scopes (`openid`, `profile`, `email`, `runs`, `runs:write`, `agents`, `agents:write`, `connections`, `connections:write`) and falls back to the raw scope name (escaped) for anything else.

## Emails

Three module-owned email templates in `emails/`:

- `enduser-welcome.ts` — sent on first successful sign-in (application name in subject)
- `enduser-verification.ts` — email verification link (1h expiry)
- `enduser-reset-password.ts` — password reset link (1h expiry)

Rendered directly by the module — they do **not** go through `@appstrate/emails`'s strictly-typed `EmailType` registry, since adding new keys there would require a core edit. Every dynamic string (name, application name, URL) passes through `escapeHtml` before reaching the HTML body.

## Enabling OAuth for an application

**Admin UI:** Settings → Application → OAuth tab → "New client". Captures the name + redirect URIs; displays `clientId` + `clientSecret` exactly once. Subsequent operations (rotate secret, disable, delete, update URIs) happen through the same tab.

**Headless:** `POST /api/oauth/clients` with `{ name, redirectUris, scopes? }` + an admin API key with `oauth-clients:write`.

## Security notes

- **JWKS rotation**: once Stage 5.5 wires the `jwt` plugin, it auto-rotates the ES256 keypair every 90 days with a 7-day grace window. Clients that cache JWKS for longer may see transient verification failures at rotation time.
- **Client secret hashing**: secrets are stored as 64-char hex SHA-256 hashes; the plaintext is returned exactly once on create and rotate. No "show secret" UI — lose it and rotate.
- **Unverified email guard**: `resolveOrCreateEndUser` throws `UnverifiedEmailConflictError` when an auth identity with an unverified email clashes with an existing `end_users` row in the same application. This prevents silent account takeover via SMTP verification being disabled or an auth provider reporting `emailVerified: false`.
- **`reference_id` → `applicationId` invariant**: every OAuth client row carries a `reference_id` matching an existing `applications.id`. The admin route enforces this on create, and the auth strategy double-checks `endUser.applicationId === claims.applicationId` on every request.
- **Admin bypass is not shipped**: Phase 0 made core runs filtering strict with no hook. Embedding apps that want an "admin sees all runs" view authenticate admins via API key (no `endUser` in context), not via an OIDC JWT. See `apps/api/src/modules/README.md` for the end-user run-visibility contract.

## Deferred to Stage 5.5

Phase 1 consciously defers token issuance wiring to a follow-up stage because the Better Auth plugin landscape is in flux:

- **Plugin package choice**: PR #66 used the separate `@better-auth/oauth-provider` npm package, which is not currently in the lockfile. Better Auth ships a built-in `oidcProvider` plugin, but its `oauthApplication` schema does not match the `oauth_client` shape this module already persists. Stage 5.5 will pick one and reconcile.
- **POST handlers**: `POST /api/oauth/enduser/login` and `POST /api/oauth/enduser/consent` currently return 501 `"Not Implemented"` with a clear pointer to this stage. The integration test asserts the 501 contract so the next PR is forced to update it deliberately.
- **End-to-end PKCE test**: planned in `test/integration/services/oauth-flows.test.ts`, blocked on the plugin wiring.

Everything else ships today:

- Client CRUD + rotate (Stage 4)
- Auth strategy + unit + integration tests (Stage 3)
- Login/consent HTML pages + XSS safety tests (Stage 5)
- Email templates + render tests (Stage 5)
- Admin UI tab + React Query hooks (Stage 6)
