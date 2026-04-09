# ADR-006: End-User Identity Strategy for Satellite Applications

## Status

Proposed (pending decision)

## Context

Appstrate has satellite applications (portal/, workspace-fs/, future apps) that need to authenticate **end-users** — external users who interact with agents, runs, and connections scoped to an Appstrate application. The question is how satellites should authenticate these users and how permissions should be enforced.

Two approaches were evaluated in depth. This document compares them with architecture diagrams, trade-offs, and industry precedent to inform the decision.

---

## Option A: OIDC Identity Provider (PR #66)

Appstrate becomes a full OAuth 2.1 / OIDC Authorization Server. Satellites use "Login with Appstrate" to authenticate end-users. Identity is centralized in Appstrate's Better Auth user table, mapped to per-app `end_users` profiles.

### Architecture

```
                        APPSTRATE (IdP)
                    ┌─────────────────────┐
                    │  Better Auth Users   │
                    │  ┌───────────────┐  │
                    │  │ user table    │  │  ── Global identity
                    │  │ (email, pass) │  │
                    │  └───────┬───────┘  │
                    │          │           │
                    │  ┌───────▼───────┐  │
                    │  │ end_users     │  │  ── Per-app profile
                    │  │ (role, appId) │  │
                    │  └───────────────┘  │
                    │                     │
                    │  OAuth 2.1 Server   │
                    │  ├ /oauth2/authorize │
                    │  ├ /oauth2/token    │
                    │  ├ /oauth2/consent  │
                    │  ├ /.well-known/    │
                    │  └ JWKS (ES256)     │
                    └────────┬────────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
      ┌───────▼──────┐ ┌────▼─────┐ ┌──────▼──────┐
      │   Portal/    │ │Workspace/│ │ Future App  │
      │              │ │          │ │             │
      │ OIDC Client  │ │ OIDC     │ │ OIDC Client │
      │ (pkce flow)  │ │ Client   │ │             │
      └──────────────┘ └──────────┘ └─────────────┘
```

### Login Flow

```
End-User                Portal/              Appstrate (IdP)
   │                       │                       │
   │── Open portal ───────►│                       │
   │                       │── 302 Redirect ──────►│
   │                       │   /oauth2/authorize   │
   │                       │   ?client_id=...      │
   │                       │   &code_challenge=... │
   │◄──────────────────────┼── Login Page ─────────│
   │                       │                       │
   │── Email + Password ──►│                       │
   │                       │                  ┌────┤
   │                       │                  │Auth│
   │                       │                  │ +  │
   │                       │                  │Map │  resolveOrCreateEndUser()
   │                       │                  │ EU │
   │                       │                  └────┤
   │                       │◄─ 302 + auth code ────│
   │                       │                       │
   │                       │── POST /oauth2/token ►│
   │                       │   (code + verifier)   │
   │                       │                       │
   │                       │◄─ JWT access_token ───│
   │                       │   { sub, endUserId,   │
   │                       │     applicationId,    │
   │                       │     role, scope }     │
   │                       │                       │
   │◄── Portal dashboard ──│                       │
   │    (token in memory)  │                       │
   │                       │                       │
   │── Click "Run Agent" ──►── GET /api/runs ─────►│  Bearer ey...
   │                       │                  ┌────┤
   │                       │                  │Verify JWT
   │                       │                  │Check role
   │                       │                  │Scope data
   │                       │                  └────┤
   │◄── Runs list ─────────│◄── 200 [{...}] ──────│
```

### API Call Pattern

```
Portal/ (frontend)                    Appstrate API
       │                                    │
       │── GET /api/agents ────────────────►│
       │   Authorization: Bearer ey...      │
       │                                    │── Verify JWT (ES256, JWKS)
       │                                    │── Extract claims (endUserId, role, appId)
       │                                    │── Enforce permissions from role
       │                                    │── Scope data by endUserId (if not admin)
       │◄── 200 [agents] ──────────────────│
       │                                    │
       │── POST /api/agents/:id/run ───────►│
       │   Authorization: Bearer ey...      │
       │                                    │── Verify JWT
       │                                    │── Check role has "agents:run" permission
       │◄── 200 {run} ────────────────────│
       │                                    │
       │── [Token expired after 15min] ─────│
       │── POST /oauth2/token ─────────────►│
       │   grant_type=refresh_token         │
       │◄── New access_token ──────────────│
```

