# Refresh en arrière-plan des connexions OAuth2 d'intégration (#2411)

Plan de refactor. Établi par lecture de `origin/main` (d75d5a647) et du code source de Nango
(`NangoHQ/nango@6f0c1f6`, 2026-11-26). Implémenté sur la branche `feat/background-credential-refresh-2411` (PR à venir).

## Constat

Une connexion OAuth2 n'est rafraîchie qu'à l'usage : au départ d'un run
(`integration-credentials-resolver.ts`, déclencheur `expiring`) ou sur un 401 du proxy
(`forceRefreshIntegrationProxyCredentials`, déclencheur `rejected`). Une connexion inactive n'exerce
jamais son refresh token ; un fournisseur qui expire les refresh tokens inutilisés la tue sans que
personne ne le sache avant le prochain run. Le rafraîchissement lui-même fonctionne (vérifié en prod
sur Tiime) : seul le déclencheur manque.

## Ce que fait réellement Nango (code, pas doc)

La doc dit « refreshes each access token at least once every 24 hours ». Le code fait autre chose,
et c'est le code qui est le standard à suivre :

| Sujet              | Nango, dans le code                                                                                                                                                                                            | Source                                                      |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Cadence            | Cron toutes les 10 min, lot de 100, séquentiel, verrou global, budget = l'intervalle                                                                                                                           | `packages/server/lib/crons/refreshConnections.ts`           |
| Sélection          | `last_fetched_at < now − 1 j` (ou NULL) et non épuisée. **Aucun critère d'expiration**                                                                                                                         | `connection.service.ts:1115-1146`                           |
| Décision           | `instantRefresh: false` : échange **seulement si le jeton est expiré ou à moins de 15 min** de l'être. Sans `expires_at` : rien. Sans refresh token : rien                                                     | `credentials/refresh.ts:613, 669-700`                       |
| Reprise            | `last_fetched_at` est écrit **avant** toute tentative, succès ou échec : une connexion est visitée au plus une fois par jour                                                                                   | `refresh.ts:95`                                             |
| Connexions actives | Tout fetch ou appel proxy avance `last_fetched_at` : le cron ne les touche jamais                                                                                                                              | idem                                                        |
| Arrêt              | 4 **jours calendaires distincts** en échec sans succès entre eux (une rafale compte pour un) → `refresh_exhausted`. Ensuite ni cron ni refresh à la demande ; seul un refresh forcé ou une reconnexion relance | `connections/utils.ts:10`, `connection.service.ts:981-1004` |
| Classification     | Aucune : `invalid_grant` n'est pas lu, une révocation subit les mêmes 4 jours                                                                                                                                  | `oauth2.client.ts:207-216`                                  |
| Notification       | Webhook `type: "auth", operation: "refresh", success: false` à **chaque** échec, plus une ligne d'erreur active par connexion ; webhook de rétablissement si une erreur active est levée                       | `hooks.ts:272-404`                                          |
| Étalement          | Aucun jitter                                                                                                                                                                                                   | —                                                           |

Conséquences à retenir :

1. Nango ne rafraîchit **jamais** un jeton encore valide. Le « toutes les 24 h » est une cadence de
   visite, pas un échange forcé. Un jeton de 7 jours (Discord) n'est échangé qu'à son expiration.
2. L'objectif du cron est la **survie du refresh token**, pas la fraîcheur de l'access token. La
   fraîcheur reste assurée à la demande (marge de 15 min au fetch).
3. Une connexion inactive à jeton d'une heure coûte **un** échange par jour, pas vingt-quatre.

Autres produits (doc seulement) : Composio rafraîchit avant expiration et émet
`composio.connected_account.expired` ; Pipedream expose `healthy` / `dead` / `last_refreshed_at` /
`next_refresh_at` et retente périodiquement ; Auth0 Token Vault ne rafraîchit qu'à l'échange.
Cadences non documentées chez les trois.

