# End-User OIDC Identity Provider — Implementation Roadmap

> Appstrate as an Identity Provider for end-users. Satellites do "Login with Appstrate" instead of managing their own auth.

**Spec**: `docs/architecture/END_USER_IDENTITY_SPEC.md` (workspace `docs/`)
**Branch**: `feat/enduser-oidc-identity` — PR #66
**Approach**: Single Better Auth instance + `@better-auth/oauth-provider` plugin. Global auth identity (`user` table) → per-application end-user profiles (`end_users` table).

---

## Phase 1 — OIDC Provider Infrastructure ✅

**Status**: Merged (PR #66)

### What was done

| Area             | Changes                                                                                                                                |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **Dependencies** | drizzle-orm 0.39→0.41, better-auth →1.5.6, `@better-auth/oauth-provider`, `jose`                                                       |
| **Schema**       | `end_users` +authUserId/status/emailVerified. 5 new tables: jwks, oauth_client, oauth_access_token, oauth_refresh_token, oauth_consent |
| **Auth config**  | jwt plugin (ES256, 90-day rotation) + oauthProvider plugin (PKCE, 15min access, 24h refresh)                                           |
| **Services**     | `enduser-mapping.ts` (resolve/create per-app end-user), `enduser-token.ts` (JWT verify + scope mapping)                                |
| **Routes**       | `/oauth2/*` mount, OIDC discovery, JWT auth in middleware, OAuth client admin CRUD, login/consent pages                                |
| **Emails**       | 3 branded templates: enduser-verification, enduser-reset-password, enduser-welcome                                                     |
| **Tests**        | 31 new tests (unit + integration), 0 regressions                                                                                       |

### Files added/modified

```
New (15 files):
  apps/api/src/services/enduser-mapping.ts
  apps/api/src/services/enduser-token.ts
  apps/api/src/routes/oauth-clients.ts
  apps/api/src/routes/oauth-enduser-pages.ts
  packages/db/src/schema/oauth-provider.ts
  packages/emails/src/templates/enduser-{verification,reset-password,welcome}.ts
  packages/db/drizzle/0004_*.sql, 0005_*.sql
  apps/api/test/unit/enduser-token{,-verify}.test.ts
  apps/api/test/integration/{routes/oauth-clients,middleware/enduser-token-auth,services/enduser-mapping}.test.ts

Modified (10 files):
  packages/db/src/auth.ts                    — jwt + oauthProvider plugins
  packages/db/src/schema/applications.ts     — authUserId, status, emailVerified
  apps/api/src/index.ts                      — /oauth2/* mount, JWT auth path, skipAuth
  apps/api/src/types/index.ts                — authMethod: "enduser_token"
  apps/api/src/services/{applications,end-users}.ts — branding/endUserAuth schema, new fields
  packages/emails/src/{types,registry}.ts    — new email types + renderers
  packages/shared-types/src/index.ts         — EndUserInfo +status/emailVerified
  apps/api/test/helpers/app.ts               — mirror production middleware
```

---

## Phase 1.5 — Finalisation avant production

**Status**: A faire
**Prerequis**: Phase 1

### 1.5.1 Brancher les custom claims dans les tokens

Le plugin `oauthProvider` émet des tokens mais sans nos claims custom (endUserId, applicationId). Il faut connecter `resolveOrCreateEndUser` dans le callback `customAccessTokenClaims`.

**Fichier**: `packages/db/src/auth.ts`

```typescript
oauthProvider({
  // ... existing config ...
  customAccessTokenClaims: async ({ user, scopes, referenceId }) => {
    if (!referenceId) return {};
    const endUser = await resolveOrCreateEndUser(
      { id: user.id, email: user.email, name: user.name },
      referenceId, // applicationId from OAuth client
    );
    return { endUserId: endUser.id, applicationId: referenceId };
  },
});
```

**Attention**: `resolveOrCreateEndUser` est dans `apps/api/` mais `auth.ts` est dans `packages/db/`. Il faudra soit déplacer le service, soit injecter la fonction via un hook au boot. Pattern recommandé : hook injectable comme `setBeforeSignupHook()` qui existe déjà.

### 1.5.2 Test E2E du flow OIDC complet

Valider manuellement le flow complet avec un client HTTP :

1. `POST /api/applications/:id/oauth` — activer OAuth pour une app, récupérer clientId/clientSecret
2. `GET /oauth2/authorize?client_id=...&redirect_uri=...&response_type=code&code_challenge=...&scope=openid profile email` — initier le flow
3. Authentifier l'utilisateur sur la page login
4. Récupérer le code d'autorisation du redirect
5. `POST /oauth2/token` — échanger le code contre des tokens (access_token + id_token + refresh_token)
6. `GET /oauth2/userinfo` avec le Bearer token — vérifier les claims
7. `POST /oauth2/token` avec grant_type=refresh_token — rotation du refresh token
8. `POST /oauth2/revoke` — révoquer le token

### 1.5.3 Nettoyage test helper

Ajouter les nouvelles tables OAuth au `truncateAll()` dans `test/helpers/db.ts` :

```typescript
// Ajouter dans l'ordre FK-safe :
await db.delete(oauthConsent);
await db.delete(oauthAccessToken);
await db.delete(oauthRefreshToken);
await db.delete(oauthClient);
await db.delete(jwks);
```

### 1.5.4 Documenter l'OpenAPI

Ajouter les specs OpenAPI pour :

- `POST/GET/PATCH/DELETE /api/applications/:id/oauth` (admin routes)
- Note dans la doc que `/oauth2/*` et `/.well-known/*` sont gérés par Better Auth (pas dans notre spec OpenAPI)

---

## Phase 2 — Migration Portal vers SSO

**Status**: A planifier
**Prerequis**: Phase 1.5 validée en production
**Effort estimé**: ~1 semaine

### Objectif

Remplacer Better Auth local du portal par "Login with Appstrate" via OIDC. Le portal devient un simple client OIDC — plus de gestion d'auth, de tables user, ou de mapping end-user.

### Ce qui disparaît du portal

| Fichier                                                                    | Raison                             |
| -------------------------------------------------------------------------- | ---------------------------------- |
| `packages/db/src/auth.ts`                                                  | Better Auth config (magic links)   |
| `apps/api/src/lib/portal-session.ts`                                       | Extraction session Better Auth     |
| `apps/api/src/services/portal-users.ts`                                    | resolveEndUser() — plus nécessaire |
| `apps/web/src/lib/auth-client.ts`                                          | Better Auth React client           |
| `apps/web/src/components/magic-link-form.tsx`                              | UI magic link                      |
| Tables: `user`, `session`, `account`, `verification`, `portalUserEndUsers` | Auth gérée par Appstrate           |

### Ce qui est ajouté au portal

| Fichier                                  | Rôle                                                                                                        |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/api/src/lib/oidc-client.ts`        | Client OIDC (authorize URL, code exchange, refresh)                                                         |
| `apps/api/src/middleware/bff-session.ts` | BFF pattern : tokens dans cookies httpOnly/Secure/SameSite=Lax                                              |
| `apps/api/src/routes/auth.ts`            | `/api/auth/login` (redirect), `/api/auth/callback` (code exchange), `/api/auth/logout`, `/api/auth/session` |

### Pattern BFF (Backend for Frontend)

Les tokens ne vont JAMAIS dans le frontend (pas de localStorage). Le backend portal :

1. Reçoit le code d'autorisation du redirect OIDC
2. Échange le code contre des tokens (access_token + refresh_token)
3. Stocke les tokens dans un cookie httpOnly chiffré (`portal_session`)
4. Sur chaque requête, lit le cookie, vérifie/refresh le token, set le contexte end-user
5. Le frontend appelle juste `/api/auth/session` pour connaître l'utilisateur courant

### Impact sur le flow share links

**Avant** (magic link) :

1. User ouvre `/s/:token` → show MagicLinkForm
2. Email magic link → session cookie Better Auth
3. `resolveEndUser()` → header `Appstrate-User`

**Après** (OIDC) :

1. User ouvre `/s/:token` → show "Se connecter" button
2. Redirect → Appstrate `/oauth2/authorize` → login page → callback avec code
3. Portal échange code → BFF cookie → end-user ID directement dans le token

Le mapping `portalUserEndUsers` disparaît — le token OIDC porte l'identité end-user directement.

### Variables d'environnement portal

```
- BETTER_AUTH_SECRET        → supprimé
- SMTP_HOST/PORT/USER/PASS  → supprimé (emails gérés par Appstrate)
+ OIDC_CLIENT_ID            → app_xxx (application ID dans Appstrate)
+ OIDC_CLIENT_SECRET        → secret du OAuth client
+ OIDC_ISSUER_URL           → URL Appstrate (default: APPSTRATE_URL)
```

### Migration des données

- Les end-users Appstrate existent déjà (créés par le portal via l'API) — aucune migration de données côté Appstrate
- Les share links continuent de fonctionner (ils utilisent l'API key stockée, pas la session utilisateur)
- Les utilisateurs portal devront se recréer un compte sur Appstrate à leur première connexion post-migration (ou on peut pré-créer les comptes Better Auth depuis les emails du mapping `portalUserEndUsers`)

### Stratégie de déploiement

1. Déployer Phase 1.5 (Appstrate OIDC fonctionnel)
2. Déployer portal avec feature flag `USE_OIDC=true/false`
3. Quand `USE_OIDC=false` : ancien flow magic link (rétro-compatible)
4. Quand `USE_OIDC=true` : nouveau flow OIDC
5. Valider en staging, puis basculer en prod
6. Supprimer le flag + les anciennes tables dans un second temps

---

## Phase 3 — Enrichissements

**Status**: Futur
**Prerequis**: Phase 2 en production

### 3.1 Social login pour end-users

Google et GitHub login pour les end-users — **gratuit** puisque Better Auth gère déjà le social login pour les members. Il suffit de configurer les credentials par application.

**Fichier**: `apps/api/src/services/applications.ts` — étendre `endUserAuth` settings :

```typescript
endUserAuth: {
  // ...existing
  socialProviders?: {
    google?: { clientId: string; clientSecret: string };
    github?: { clientId: string; clientSecret: string };
  }
}
```

### 3.2 Pages login hostées brandées

Remplacer le HTML minimal de `/oauth/enduser/login` et `/oauth/enduser/consent` par des pages React complètes avec :

- Logo, couleurs, nom de l'application (depuis `settings.branding`)
- Formulaire email/password + boutons social login
- Lien "Mot de passe oublié"
- Lien "Créer un compte"

**Approche** : Pages React servies par le backend Hono (pas dans le SPA principal). Build Vite séparé ou composants server-rendered avec `@hono/react-renderer`.

### 3.3 Portail self-service `/me`

Pages accessibles par les end-users authentifiés pour gérer leur propre périmètre :

| Page                 | Route API                      | Description                                    |
| -------------------- | ------------------------------ | ---------------------------------------------- |
| Mon compte           | `GET/PATCH /oauth/enduser/me`  | Nom, email, mot de passe                       |
| Mes connexions       | `GET /api/connections` (token) | Services connectés (Google Drive, Gmail, etc.) |
| Apps autorisées      | `GET /oauth/enduser/me/apps`   | Satellites avec accès, révoquer                |
| Supprimer mon compte | `DELETE /oauth/enduser/me`     | RGPD — suppression complète                    |

### 3.4 Consent screen avec UI React

Remplacer le HTML minimal par une page React avec :

- Branding de l'application
- Liste des scopes demandés avec descriptions claires
- Boutons Autoriser / Refuser
- Mémorisation du consentement (ne pas re-demander pour les mêmes scopes)

### 3.5 Rotation automatique des clés ES256

Job schedulé (BullMQ cron) pour :

1. Générer une nouvelle clé ES256
2. Publier la nouvelle + l'ancienne dans le JWKS
3. Basculer la signature sur la nouvelle clé
4. Retirer l'ancienne après le grace period (7 jours)

Actuellement le jwt plugin gère la rotation automatiquement via `rotationInterval` + `gracePeriod`, mais il faut valider que ça fonctionne correctement en production avec PGlite/PostgreSQL.

---

## Décisions architecturales

| Décision                     | Choix                                     | Raison                                                                                                                              |
| ---------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Plugin vs custom             | `@better-auth/oauth-provider`             | Social login, magic links, token rotation gratuits. ~500 lignes config vs ~1800 lignes custom jose                                  |
| 1 ou 2 instances Better Auth | 1 seule                                   | 2 instances = anti-pattern (route collisions, cookie conflicts). 1 instance + mapping = modèle standard (Auth0, Supabase, Firebase) |
| User model                   | Shared `user` table + per-app `end_users` | Google Accounts pattern. Auth globale + données par application                                                                     |
| Token signing                | ES256 (ECDSA P-256)                       | Asymétrique, JWKS-compatible, standard OIDC                                                                                         |
| ROPC grant                   | Non implémenté                            | Mort en OAuth 2.1, bloqué par Microsoft. Authorization Code + PKCE uniquement                                                       |
| Token storage (satellites)   | BFF pattern (httpOnly cookies)            | Jamais de tokens dans localStorage (XSS)                                                                                            |
| Application-scoping          | Isolation par application                 | Même email dans 2 apps = 2 end-users distincts. Unification SSO possible via `authUserId`                                           |

---

## Risques identifiés

| Risque                                           | Sévérité | Mitigation                                                                                |
| ------------------------------------------------ | -------- | ----------------------------------------------------------------------------------------- |
| oauth-provider refresh token bug (#8512)         | Moyen    | Tester la rotation en E2E. Monitorer l'issue GitHub. Fallback : patch local si nécessaire |
| Better Auth upgrade breaking changes             | Faible   | Lockfile à 1.5.6, tests complets. Pin explicite                                           |
| Members et end-users dans la même table `user`   | Faible   | Pas d'escalation possible — members need org membership, end-users need app mapping       |
| Migration portal (Phase 2) casse les share links | Faible   | Les share links utilisent des API keys stockées, indépendantes de l'auth utilisateur      |