### What It Adds

| Component       | Detail                                                                          |
| --------------- | ------------------------------------------------------------------------------- |
| DB tables       | +5 (jwks, oauth_client, oauth_access_token, oauth_refresh_token, oauth_consent) |
| Dependencies    | +2 npm packages (@better-auth/oauth-provider, jose)                             |
| Endpoints       | +15 (OAuth2 flow, OIDC discovery, JWKS, admin CRUD, login/consent pages)        |
| Services        | +2 (enduser-mapping.ts, enduser-token.ts)                                       |
| Auth middleware | Extended (JWT Bearer path added to main auth chain)                             |
| Migrations      | +3 (new tables + end_users columns)                                             |
| Email templates | +3 (verification, reset-password, welcome)                                      |

---

## Option B: API Linking with Appstrate-User Header

Satellites manage their own authentication (Better Auth, Clerk, etc.). End-users are linked to Appstrate `end_users` via API at signup. Satellites call Appstrate API using an API key + `Appstrate-User` header for impersonation.

### Architecture

```
      Portal/ (own auth)          Appstrate (agent engine)
   ┌──────────────────────┐    ┌─────────────────────────┐
   │  Better Auth Users   │    │                         │
   │  ┌────────────────┐  │    │  end_users table        │
   │  │ portal_users   │──┼────┼──► eu_xxx (linked via   │
   │  │ (email, pass)  │  │    │    externalId = p_xxx)  │
   │  └────────────────┘  │    │                         │
   │                      │    │  API Key: ask_xxx       │
   │  Session cookies     │    │  (scoped to application)│
   │  (portal-only)       │    │                         │
   └──────────┬───────────┘    └────────────┬────────────┘
              │                             │
              │     API calls with          │
              │     X-Api-Key: ask_xxx      │
              │     Appstrate-User: eu_xxx  │
              └─────────────────────────────┘

      Workspace/ (own auth)
   ┌──────────────────────┐
   │  Own user table ─────┼────► eu_yyy (separate end-user)
   │  Own sessions        │
   └──────────────────────┘
```

### Login Flow

```
End-User                Portal/ (own auth)         Appstrate API
   │                       │                            │
   │── Open portal ───────►│                            │
   │◄── Login page ────────│                            │
   │                       │                            │
   │── Email + Password ──►│                            │
   │                       │── Authenticate locally     │
   │                       │   (Better Auth session)    │
   │                       │                            │
   │   [First login only]  │                            │
   │                       │── POST /api/end-users ────►│  API key auth
   │                       │   { externalId: "p_xxx",   │
   │                       │     email, name }          │
   │                       │◄── 201 { id: "eu_xxx" } ──│
   │                       │                            │
   │                       │── Store eu_xxx in          │
   │                       │   portal user record       │
   │                       │                            │
   │◄── Portal dashboard ──│                            │
   │    (session cookie)   │                            │
   │                       │                            │
   │── Click "Run Agent" ──►── GET /api/runs ──────────►│
   │                       │   X-Api-Key: ask_xxx       │
   │                       │   Appstrate-User: eu_xxx   │
   │                       │                       ┌────┤
   │                       │                       │Verify API key
   │                       │                       │Resolve end-user
   │                       │                       │Check role
   │                       │                       │Scope data
   │                       │                       └────┤
   │◄── Runs list ─────────│◄── 200 [{...}] ───────────│
```

### API Call Pattern

```
Portal/ (backend)                       Appstrate API
       │                                      │
       │── GET /api/agents ──────────────────►│
       │   X-Api-Key: ask_xxx                 │
       │   Appstrate-User: eu_xxx             │
       │                                      │── Verify API key
       │                                      │── Validate eu_xxx belongs to app
       │                                      │── Load end-user role
       │                                      │── Enforce permissions
       │                                      │── Scope data by endUserId
       │◄── 200 [agents] ────────────────────│
       │                                      │
       │── POST /api/agents/:id/run ─────────►│
       │   X-Api-Key: ask_xxx                 │
       │   Appstrate-User: eu_xxx             │
       │                                      │── Check role has "agents:run"
       │◄── 200 {run} ──────────────────────│
       │                                      │
       │   [No token refresh needed]          │
       │   [API key never expires]            │
```