Standards : RFC 9700 §4.14.2 (« Refresh tokens SHOULD expire if the client has been inactive for
some time » ; rejeu d'un refresh token tourné → révocation du jeton actif), RFC 6749 §6 (le client
DOIT abandonner l'ancien refresh token quand un nouveau est émis). Un échange forcé sur jeton valide
est donc un risque pur chez les fournisseurs à rotation sans fenêtre de grâce (GitHub Apps, Zoom) si
la réponse se perd, inutile chez LinkedIn (durée fixe de 365 j), et pénalisé chez Exact Online.

## Écarts avec la proposition de l'issue

| Issue                                                                                   | Plan                                                                                                                         | Raison                                                                                                                                                                                                                                             |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Plancher : échange forcé toutes les 24 h, jeton valide compris, déclencheur `keepalive` | **Abandonné.** Visite quotidienne, échange seulement si expiré ou dans la marge                                              | C'est ce que fait Nango. Un échange sur jeton valide dépense une rotation sans rien prouver. Le déclencheur `expiring` existant suffit : pas de troisième déclencheur                                                                              |
| « Rafraîchi **avant** `expiresAt` sans run ni appel »                                   | Rafraîchi **au plus 24 h + un intervalle de scan après** la dernière vérification                                            | Le worker garantit la survie du refresh token. La fraîcheur est le rôle du chemin à la demande (voir étape 4)                                                                                                                                      |
| Colonne `last_refreshed_at`                                                             | Colonne `refresh_checked_at`, écrite **avant** la tentative                                                                  | Horodater le succès seul fait retenter une connexion en échec à chaque scan (72 fois en 3 jours, et sans fin pour `oauth_client_rejected`, qui n'est pas compté). Horodater la visite borne tout à une tentative par jour, comme `last_fetched_at` |
| Budget d'échecs d'arrière-plan distinct, fenêtre d'arrêt de N jours                     | **Aucun nouvel état.** `needs_reconnection` est déjà l'état d'arrêt ; seul le défaut de la fenêtre de grâce change (étape 5) | Avec une tentative par jour, `INTEGRATION_REFRESH_MAX_FAILURES = 5` sur un jeton expiré donne 5 jours : l'ordre de grandeur de Nango (4 jours). `invalid_grant` continue de marquer tout de suite, ce que Nango ne sait pas faire                  |
| Variables d'env : marge, intervalle, fenêtre                                            | **Aucune nouvelle.** Constantes dans le fichier                                                                              | Aucun opérateur n'a de raison de les régler                                                                                                                                                                                                        |
| Interrupteur, ou repli sur `OAUTH_REFRESH_WORKER_ENABLED`                               | **Inconditionnel pour les deux tables ; la variable est retirée** (étape 6)                                                  | Un worker éteint par défaut ne corrige pas le cas rapporté, et sa justification (« le chemin réactif couvre la correction ») est ce que l'issue réfute                                                                                             |
| Worker des modèles laissé tel quel                                                      | **Aligné dans la même PR** (étape 3)                                                                                         | Il échange de force 24 h avant expiration, toutes les 6 h : la règle que ce plan rejette. Deux règles pour un même travail ne décrivent pas un système                                                                                             |
| Événement `integration.connection.needs_reconnection`, #1310 « à concevoir ensemble »   | **Un événement nommé pour les deux côtés dès la première version** (étape 10)                                                | `@appstrate/core` est publié : renommer un événement plus tard est une majeure                                                                                                                                                                     |
| Jitter                                                                                  | Aucun                                                                                                                        | Nango n'en a pas ; le plafond du lot et la concurrence étalent déjà                                                                                                                                                                                |
| `_meta` de manifeste pour désactiver le keep-alive                                      | Sans objet                                                                                                                   | Plus d'échange sur jeton valide, donc plus rien à désactiver                                                                                                                                                                                       |

## Doctrine du projet appliquée

- **Une colonne a un lecteur** (note de `packages/db/src/schema/integrations.ts` sur
  `last_refresh_failure_at`, supprimée par la migration 0045) : `refresh_checked_at` est lue par le
  prédicat du scan. Aucune autre colonne n'est ajoutée.
- **Zéro backfill** (`NO_TRANSITIONAL_CODE.md` §2) : `NULL` signifie « jamais vérifiée », donc due.
  La migration ajoute la colonne et l'index, rien d'autre. Au premier déploiement toutes les
  connexions OAuth2 expirées sont dues ; le plafond du lot les écoule sur quelques scans.
- **Une seule fonction de décision** : `refreshConnectionCredential` reste l'unique juge. Le worker
  est un troisième appelant, pas un second chemin.
- **Un mécanisme, pas deux** : un seul échafaudage de balayage, une seule règle de visite, une seule
  marge (`OAUTH_REFRESH_LEAD_MS`) pour les connexions d'intégration et les identifiants de modèles.
- **Le code décrit le système tel qu'il est** (`NO_TRANSITIONAL_CODE.md`) : la variable retirée n'est
  reconnue nulle part, sans garde ni alias (§4) ; les paramètres, constantes, commentaires et tests
  que le refactor rend faux partent dans la même PR (§3).
- **Un seul écrivain** : `persistCredentialBundle` pour les identifiants, et un seul point de
  bascule de `needs_reconnection` par table (étape 9).
- **Générique plutôt que cas particulier** : la portée du client OAuth se déduit de la connexion,
  pas de l'appelant (étape 2), ce qui sert les trois appelants.
- **Catalogue fermé = note de release** (décision de la PR #2395) : nouveau type de notification et
  nouvel événement webhook passent par `CHANGELOG.md`.

## Étapes

### PR 1 — un balayage de refresh, une règle

**1. Schéma** (`packages/db/src/schema/integrations.ts` et `organizations.ts`, une migration drizzle)

- `refresh_checked_at timestamptz` nullable sur `integration_connections` **et** sur
  `model_provider_credentials`.
- Index partiel `idx_integration_conn_refresh_due` sur `(expires_at)` avec
  `WHERE client_ref IS NOT NULL AND NOT needs_reconnection AND expires_at IS NOT NULL`
  (`client_ref IS NOT NULL` ⟺ OAuth2, invariant déjà documenté sur la colonne). Côté modèles,
  `idx_model_provider_credentials_expires_at_oauth` existe déjà et sert le même prédicat.
- Écrivains de la colonne : `persistCredentialBundle` dans son `set` commun (connexion, reconnexion,
  refresh réussi) ; `createOAuthCredential` et `updateOAuthCredentialTokens` côté modèles. Un
  identifiant utilisé repousse ainsi sa visite, comme chez Nango.
- La note de schéma sur `last_refresh_failure_at` (les deux tables) cite `refresh_checked_at` comme
  la colonne qui a un lecteur.
- `packages/db/schema-catalog.txt` régénéré.

**2. `refreshConnectionCredential` sans acteur ni espace d'appelant**
(`apps/api/src/services/integration-token-refresh.ts`)

- `actor` n'est lu que par `recordUnrefreshableRejection`, donc seulement quand le déclencheur est
  `rejected`. Le déplacer dans ce variant : `{ kind: "rejected"; revision; handshake?; reach: { spaceId, actor } }`.
  `expiring` n'exige plus ni acteur ni espace.
- `buildIntegrationOAuthRefreshContext` reçoit la portée **de la connexion** (`orgId`, `spaceId`
  nullable) au lieu de l'espace de l'appelant, et `resolveIntegrationClientById` filtre
  `client.space_id = connexion.space_id` (si non nul) `OR (client.space_id IS NULL AND client.org_id = connexion.org_id)`.
  Répond à la question ouverte « quel espace pour une ligne d'organisation ».
- À faire avant d'écrire le code : table de vérité du prédicat (connexion d'espace / d'organisation ×
  client système / document CIMD / client d'espace / client d'organisation / client d'un autre
  espace), comparée au prédicat actuel. La garde contre l'escalade entre espaces ne doit pas
  s'affaiblir. `RefreshTarget` gagne `orgId` et `spaceId`.
- Le paramètre `scope` de `refreshConnectionCredential` n'a alors plus de lecteur : supprimé, les
  deux appelants existants cessent de le passer.

**3. Un balayage, deux tables** (`apps/api/src/services/credential-refresh-sweep.ts`)

- Une fabrique porte tout ce qui est commun : file de scan, file de refresh (concurrence 4),
  planification horaire hors de l'heure pile, init, shutdown, journal. Elle reçoit deux fonctions :
  `claim()` (la réclamation SQL de la table) et `refreshOne(id)`. Deux instanciations ;
  `model-providers/refresh-worker.ts` est réécrit dessus, pas conservé à côté.
- **Réclamation atomique**, même forme pour les deux tables : un seul
  `UPDATE … SET refresh_checked_at = now() WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) RETURNING`,
  `ORDER BY expires_at`, `LIMIT 500`. Elle déduplique entre instances et entre scans : pas de
  déduplication de jobs à part.
  - Intégrations :
    `client_ref IS NOT NULL AND NOT needs_reconnection AND expires_at < now() + marge AND (refresh_checked_at IS NULL OR refresh_checked_at < now() − 24 h)`.
    Rien n'est déchiffré au scan.
  - Modèles : `provider_id IN (<fournisseurs OAuth>) AND expires_at < now() + marge AND (refresh_checked_at …)`.
    `needs_reconnection` est une colonne reflétée du blob chiffré : la réclamation n'élit jamais un
    identifiant marqué, comme pour les connexions.
- `refreshOne`, intégrations : relit la ligne, charge le dernier manifeste publié
  (`readIntegrationManifestForProxy(…, null)`, comme le proxy hors run), appelle
  `refreshConnectionCredential` avec `{ kind: "expiring" }`. Manifeste ou auth introuvable : journal
  et abandon, sans marquer la connexion. Le verrou `intg-refresh:${id}` et la relecture sous verrou
  existants couvrent la concurrence avec un refresh à la demande.
- `refreshOne`, modèles : `resolveOAuthTokenForSidecar` (non forcé, marge `OAUTH_REFRESH_LEAD_MS`)
  à la place de `forceRefreshOAuthModelProviderToken` avec `force: true`. Le worker des modèles
  cesse d'échanger des jetons valides. `REFRESH_LEAD_HOURS` et `SCAN_CRON` (6 h) disparaissent.
- Enregistrement des deux balayages dans `bootHousekeeping` sans condition, arrêt dans la séquence
  de shutdown. La file locale gère `upsertScheduler` : ils tournent aussi en tier 0.
- Effet à connaître : une connexion expirée **sans** refresh token (Google sans
  `access_type=offline`) sera marquée `needs_reconnection` par le worker au lieu de l'être au
  prochain run. C'est le verdict actuel de `doRefresh`, rendu plus tôt.

**4. Fraîcheur à la demande hors run** (`credential-proxy/integration-resolver.ts`)

- `resolveIntegrationProxyCredentials` demande `expiring` avant de construire la charge, comme le
  résolveur de run. Supprime l'aller-retour 401 du premier appel après expiration.

**5. Règle d'escalade recalée** (`packages/env/src/index.ts`)

- Défaut de `INTEGRATION_REFRESH_GRACE_SECONDS` : 3600 → 259200 (3 jours). La règle reste
  « 5 échecs transitoires **et** jeton expiré depuis plus que la grâce ».
- Pourquoi : avec le balayage, le compteur prend deux sens. Connexion inactive : 5 tentatives
  quotidiennes, 5 jours. Connexion utilisée pendant une panne du fournisseur : 5 échecs en quelques
  minutes, morte une heure après l'expiration. À 3 jours, une rafale ne tue plus rien avant 3 jours
  d'expiration ; le cas inactif reste à 5 jours. Nango obtient le même effet en comptant un échec
  par jour calendaire.
- Vaut pour les modèles, qui lisent la même variable (`token-resolver.ts`).
- Même nom, nouveau défaut : `compose-defaults.ts`, les deux `.env.example`, `docs/ENV.md`,
  commentaire du schéma d'env. Avant release : vérifier que la prod ne fixe pas la valeur.

**6. Retrait de `OAUTH_REFRESH_WORKER_ENABLED`**

- Supprimée du schéma d'env, de `boot.ts` (la branche conditionnelle et son commentaire), de
  `apps/cli/src/lib/compose-defaults.ts`, de `.env.example`, de
  `examples/self-hosting/.env.example`, de `docs/ENV.md`, et des en-têtes de
  `refresh-worker.ts` et `pairing-cleanup-worker.ts` qui la citent.
- Aucune garde, aucun alias : une clé inconnue est ignorée (`NO_TRANSITIONAL_CODE.md` §4). Une ligne
  dans la note de release ; `deploy/` et l'env de prod relus pour l'enlever.

**7. Tests, docs**

- Prédicat du scan : expiré dû, expiré vérifié depuis moins de 24 h, valide, `expires_at` NULL,
  non-OAuth2, `needs_reconnection`, `refresh_checked_at` NULL.
- Réclamation : deux scans concurrents ne réclament pas la même ligne.
- Job : succès (jeton tourné persisté une fois, `expires_at` avance), échec transitoire (compteur +1,
  pas de nouvelle tentative au scan suivant), `invalid_grant` (marquée, exclue du scan), cinquième
  échec quotidien sur jeton expiré (marquée).
- Concurrence worker / à la demande : un seul échange.
- Portée du client : la table de vérité de l'étape 2.
- Escalade : une rafale de 5 échecs sur un jeton expiré depuis une heure ne marque plus ; elle marque
  passé 3 jours.
- Modèles : `model-providers-refresh-worker.test.ts` est **réécrit** sur la nouvelle règle (plus de
  marge de 24 h, plus d'échange forcé, plus d'opt-in), pas complété. Les tests qui lisent
  `INTEGRATION_REFRESH_GRACE_SECONDS` par `getEnv()` suivent le défaut sans retouche ; ceux qui
  supposent une heure en dur sont corrigés.
- `grep` de `e2e/` sur les libellés et comportements touchés.
- Docs : `docs/architecture/INTEGRATIONS_RUNTIME.md`, commentaires de schéma, `docs/ENV.md`,
  `CHANGELOG.md` (retrait de la variable, nouveau défaut de grâce, worker des modèles désormais
  inconditionnel et non forcé).

**8. L'issue**

- Les critères d'acceptation de #2411 décrivent un plancher de 24 h et un budget d'échecs qui ne
  sont pas construits. Avant d'ouvrir la PR : commentaire sur l'issue avec les critères révisés et
  le constat sur le code de Nango, pour que la PR ferme ce que l'issue demande réellement.

### PR 2 — prévenir quand un identifiant meurt

**9. Un point de bascule par table**

- Intégrations : `markIntegrationConnectionNeedsReconnection` et l'escalade de
  `recordIntegrationRefreshFailure` rendent la transition `false → true` (clause
  `needs_reconnection = false` + `RETURNING`, ou ancienne valeur lue dans la même instruction).
- Modèles : `markCredentialNeedsReconnection` et `recordModelCredentialRefreshFailure` rendent la
  même transition depuis `updateBlob`.
- L'événement part sur la transition seule : un signal par mort, quel que soit le chemin. Nango,
  lui, répète à chaque échec.

**10. Un événement, nommé pour les deux côtés**

- `@appstrate/core` : `onCredentialNeedsReconnection` dans `ModuleEvents`, émis par `emitEvent`
  (précédent : `onRunConnectionMissing`). Charge discriminée par
  `kind: "integration_connection" | "model_provider_credential"`, avec `orgId`, l'identifiant, la
  cause (`CredentialFailureCause`) et, selon le `kind`, l'intégration, l'auth et le propriétaire, ou
  le fournisseur. Ajout non cassant ; entrée de CHANGELOG de core. Émis par **les deux** tables dès
  cette PR.
- Module webhooks : un événement `credential.needs_reconnection` dans `webhookEventSchema`, même
  discriminant dans la charge. Un webhook d'espace reçoit les connexions de son espace ; un webhook
  d'organisation reçoit celles-ci aussi (filtre de paquet respecté) ; un identifiant de modèle n'a ni espace ni paquet : seuls les webhooks d'organisation sans filtre de paquet le reçoivent.
  OpenAPI → `generate:api` + baseline.
- Cloche : type `credential_needs_reconnection` (`notificationTypeValues`, `NotificationPayloads`,
  migration qui réécrit le CHECK `notifications_type_valid`), charge discriminée de la même façon.
  - Connexion d'intégration : destinataire = le propriétaire (`user_id` ou `end_user_id`). Espace
    (`notifications.space_id` est NOT NULL) : `space_id` de la connexion, sinon `origin_space_id`,
    sinon l'espace personnel du propriétaire. Lien vers les connexions des préférences.
  - Identifiant de modèle : le type et le rendu existent, **l'écriture attend la décision « qui
    reçoit » de #1310** (créateur, administrateurs, ou les deux ; et dans quel espace). Cette PR
    n'écrit donc pas de ligne de cloche pour les modèles ; le webhook, lui, part.
- Rendu web + libellés FR/EN.

### Hors périmètre

- **#1310, ce qu'il en reste** : le destinataire de la cloche côté modèles et le canal e-mail
  (premier e-mail opérationnel, question de la locale). L'événement et le type sont prêts.
- **Webhook de rétablissement** : fonctionnalité nouvelle, pas une dette.
- **Renommer `INTEGRATION_REFRESH_*`**, lus aussi par les modèles : renommage d'env de prod sans gain
  fonctionnel.
- **Renommer `refresh_failure_count`**, qui compte à la fois les échecs transitoires OAuth et les
  rejets 401 d'identifiants non rafraîchissables : le mélange précède ce plan, qui ne l'aggrave pas.

## Critères d'acceptation (révisés)

- Une connexion OAuth2 inactive dont le jeton a expiré est rafraîchie sans run ni appel, au plus
  24 h + un intervalle de scan après sa dernière vérification (`expires_at` et `refresh_checked_at`
  avancent).
- Une connexion dont le jeton est encore valide n'est jamais échangée par le worker.
- Un refresh d'arrière-plan et un refresh à la demande concurrents font un seul échange ; le refresh
  token tourné est persisté une fois.
- Une connexion en échec est retentée au plus une fois par jour par le worker, marquée
  `needs_reconnection` après 5 échecs sur un jeton expiré depuis plus de 3 jours, puis exclue du
  scan ; une reconnexion la rend de nouveau éligible.
- Une panne du fournisseur de quelques heures ne marque aucune connexion, utilisée ou non.
- Les identifiants OAuth de modèles suivent la même règle de visite, sans interrupteur ; aucun jeton
  valide n'est échangé.
- `OAUTH_REFRESH_WORKER_ENABLED` n'apparaît plus nulle part dans le dépôt.
- Un identifiant qui passe à `needs_reconnection`, par n'importe quel chemin, émet un événement et
  un webhook, une seule fois ; une connexion d'intégration produit en plus une notification à son
  propriétaire.
- Le premier appel proxy hors run après expiration ne paie plus de 401.

## Vérification en réel

Serveur OAuth factice local à jeton de 60 s et refresh token tournant, connexion laissée inactive,
`refresh_checked_at` vidé à la main, déclenchement du scan : observer un échange, la rotation
persistée, puis aucun échange au scan suivant. Rejouer avec le point de jeton en 500 (compteur), puis
en `invalid_grant` (marquage, notification, webhook). Après release : la connexion Tiime de prod.
