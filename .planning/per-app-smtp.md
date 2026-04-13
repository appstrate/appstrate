# Appstrate — Per-application SMTP configuration

## Context

Aujourd'hui, les emails transactionnels (verification, magic-link, reset-password, invitations) sont tous envoyés via **un unique transport SMTP instance-level** configuré par les env vars `SMTP_HOST/PORT/USER/PASS/FROM` (cf. `packages/db/src/auth.ts:207`). Le booléen `features.smtp` est calculé **une fois au boot** dans `apps/api/src/index.ts:buildAppConfig()` et drive :

- le rendering conditionnel des liens "magic-link" / "mot de passe oublié" sur `/api/oauth/login` (templates server-rendered dans `apps/api/src/modules/oidc/pages/`) ;
- le gate `requireSmtp` dans `loadPageContext()` (`apps/api/src/modules/oidc/routes.ts:171`) sur les endpoints magic-link + forgot-password (→ 404 si SMTP absent) ;
- les callbacks Better Auth `sendVerificationEmail` / `sendResetPassword` / `sendMagicLink` (ils sont _absents_ du config object quand `smtpEnabled=false`, ce qui désactive `requireEmailVerification`, `sendOnSignUp`, `sendOnSignIn` cf. `packages/db/src/auth.ts:276-324`).

**Problème** : les clients OIDC `level: "application"` provisionnés dynamiquement par le Portal (ou tout autre consommateur satellite) héritent du SMTP instance Appstrate. Les emails partent `from: SMTP_FROM` (domaine Appstrate), pas du domaine du customer — délivrabilité mutualisée, branding faux, DKIM/SPF non alignés, bounces mutualisés. Voir discussion préalable dans l'historique.

**Objectif** : SMTP devient une config **par-application**, stockée chiffrée en DB. Pour un client OIDC `level=application` sans config SMTP → toutes les features email sont désactivées pour les flows de ce client (auto-verify signup, magic-link 404, forgot-password 404). **Pas de fallback** vers `env.SMTP_*` — c'est le point de sécurité. L'instance-level reste sur env (admin dashboard, org invitations, clients `level=instance` et `level=org`).

## Non-goals