### What It Adds

| Component     | Detail                                             |
| ------------- | -------------------------------------------------- |
| DB tables     | 0 (end_users + role already exist)                 |
| Dependencies  | 0                                                  |
| New endpoints | 0 (Appstrate-User header already implemented)      |
| New services  | 0                                                  |
| Migrations    | +1 (end_users.role column, if not already present) |

---

## Comparative Analysis

### Security

```
                    Option A (OIDC)              Option B (API Linking)
                    ─────────────────            ──────────────────────
Attack surface      15+ new endpoints            0 new endpoints
                    JWT signing keys (DB)        API key (already exists)
                    Login/consent HTML pages     No public HTML pages
                    Token refresh flow           No tokens to refresh
                    PKCE validation              No PKCE needed
                    Key rotation (90d)           No key rotation

SPOF risk           Appstrate down =             Appstrate down =
                    ALL satellite logins dead    Satellite logins OK,
                                                 Appstrate actions fail

Token leak impact   JWT valid 15min,             API key = long-lived,
                    refresh 24h                  but server-side only
                    (client-side exposure)       (never in browser)

Audit trail         JWT claims in token          Appstrate-User header
                    (self-contained)             logged per-request
                                                 (centralized audit)
```

### Developer Experience

```
                    Option A (OIDC)              Option B (API Linking)
                    ─────────────────            ──────────────────────
Satellite setup     Install OIDC client lib      Add 2 headers to API calls
                    Configure redirect URIs      Store API key in env
                    Handle token refresh         Store endUserId mapping
                    Handle token expiry errors

New satellite       Register OAuth client        Create API key
bootstrap           Configure OIDC discovery     Map users at signup
                    Test auth flow E2E           Done

User signup         Redirect to Appstrate        Local signup
                    Consent screen               + POST /api/end-users
                    Back to satellite             Done

User login          Redirect to Appstrate        Local login
                    Back with code               Read cached endUserId
                    Exchange for token            Done
                    Store + refresh token

Session mgmt        Token refresh every 15min    Session cookie (satellite)
                    Handle 401 → refresh flow    Standard, no special logic

Offline/degraded    Appstrate down = no login    Appstrate down = no actions
                    Satellite completely dead     but satellite still works
```

### Permissions Flow

Both options enforce permissions **identically on the Appstrate side**. The difference is how the end-user identity reaches Appstrate:

```
Option A (OIDC):
  Browser ──Bearer ey...──► Appstrate ──► verify JWT ──► extract role ──► enforce

Option B (API Linking):
  Browser ──cookie──► Portal/ ──Appstrate-User: eu_xxx──► Appstrate ──► load role ──► enforce
                              ──X-Api-Key: ask_xxx──►

Permission enforcement:  IDENTICAL
  - end_users.role → permission set (admin/member/viewer)
  - getScopedEndUserId() → data filtering
  - 403 on insufficient permissions
```

### UI Gating (showing/hiding features based on role)

```
Option A: decode JWT client-side → read role claim → gate UI
Option B: GET /api/end-users/:id at login → cache role → gate UI

Both: ~same effort (1 line of code difference)
```

### Scalability & Maintenance

| Dimension            | Option A (OIDC)                                                | Option B (API Linking)                       |
| -------------------- | -------------------------------------------------------------- | -------------------------------------------- |
| New satellite app    | Register OAuth client, configure OIDC                          | Create API key, link users at signup         |
| Cross-app SSO        | Built-in (same IdP session)                                    | Not built-in (separate logins per satellite) |
| 3rd-party app auth   | Supported (standard OIDC)                                      | Not supported (API key is server-to-server)  |
| Better Auth upgrades | Must track oauth-provider plugin compat                        | No dependency on plugin                      |
| Key/token rotation   | JWKS auto-rotation (90d), refresh tokens                       | API key rotation (manual, infrequent)        |
| DB overhead          | 5 extra tables, token rows accumulate                          | 0 extra tables                               |
| Monitoring           | JWT verification errors, token refresh failures, JWKS rotation | API key auth (already monitored)             |

---

## Industry Precedent

| Platform      | Type                       | Approach                        | Result                                              |
| ------------- | -------------------------- | ------------------------------- | --------------------------------------------------- |
| **GitLab**    | Dev platform + satellites  | OIDC IdP                        | Works well — but GitLab has 10+ integrated apps     |
| **Vercel**    | Dev platform + marketplace | OAuth IdP                       | Works well — "Sign in with Vercel" for integrations |
| **Supabase**  | BaaS                       | OAuth 2.1 server (2025)         | Auth IS the product — dogfooding                    |
| **Dify**      | AI agent platform          | API keys + pass-through user ID | Delegated — app manages its own users               |
| **n8n**       | Workflow platform          | OIDC consumer only              | No IdP — single app, no satellites                  |
| **Windmill**  | Workflow platform          | OIDC for machines only          | End-user auth delegated to external (Supabase)      |
| **Botpress**  | Bot platform               | Channel-native IDs              | No IdP — identity from channel                      |
| **Retool**    | Internal tool builder      | Simple user directory           | Not OIDC — proprietary user management              |
| **Discourse** | Forum + satellites         | Custom SSO (DiscourseConnect)   | Works — but custom protocol, not standard OIDC      |

**Key finding**: Platforms that serve as IdP (GitLab, Vercel) have **established ecosystems with many consumers**. AI/agent platforms universally delegate end-user auth.

---

## Decision Matrix

| Criterion                 | Weight | Option A (OIDC)                          | Option B (API Linking)              |
| ------------------------- | ------ | ---------------------------------------- | ----------------------------------- |
| Implementation complexity | High   | -3 (17K+ lines, 5 tables, 15 endpoints)  | +3 (0 new code, already works)      |
| Security surface          | High   | -2 (large new attack surface)            | +3 (minimal, server-to-server)      |
| Resilience (SPOF)         | High   | -2 (login depends on Appstrate)          | +2 (satellite auth independent)     |
| Permission centralization | High   | +3 (role in JWT)                         | +3 (role via API, same enforcement) |
| Cross-app SSO             | Medium | +3 (built-in)                            | -1 (separate logins)                |
| 3rd-party app support     | Low    | +3 (standard OIDC)                       | -2 (server-to-server only)          |
| Maintenance burden        | High   | -2 (oauth-provider plugin, key rotation) | +3 (nothing new to maintain)        |
| Future extensibility      | Medium | +2 (can open to external devs)           | +1 (can add IdP later)              |
| Industry alignment        | Medium | +1 (GitLab/Vercel pattern)               | +2 (Dify/Windmill/Botpress pattern) |
| DX for satellite devs     | Medium | -1 (OIDC client setup, token refresh)    | +2 (2 headers, done)                |

**Weighted scores** (Higher = better):

- **Option A (OIDC IdP)**: -2
- **Option B (API Linking)**: +20

---

## Recommendation

Option B (API Linking) is the pragmatic choice for today's topology (1-2 satellites). It delivers identical permission enforcement with zero new infrastructure.

Option A becomes justified when:

- 3+ satellite apps need cross-app SSO
- Third-party developers need "Login with Appstrate"
- Appstrate explicitly positions as an identity platform

The `end_users.role` + permission model is the correct foundation for **both** options. It should be extracted from PR #66 and merged independently.

If Option A is pursued in the future, it should be implemented as an **Appstrate module** using the module system (`apps/api/src/lib/modules/`). This allows the OIDC IdP to be enabled/disabled via the module registry with zero footprint when disabled — no tables, no routes, no middleware. See `example-module.ts` for the module contract reference.

## See Also

- PR #66: feat: end-user OIDC Identity Provider (Phase 1)
- ADR-005: App-Level Security over PostgreSQL RLS