- Pas de changement au flow Portal (il provisionne déjà son client ; la config SMTP sera faite par l'admin Appstrate de l'app — pas par le Portal).
- Pas de modif des invitations d'org (`/api/invitations` → magic-link) — elles partent de l'instance, restent sur env SMTP.
- Pas de per-tenant social auth creds (sujet distinct, même pattern, follow-up).
- Pas de templates email customisables par app pour ce plan (follow-up).
- Pas de migration de schema sur Portal (il n'a rien à stocker, il utilise les endpoints admin Appstrate avec son Bearer admin).
- `features.smtp` global dans `window.__APP_CONFIG__` reste instance-level (il drive la dashboard admin). Seul le contexte OIDC devient per-client.

## Target architecture

```
 End-user                        Appstrate (OIDC provider)                     Customer SMTP
 ─────────                       ─────────────────────────                     ──────────────

  GET /api/oauth/login ─────►   loadPageContext(c)
                                  └─► getClientCached(clientId) ──► oauth_clients row
                                  └─► resolveBrandingForClient(client)
                                  └─► resolveSmtpForClient(client) ──► application_smtp_configs
                                          │                              (level=application)
                                          │                        ─OR── env.SMTP_*
                                          │                              (level=instance|org)
                                          ▼
                                   PageContext { client, branding, features: { smtp }, smtp: { transport | null, from } }
                                  └─► render login page (hide magic-link/forgot-pw if features.smtp=false)

  POST /api/oauth/signup ───►   same loadPageContext resolver ─► signup handler
                                  ├─► if features.smtp: triggerSendVerification(pageContext.smtp, user, url)
                                  └─► if !features.smtp: mark emailVerified=true, skip send

  GET /api/oauth/magic-link ─►  loadPageContext({ requireSmtp: true })
                                  └─► returns 404 if per-client features.smtp=false
                                  └─► on POST: use pageContext.smtp.transport.sendMail(...)

  GET /api/oauth/forgot-pw ──►  same gate
```

Core de la refonte : **`isSmtpEnabled()` disparaît en tant que function globale** (ou reste uniquement pour les surfaces non-OIDC). Tout ce qui passe par un client OIDC lit `features.smtp` depuis le `PageContext` calculé pour ce client.

## Critical files

### Created

| Path                                                                                          | Role                                                                                          |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `packages/db/src/schema/applications.ts` (extension) ou nouveau `application-smtp-configs.ts` | Table `application_smtp_configs` + migration Drizzle                                          |
| `apps/api/src/modules/oidc/services/smtp-config.ts`                                           | `resolveSmtpForClient()`, cache TTL, encrypt/decrypt helpers                                  |
| `apps/api/src/modules/oidc/services/smtp-admin.ts`                                            | CRUD service layer (`getSmtpConfig`, `upsertSmtpConfig`, `deleteSmtpConfig`, `sendTestEmail`) |
| `apps/api/src/routes/application-smtp.ts` (ou extension de `applications.ts`)                 | Admin HTTP routes `/api/applications/:id/smtp-config` + `/test`                               |
| `apps/api/test/integration/services/smtp-resolver.test.ts`                                    | Tests resolver                                                                                |
| `apps/api/test/integration/routes/application-smtp.test.ts`                                   | Tests admin API                                                                               |
| `apps/api/src/modules/oidc/test/integration/routes/oauth-per-app-smtp.test.ts`                | Tests E2E sur flows OIDC par-app                                                              |

### Modified

| Path                                                  | Change                                                                                                                                                     |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `packages/db/src/schema.ts` (barrel)                  | Re-export `applicationSmtpConfigs`                                                                                                                         |
| `apps/api/src/modules/oidc/routes.ts`                 | `loadPageContext` enrichi avec `features.smtp` + `smtp` per-client ; `requireSmtp` lit `ctx.features.smtp` ; callsites (5 lignes `isSmtpEnabled()`) migrés |
| `apps/api/src/modules/oidc/routes.ts:244-247`         | `isSmtpEnabled()` supprimée ou renommée `isInstanceSmtpEnabled()` et ses callsites OIDC deviennent tous per-client                                         |
| `packages/db/src/auth.ts`                             | `sendVerificationEmail` / `sendResetPassword` / `sendMagicLink` deviennent contextuels (voir section "Better Auth integration")                            |
| `packages/db/src/auth.ts:276-324`                     | `requireEmailVerification`, `sendOnSignUp`, `sendOnSignIn` doivent être évalués _par requête_ pour les flows OIDC, pas figés au boot                       |
| `apps/api/src/index.ts` (`buildAppConfig`)            | Pas touché — `features.smtp` global reste instance-level pour la dashboard                                                                                 |
| `apps/api/test/helpers/` (si besoin)                  | `seedApplicationSmtpConfig()` factory                                                                                                                      |
| `apps/api/test/helpers/db.ts`                         | Ajouter `application_smtp_configs` dans `CORE_TABLES`                                                                                                      |
| `apps/api/src/openapi/paths/`                         | Nouveau fichier pour les routes admin + enregistrement dans le bundle                                                                                      |
| `apps/api/src/modules/oidc/services/enduser-token.ts` | (inchangé, mais vérifier que `applicationId` claim reste dispo si on veut logger `smtp.used=per_app                                                        | instance`) |

### Portal side (separate PR in portal repo)

| Path                                                               | Change                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/pages/admin-app-settings.tsx` (nouveau ou extension) | Panel "Emails" : 5 champs (host, port, user, pass, from) + bouton "Envoyer un test" + warning quand vide                                                                                              |
| `apps/web/src/hooks/use-smtp-config.ts` (nouveau)                  | React Query hooks pour GET/PUT/DELETE/test                                                                                                                                                            |
| `apps/web/src/lib/api.ts` (inchangé)                               | Les calls passent par `adminApi` existant                                                                                                                                                             |
| `apps/api/src/routes/admin.ts`                                     | Rien — pas de proxy portal, l'admin UI tape directement `/api/applications/:id/smtp-config` sur Appstrate avec son Bearer admin (passe par le portal's `/api/*` proxy si déjà en place, sinon direct) |

## DB schema

`packages/db/src/schema/application-smtp-configs.ts` (nouveau module, importé dans `schema.ts` barrel). Place le à côté de `applications.ts` pour que le FK soit évident à la lecture.

```ts
import { pgTable, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { applications } from "./applications.ts";

export const applicationSmtpConfigs = pgTable(
  "application_smtp_configs",
  {
    applicationId: text("application_id")
      .primaryKey()
      .references(() => applications.id, { onDelete: "cascade" }),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    user: text("user").notNull(),
    // AES-256-GCM encrypted blob (base64 JSON) via @appstrate/connect encryption.
    // Key source: CONNECTION_ENCRYPTION_KEY (already required env var).
    passEncrypted: text("pass_encrypted").notNull(),
    fromAddress: text("from_address").notNull(),
    fromName: text("from_name"),
    // When true (default), port 465 → secure; anything else (587, 2525) → STARTTLS.
    // Explicit field lets admins force TLS off for a self-signed dev relay.
    secure: text("secure_mode").notNull().default("auto"), // "auto" | "tls" | "starttls" | "none"
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at").defaultNow().notNull(),
  },
  (t) => [index("idx_application_smtp_configs_app").on(t.applicationId)],
);
```

Migration générée via `bun run db:generate` après édition du schema. Row absente → feature off. `ON DELETE CASCADE` pour que la suppression d'une app supprime sa config (pas d'orphelins, pas de leak de secrets).

**Encryption** : réutiliser `packages/connect/src/encryption.ts` (`encryptCredentials` / `decryptCredentials`) qui consomme déjà `CONNECTION_ENCRYPTION_KEY`. Le blob est un objet `{ pass: string }` pour garder la porte ouverte à d'autres secrets plus tard.

## Resolver

`apps/api/src/modules/oidc/services/smtp-config.ts` :

```ts
export interface ResolvedSmtpConfig {
  transport: nodemailer.Transporter;
  fromAddress: string;
  fromName: string | null;
  source: "per-app" | "instance";
}

export async function resolveSmtpForClient(client: {
  level: string;
  referencedApplicationId: string | null;
  referencedOrgId: string | null;
}): Promise<ResolvedSmtpConfig | null> {
  if (client.level === "application" && client.referencedApplicationId) {
    return resolvePerAppSmtp(client.referencedApplicationId);
  }
  // level=instance or level=org → instance-level env SMTP (existing behavior).
  // Org-scoped future work: lookup org's default app SMTP, same as branding fallback.
  return resolveInstanceSmtp();
}

async function resolvePerAppSmtp(applicationId: string): Promise<ResolvedSmtpConfig | null> {
  const cached = cache.get(applicationId);
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  const [row] = await db
    .select()
    .from(applicationSmtpConfigs)
    .where(eq(applicationSmtpConfigs.applicationId, applicationId))
    .limit(1);
  if (!row) {
    cache.set(applicationId, { value: null, expiresAt: Date.now() + 30_000 });
    return null;
  }

  const pass = decryptCredentials(row.passEncrypted).pass;
  const transport = nodemailer.createTransport({
    host: row.host,
    port: row.port,
    secure: resolveSecure(row.secure, row.port),
    auth: { user: row.user, pass },
  });
  const value: ResolvedSmtpConfig = {
    transport,
    fromAddress: row.fromAddress,
    fromName: row.fromName,
    source: "per-app",
  };
  cache.set(applicationId, { value, expiresAt: Date.now() + 60_000 });
  return value;
}
```

**Cache** : simple `Map<applicationId, { value, expiresAt }>` avec TTL 60s (transport OK), 30s pour les null (admin vient de config → veut voir le changement vite). Invalider explicitement dans `smtp-admin.ts` sur upsert/delete.

**Transport lifecycle** : nodemailer transports sont thread-safe et maintiennent un pool interne. On les garde en cache 60s puis on les recycle. Pas de `transport.close()` — nodemailer gère les connexions sous-jacentes.

## Better Auth integration

**Le point tricky.** Better Auth est configuré **une fois au boot** dans `packages/db/src/auth.ts:buildAuth()`. Les callbacks `sendVerificationEmail`, `sendMagicLink`, `sendResetPassword` capturent la `smtpTransport` par closure.

### Approche retenue : AsyncLocalStorage contextuel + skip BA email pour level=application

**Pourquoi cette approche** : changer la config Better Auth par requête est une boîte de Pandore (`requireEmailVerification`, `sendOnSignUp` sont lus à des endroits profonds de la logique BA, pas tous re-évalués). À la place, on garde la config BA instance-level pour les flows non-OIDC, et pour les flows OIDC on **shunte** BA pour la partie "envoi email" et on pilote nous-mêmes depuis `routes.ts`.

Concrètement :

1. **Instance-level auth** (admin dashboard, invitations) : inchangé. `smtpEnabled` calculé au boot depuis env. `sendVerificationEmail` utilise `env.SMTP_*`.
2. **OIDC flows** (`/api/oauth/login`, `/api/oauth/signup`, `/api/oauth/magic-link`, `/api/oauth/forgot-password`) :
   - `loadPageContext` résout `smtp = resolveSmtpForClient(client)` → attache `features.smtp = !!smtp` et `smtp` au `PageContext`.
   - **Signup** : le handler `/api/oauth/signup` appelle `authApi.signUpEmail({ body: { …, emailVerified: !features.smtp } })` — si SMTP absent, on crée l'user déjà vérifié (bypass de verif). Le callback `sendVerificationEmail` global ne sera pas déclenché puisque `emailVerified=true` à la création. Si SMTP présent, on met `emailVerified=false` et on envoie _nous-mêmes_ l'email via `ctx.smtp.transport.sendMail()` après coup (pas via le callback BA global, qui pointerait vers `env.SMTP_*`).
   - **Magic-link / forgot-pw** : déjà gated par `requireSmtp`. Le handler POST fait l'envoi directement via `ctx.smtp.transport` au lieu de déléguer à BA. BA's magic-link plugin n'est pas utilisé ici — on génère nous-mêmes le token signé (même pattern que le signed CSRF déjà présent dans `routes.ts`), ou bien on configure le plugin en "no-op sender" et on patche l'email manuellement.

### Alternative envisagée (rejetée) : AsyncLocalStorage

Wrapper BA avec un middleware qui stocke `currentOidcSmtp` dans un `AsyncLocalStorage<ResolvedSmtpConfig>`. Les callbacks BA lisent `AsyncLocalStorage.getStore()` et switchent de transport. Problème : `requireEmailVerification: smtpEnabled` est lu au boot — pas par callback. Il faudrait passer en `requireEmailVerification: true` global et filtrer au niveau hook. Trop de surface BA à toucher. On garde cette alternative en tête si le scope s'élargit (ex: per-org SMTP future).

## Feature flag propagation

### Global `window.__APP_CONFIG__.features.smtp`

**Inchangé.** Reste instance-level, drive la dashboard. Signal pour le front admin : "je peux afficher le panel SMTP ou pas ?" → réponse : toujours oui si on veut que les admins config'ent leur per-app SMTP. Donc **ce flag devient indépendant du per-app**, ou mieux : renommer en `features.instanceSmtp` pour éviter la confusion (low priority, peut rester tel quel).

### Per-client `features.smtp` dans `PageContext`

Nouvelle shape :

```ts
interface PageContext {
  client: OAuthClientRecord;
  branding: ResolvedAppBranding;
  csrfToken: string;
  features: { smtp: boolean }; // ← new
  smtp: ResolvedSmtpConfig | null; // ← new, null quand features.smtp=false
}
```

Les templates server-rendered (`apps/api/src/modules/oidc/pages/login.ts`, `signup.ts`, etc.) reçoivent déjà le `PageContext`. Ils consomment `ctx.features.smtp` pour hide/show magic-link + forgot-password. Aujourd'hui ils consomment `smtpEnabled` passé en param séparé (cf. `routes.ts:506, 528, 556, 571, 578`) — à migrer en `ctx.features.smtp`.

## Behavior matrix when SMTP disabled for an app

| Feature                    | Behavior when per-app SMTP absent                                        |
| -------------------------- | ------------------------------------------------------------------------ |
| Signup (email/password)    | User créé avec `emailVerified=true` (auto-validé). Pas d'email.          |
| Signup (social)            | Inchangé — `mapProfileToUser: () => ({ emailVerified: true })` déjà set. |
| Signin                     | Identique — pas de `sendOnSignIn` puisque pas de SMTP.                   |
| Magic-link (GET)           | 404 (gate `requireSmtp` existant).                                       |
| Magic-link (POST)          | 404.                                                                     |
| Forgot-password (GET/POST) | 404.                                                                     |
| Email change               | Bloqué — retourne 400 "Email change requires SMTP configuration".        |
| Invitations d'org          | N/A dans le flow OIDC client (c'est un flow instance). Inchangé.         |
| UI login page              | Liens "magic-link" et "forgot-password" cachés via `ctx.features.smtp`.  |

## Admin API (Appstrate)

Monter sur `apps/api/src/routes/application-smtp.ts` (nouveau fichier, routé dans `index.ts` sous `/api/applications`). Auth : Bearer admin OIDC ou session, `requirePermission("applications", "write")` sauf GET (`"read"`).

```
GET    /api/applications/:id/smtp-config         → 200 { applicationId, host, port, user, fromAddress, fromName, secure, createdAt, updatedAt } | 404
                                                    pass is NEVER returned.
PUT    /api/applications/:id/smtp-config         → 200 (same shape, without pass)
  body: { host, port, user, pass, fromAddress, fromName?, secure? }
  Upsert: creates or replaces. Invalidates resolver cache.

DELETE /api/applications/:id/smtp-config         → 204
  Invalidates resolver cache.

POST   /api/applications/:id/smtp-config/test    → 200 { ok: true, messageId } | 400 { code, error }
  body: { to: string, from?: string }  (from defaults to row.fromAddress)
  Rate-limited (5/min per applicationId via rate-limiter-flexible).
  Uses the *stored* config (not a draft) — admin PUTs first, then tests.
```

**Validation** : Zod schema `{ host: z.string().min(1), port: z.number().int().min(1).max(65535), user: z.string().min(1), pass: z.string().min(1), fromAddress: z.email(), fromName: z.string().optional(), secure: z.enum(["auto", "tls", "starttls", "none"]).optional() }`.

**SSRF safety** : valider que `host` ne résout pas vers RFC1918/loopback via `@appstrate/core/ssrf` (même pattern que branding logos). Permet `host=smtp.sendgrid.net` mais bloque `host=169.254.169.254`.

**OpenAPI** : path file + enregistrer dans `buildOpenApiSpec`. `verify:openapi` doit passer.

## Portal admin UX (separate PR)

Minimal :

- Nouveau panneau "Configuration des emails" sur chaque page app admin (portal `/admin/apps/:appId` ou équivalent — _pas encore existant, à décider avec UI existante_).
- 5 fields Zod-validated, bouton "Envoyer un email de test" qui demande `to` (prefill = email admin courant).
- Badge d'état : "✓ Configuré" (vert) ou "⚠ Non configuré — les utilisateurs sont auto-validés, le magic-link et la réinitialisation sont désactivés" (jaune).
- Hooks React Query : `useSmtpConfig(appId)`, `useUpsertSmtpConfig(appId)`, `useDeleteSmtpConfig(appId)`, `useTestSmtpConfig(appId)`. Invalidation : `[smtp-config, appId]` sur upsert/delete.

## Execution order

1. **Schema + migration** : add `application_smtp_configs` table + `bun run db:generate`. Barrel re-export. Test : migration applies cleanly on PGlite + PostgreSQL.
2. **Encryption helpers** : réutiliser `@appstrate/connect/encryption` — vérifier que `encryptCredentials({ pass })` roundtrip.
3. **Resolver** : `smtp-config.ts` avec cache + tests unitaires (null when missing, value when present, cache TTL respected).
4. **Admin service + routes** : `smtp-admin.ts` + `application-smtp.ts` + OpenAPI path. Tests intégration : CRUD happy path, permissions, SSRF block, pass never returned, test-send rate limited.
5. **Better Auth integration** : modifier `packages/db/src/auth.ts` pour que `sendVerificationEmail` / etc. deviennent des _no-ops_ quand appelés depuis un flow OIDC `level=application` (via un flag dans BA context ou via skip à l'appel). En parallèle, modifier `routes.ts` pour piloter l'envoi directement.
6. **`loadPageContext` enrichi** : injection de `features.smtp` + `smtp` via `resolveSmtpForClient`. Remplacer les 5 callsites `isSmtpEnabled()` par `ctx.features.smtp`.
7. **Signup handler OIDC** : bascule `emailVerified` selon `features.smtp`, envoi email via `ctx.smtp.transport` si activé.
8. **Magic-link + forgot-password handlers** : envoi via `ctx.smtp` au lieu d'env. Gate `requireSmtp` continue de marcher (il lit `ctx.features.smtp`).
9. **Tests E2E OIDC** : matrix des 6 scénarios (signup avec/sans SMTP app, magic-link avec/sans, forgot-pw avec/sans) via `mock-appstrate` patterns existants.
10. **Portal UX** (separate PR, portal repo) : panneau + hooks + i18n FR/EN.
11. **Docs + CLAUDE.md** : ajouter section "Per-app SMTP" dans `apps/api/src/modules/oidc/README.md` + env table MAJ (aucun nouvel env var, mais documenter que `SMTP_*` ne drive que l'instance).
12. **Nettoyage** : si `features.smtp` global devient source de confusion, renommer en `features.instanceSmtp` dans `buildAppConfig` + le front. (Optionnel.)

## Tests

Scénarios obligatoires dans l'ordre d'implémentation :

1. **Unit (resolver)** :
   - `resolveSmtpForClient({ level: "application", referencedApplicationId: "app_x" })` avec row absente → `null`.
   - Avec row présente → renvoie transport + fromAddress depuis DB (+ decrypt roundtrip correct).
   - Cache : deuxième appel dans la TTL ne touche pas la DB (mock `db.select`).
   - Invalidate cache : appel à `invalidate(appId)` après mutation force le prochain call à relire.
   - `level=instance` → fallback env (tests existants conservent leur comportement).

2. **Integration (admin routes)** :
   - PUT crée la row, retourne 200 sans `pass`. GET la retrouve sans `pass`. DELETE la supprime, GET → 404.
   - PUT avec `host=169.254.169.254` → 400 SSRF.
   - POST test-send avec `SMTP_HOST=__test_json__` (jsonTransport) vérifie que `sendMail` a été appelé avec les bons args.
   - POST test-send sans row → 400 "not configured".
   - Permissions : user non-admin → 403.

3. **Integration (OIDC flows)** — clé :
   - **Signup app-scoped sans SMTP** : POST `/api/oauth/signup?client_id=<app_client>` → user créé avec `emailVerified=true`. `smtpTransport.sendMail` jamais appelé (spy mock).
   - **Signup app-scoped avec SMTP** : idem mais row en DB → user créé avec `emailVerified=false` et email envoyé via _cette_ transport (assertion sur le mock par-app, pas l'env).
   - **Signup instance client** : route sur `env.SMTP_*` (comportement existant conservé).
   - **GET /api/oauth/magic-link?client_id=<app_client_sans_smtp>** → 404.
   - **POST /api/oauth/magic-link** avec app + SMTP → email envoyé via transport per-app.
   - **Forgot-password** : même matrix (404 sans, envoi via per-app transport avec).

4. **Encryption roundtrip** : écrire pass, lire, comparer. Couverture cas CONNECTION_ENCRYPTION_KEY invalide → erreur explicite au boot.

## Gotchas

- **Transport lifecycle** : nodemailer ne fournit pas de `.close()` idiomatique pour les pool SMTP. On cache 60s et on laisse le GC. Accepter la fuite éphémère (1 transport / app / minute) — pour 1000 apps actives ça fait ~1000 connexions max, ok.
- **Test-send abuse** : un admin peut theoriquement faire rebondir Appstrate comme relay ouvert. Mitigation : rate-limit 5/min per appId + per admin user, `to` doit matcher `@<any-domain>` (pas d'interne), SSRF sur host, log chaque test-send avec `requestId + admin + appId`.
- **Signup sans SMTP ≠ signup public** : le `allowSignup` du client OAuth reste la barrière primaire. Un client `allowSignup: false` refuse l'inscription même si SMTP absent — pas de régression.
- **BA `requireEmailVerification: smtpEnabled`** est lu au boot (statique). Pour les flows OIDC on court-circuite BA (cf. section "Better Auth integration"). **Il ne faut donc JAMAIS s'appuyer sur `requireEmailVerification` côté BA pour gater la vérif dans les flows OIDC** — tout se fait dans nos handlers.
- **DKIM/SPF alignment** : la config SMTP pointe vers le serveur du customer, mais si le `from` ne matche pas le domaine DKIM-signant du customer, Gmail rejette. Le test-send doit remonter l'erreur SMTP brute (nodemailer relaie `response`, `responseCode`) — l'UI Portal affiche ça en rouge. Pas de magie, c'est la responsabilité du customer.
- **CONNECTION_ENCRYPTION_KEY rotation** : si rotation, les passwords SMTP chiffrés deviennent illisibles. Ajouter une note ops : "rotate key → re-upsert toutes les configs SMTP via admin API". Pas de migration auto dans ce plan (complexité hors scope).
- **Concurrency on upsert** : deux admins qui PUT simultanément → le dernier gagne. Acceptable (pas de merge business). `updated_at` permet de détecter une course en log.
- **Tests BA `__test_json__`** : quand `SMTP_HOST=__test_json__` dans l'env, BA passe en jsonTransport. Pour les tests per-app, on veut la même astuce : si `row.host === "__test_json__"`, le resolver renvoie un `jsonTransport` au lieu de tenter une vraie connexion. Ajouter dans le resolver.
- **PostgreSQL + PGlite** : la table marche sur les deux, la migration Drizzle est standard. RAS.
- **Résolution d'ordre secure/port** : expliciter `secure: port === 465 ? true : secure === "tls"` etc. Éviter les surprises sur 587/STARTTLS.
- **OpenAPI schema** : `pass` est write-only — exposer via `writeOnly: true` dans le schema response pour que `verify:openapi` ne flag pas l'omission.

## Out of scope (follow-ups)

- **Per-app social provider creds** (Google, GitHub). Même pattern, table distincte `application_oauth_providers` (appId, provider, clientId, secretEncrypted). Clerk/Auth0/Supabase font ça.
- **Per-app custom email templates** : `application_email_templates` pour override `verification.fr.html` etc. S'accroche sur `renderEmail` via `registerEmailOverrides` existant.
- **Bounce/complaint webhooks** : SendGrid/SES/Mailgun poussent des events. Table `application_email_events` + endpoint `POST /api/applications/:id/email-webhook` signé.
- **Org-level SMTP** : même mécanique mais sur `organizations.id`. Pas utile tant que les clients `level=org` ne sont pas utilisés par un consommateur réel.
- **Dry-run preview** : rendu HTML des templates avant envoi, dans l'UI admin.
- **Metrics** : compteur "emails sent per app per type" pour dashboard ops.
