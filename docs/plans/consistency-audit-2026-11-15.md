# Audit de cohérence inter-pages — 2026-11-15

**Base : `origin/main` à `1e8fb34bf`.** Quatre audits en lecture seule, menés en parallèle : listes, formulaires/mutations, structure des pages/navigation, API/hooks.

**Attention aux numéros de ligne.** Trois des quatre audits (listes, navigation, API) ont lu la copie locale `feat/integrations-connection-count`, en retard de 93 commits sur main. Leurs numéros de ligne peuvent avoir glissé. Les constats clés ont été revérifiés sur main et tiennent tous :

- runs en offset, numéro de page en état local ;
- recherche `search` des utilisateurs finaux, en `useState` ;
- hash d'onglet en `replace` ;
- chat qui lit les logs avec `limit=1000` ;
- `useOrgOnlyScope` dans la barre latérale du chat ;
- titre de document fixe.

L'audit formulaires a lu main directement.

Aucun code n'a été modifié.

## 0. Le socle existe déjà, les écarts sont au-dessus

- **Listes** : `collectionVerdict`, puis un corps `DataTable`, `CardGrid` ou `ItemList`. Autour : `ListToolbar`, `ListFooter`, `useListParams` / `useLocalListParams`, et `EmptyState`, `NoMatchState`, `ErrorState`.
- **Enveloppe API** : une seule, `listResponse()` → `{object:"list", data, hasMore, total?}`. Les bornes passent par un seul parseur, `parseListPagination`.
- **Formulaires** : `useSettingDraft` + `ManualSave` / `SaveBar`, `InlineTextSetting`, `SaveFeedback`, `useUnsavedChanges`, `ConfirmModal`, `FormModal`, `PendingButton`, `FormItem`, `useAppForm`.
- **Pages** : `PageHeader`, `DetailBar`, `SettingsHeading` / `SettingsPageActions`, `RouteGate`, `ResourceErrorState`, `useTabWithHash`, `DisabledReasonTooltip`.

Le travail consiste à **faire converger les écarts vers ce socle**. Il n'y a pas de nouvelle abstraction à créer, à deux exceptions près : `useDocumentTitle` et un hook pour la pagination par curseur (keyset).

## 1. Pagination et listes (demande initiale)

### Constat

| Mode                                                        | Où                                                                                                                        | Taille                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Offset + Préc./Suiv. « page X/Y »                           | Runs : page Runs, onglet runs d'un agent, d'une planification                                                             | 15 / 12 / 20 (défaut serveur 20 ; **50** pour les runs d'un agent) |
| Curseur `startingAfter` + « Charger plus »                  | Fichiers, utilisateurs finaux, livraisons de webhook, fils de chat                                                        | 25 / 25 / 20 / 100                                                 |
| Aucune (tout est chargé)                                    | Agents, skills, MCP, intégrations, planifications, catalogue, tous les réglages                                           | —                                                                  |
| Plafond fixe, `hasMore` ignoré (**troncature silencieuse**) | Cloche de notifications (50), barre latérale du chat (100), fichiers de résultat d'un run (100), logs dans le chat (1000) | —                                                                  |

### Écarts

- Le bouton « Charger plus » existe sous **trois rendus**, avec **quatre clés i18n** : `page.loadMore`, `spaces.loadMore`, `webhooks.loadMoreDeliveries`, `threads.showMore`. Celui des utilisateurs finaux est hors de `ListFooter` et n'affiche pas de compte.
- Le numéro de page des runs vit en état local alors que les filtres sont dans l'URL. Un retour arrière ou un lien partagé ramène donc à la page 1.
- En offset, l'insertion de runs en temps réel fait glisser les lignes d'une page à l'autre.
- `docs/CASING_CONVENTIONS.md` classe les runs comme une liste « bounded admin » (offset). Or c'est la collection la moins bornée de toutes.
- `keysetPaging` est réimplémenté dans `module-chat/use-sessions.ts`.
- La recherche s'appelle `q` partout, sauf pour les utilisateurs finaux (`search`). Celle-ci est en plus gardée en `useState` au lieu de l'URL.
- `/api/end-users` et `/api/files` renvoient un champ `limit` en écho, ce que ne fait aucune autre liste ; `endingBefore` n'existe que sur `/api/end-users`.
- **État « aucun résultat » :**
  - sans bouton de réinitialisation : intégrations, planifications, utilisateurs finaux ;
  - remplacé par l'état « vide » : fichiers, planifications de l'agent, connexions, versions, outils, utilisation d'un paquet.
- **États vide et chargement :**
  - `EmptyState` est tantôt `compact`, tantôt non, dans des tables pleine page ;
  - `TextSkeleton` est utilisé à la place du squelette du corps de liste : rôles, modèles, `agent-tabs`, barre latérale du chat.
- **Réglages :** aucun écran n'a de barre d'outils ni de compte, donc pas de recherche sur les membres, les clés API ou les modèles.

### Modèle cible proposé

**Un seul mode pour les collections non bornées : curseur `startingAfter`, et « Charger plus » dans `ListFooter`, avec le compte. Les listes bornées restent sans pagination. Plus aucun numéro de page.**

- `useKeysetList` générique (limite **25**) et `LoadMoreFooter`, avec une seule clé `common:pagination.loadMore`. Le chat réutilise `keysetPaging`.
- `/api/runs`, `/api/agents/{s}/{n}/runs` et `/api/schedules/{id}/runs` passent au curseur. `total` reste optionnel pour le compte. L'offset est supprimé, pas de compatibilité gardée. Mettre à jour `CASING_CONVENTIONS.md`.
- Les vues à plafond fixe chargent la suite, ou signalent la coupure comme le fait `run-snapshot-inspector`. Correction prioritaire : les logs dans le chat doivent suivre le curseur `since`, comme le fait `useRunLogs`.
- **Recherche :** paramètre serveur `q` partout. Filtres d'une page dans l'URL (`useListParams`). Filtres d'une liste imbriquée en `useLocalListParams`.
- **États :** `NoMatchState` avec `onReset` dès qu'un filtre est actif. `EmptyState compact` dans tout corps de liste. Le squelette vient du corps de liste, jamais d'un `TextSkeleton`.
- **Listes bornées :** `ListFooter` avec le compte. `ListToolbar` avec recherche dès qu'une liste peut dépasser une dizaine de lignes (membres, clés API).

> Variante possible : déclencher le chargement automatiquement au défilement (`IntersectionObserver`) au lieu d'un bouton. C'est le même modèle de données, seul le déclencheur du pied de liste change. Le bouton est plus accessible et garde le pied de page atteignable. C'est une décision produit.

## 2. Formulaires et mutations

1. **Brouillons hors des primitives**, cinq surfaces.
   - `billing-contact`, `billing-managers` : pas de garde de sortie.
   - `space-auth-tab` (OIDC) : son `useSeededForm` recopie `useSettingDraft`, et le bouton Enregistrer reste toujours actif.
   - `webhook-settings-tab` : l'état ne suit pas un refetch, Enregistrer reste toujours actif, et l'interrupteur Actif est enfermé dans le brouillon.
   - `schedule-settings` : brouillon maison, sans « Enregistrer et quitter ».
     → `useSettingDraft` + `ManualSave` partout.
2. **Double retour** : `SaveFeedback` ou SaveBar à l'écran, **plus** un toast succès émis par le hook (`use-integrations.ts`, sections access-rules et org-default).
3. **Toasts succès** : 49 appels sans règle commune.
   - Même acte, retour différent. Supprimer un rôle, un paquet ou un client OAuth affiche un toast ; supprimer un webhook, un proxy, un modèle, une clé API ou une planification n'affiche rien. Changer le rôle d'un membre d'espace affiche un toast, celui d'un membre d'org non.
   - Les toasts sont émis tantôt dans les hooks, tantôt dans les composants.
     → Règle proposée : toast seulement quand le résultat n'est pas visible à l'écran. Toujours dans le composant.
4. **Refus dans `FormModal`** : 11 modales l'affichent inline (slot `error`), 11 s'en remettent au toast global. → Inline partout.
5. **Confirmations**
   - 5 `ConfirmModal` sans `confirmLabel` (libellé « Confirmer ») : suppression d'org, clients-table, oauth-client ×2, space-auth.
   - Suppression d'un fil de chat : `Dialog` brut, sans état d'attente, erreur avalée.
   - Dissociation d'un compte : aucune confirmation.
6. **Boutons** : 10 sites changent leur libellé pendant l'envoi au lieu d'utiliser `PendingButton`. 4 modales mettent leurs boutons dans le corps au lieu de `FormModal` (new-schedule, reauth, invitation, clients-table).
7. **Champs et bibliothèque** : `Label` + `Input` à la main dans environ 8 fichiers, `<label>` brut dans 8 fichiers. 3 `useForm` bruts au lieu de `useAppForm`.
8. **Mutations** : 4 styles d'invalidation, 3 styles d'optimisme pour un choix immédiat. → En choisir un par cas.
9. **i18n** : propre (clés fr/en identiques ; seuls « breadcrumb » et « More » restent en dur dans `packages/ui/breadcrumb.tsx`).

## 3. Structure des pages et navigation

1. **Onglet actif, cinq mécanismes**
   - Hash avec `replace` : le retour arrière n'annule pas un changement d'onglet.
   - `?tab=` avec `push` : le retour arrière l'annule (rôles, modèles).
   - `?execution=` ad hoc (intégrations).
   - **État local** pour le même concept : catalogue, éditeur de création.
   - Segment de chemin (lecture du catalogue, `tablist` faite main).
     → Deux primitives seulement, toutes deux dans l'URL, avec **un seul** comportement au retour arrière.
2. **Vocabulaire des onglets** : `details` sur une planification au lieu de `overview` ; `configuration` sur une intégration au lieu de `settings`. Le webhook rend ses panneaux sans `DetailTabPanel`.
3. **En-têtes**
   - `PageHeader` n'a pas de prop `description` (`<p>` à la main dans les pages).
   - Le tableau de bord contourne `variant`, code 1300px en dur et utilise un `Button` au lieu de `PageActionsMenu`.
   - Le détail d'un webhook met ses badges de statut dans la zone des actions.
   - `ListPageSkeleton` dessine un bloc d'action même sur `/files`, qui n'en a pas : décalage à l'arrivée.
4. **Fil d'Ariane** : trois points d'entrée, dont un `useBreadcrumb("overlayPage")` brut. Les squelettes de liste ne publient pas de fil d'Ariane, celui du tableau de bord oui.
5. **Détail d'un élément**
   - Page dédiée : paquets, runs, planifications.
   - Panneau latéral : catalogue.
   - Modale : réglages.
   - Exception : les webhooks ont une page dédiée dans les réglages.
6. **Permission manquante, quatre traitements**
   - Masqué (majorité). Plusieurs pages ajoutent en plus un garde extérieur, redondant puisque `PageActionsMenu` ne rend déjà rien quand tout est masqué.
   - Désactivé avec `DisabledReasonTooltip`.
   - Désactivé avec un `title` natif.
   - Désactivé sans raison (`org-setting-toggle`).
     Le bouton Activer d'une intégration est masqué à un endroit et désactivé à un autre.
7. **Chargement et erreurs**
   - Les détails d'intégration et de webhook testent `isLoading` au lieu de `isQueryInFlight`.
   - Le webhook n'a pas de squelette de page.
   - L'intégration a une double branche d'erreur.
   - `workspace-settings/general` affiche `<ErrorState/>` sans message.
   - Le chat a son propre écran « introuvable ».
8. **Titre du document** : toujours « Appstrate ». → `useDocumentTitle` alimenté par le store du fil d'Ariane, sans opt-in par page.
9. **Préférence de vue** : stockée en localStorage, sauf la vue matrice des rôles (`?view=matrix`).

## 4. API et couche de données

1. **`limit` invalide, quatre comportements**
   - 400 nommé : `parseListPagination`, 13 sites.
   - Repli silencieux : chat.
   - 400 générique : admin storage-deletion.
   - Re-bornage redondant dans les services.
     Les commentaires de `runs.ts`, le texte OpenAPI et `apps/api/AGENTS.md` décrivent un repli qui n'existe plus.
2. **Validation des paramètres de requête** : stricte sur files et connection-calls, laxiste ailleurs. Dates parsées à la main (runs) ou via `z.iso.datetime`.
3. **Codes de retour**
   - 2 POST de création renvoient 200 au lieu de 201 : shares, pairing.
   - Les compteurs renvoyés par les DELETE sont nommés de façon hétérogène : `deleted_count` contre `memories_deleted`.
4. **Paramètres de chemin**
   - Pour la ressource elle-même : `{id}` ou `{runId}` / `{spaceId}`.
   - `PUT /notifications/{id}/read` contre `PUT /notifications/read/{runId}` (ordre inversé).
   - `/api/profile` contre `/api/profiles/batch`.
5. **Clés de requête front : trois systèmes**
   - Typées `[method, path, init]`.
   - Fabriques héritées dans `lib/query-keys.ts`, dont `versions`, `agentModel` et `agentProxy`, que le patcheur SSE n'utilise pas.
   - Hybrides dans le chat.
     Deux formes de clé pour les requêtes infinies.
6. **Isolation du cache par espace** : deux mécanismes. **Bug** : `conversation-sidebar.tsx` lit `/api/chat/sessions/{id}`, ressource scopée espace, avec `useOrgOnlyScope` ; l'espace est absent de la clé.
7. **module-chat** : 16 `fetch` bruts au lieu du client typé, d'où la perte des erreurs RFC 9457 ; doublons de requêtes avec le web (`/api/models`, skills, `/api/runs/{id}`, logs, intégrations, sessions). Lecture du corps par `parseBody(await c.req.json())` au lieu de `readJsonBody`.
8. **Enveloppe construite à la main** dans module-chat et module-ee, parce que `listResponse` n'est pas exposé aux modules.

## 5. Bugs réels repérés en passant (hors simple alignement)

| #   | Bug                                                                                                                   | Effet                                         |
| --- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| B1  | Le chat lit les logs d'un run avec `?limit=1000` et ignore `hasMore` (`module-chat/ui/use-run-log-stream.ts:229,334`) | Logs d'un long run tronqués dans le chat      |
| B2  | `conversation-sidebar.tsx:237` : `useOrgOnlyScope` sur une ressource scopée espace                                    | Cache partagé entre espaces                   |
| B3  | Suppression d'un fil de chat : fermeture avant l'`await`, erreur non rattrapée (`thread-list.tsx`)                    | Échec silencieux                              |
| B4  | La cloche de notifications et les fichiers de résultat d'un run ignorent `hasMore`                                    | Troncature silencieuse                        |
| B5  | `webhook-settings-tab` : `useState(webhook.*)`                                                                        | Affiche des valeurs périmées après un refetch |

## 6. Découpage en PR proposé (une PR par thème, indépendantes sauf mention)

| Lot                       | Contenu                                                                                                                                                              | Dépendances                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **L1** Correctifs         | B1–B5                                                                                                                                                                | aucune                        |
| **L2** Pagination unifiée | API runs en curseur, `useKeysetList` + `LoadMoreFooter`, une seule clé i18n, `q` partout, plafonds fixes levés, doc `CASING_CONVENTIONS`                             | après le choix du modèle (§1) |
| **L3** États de liste     | `NoMatchState`+reset, `EmptyState compact`, squelettes de corps, barre d'outils et compte sur les réglages                                                           | après L2 (mêmes fichiers)     |
| **L4** Formulaires        | brouillons vers `useSettingDraft`, toasts (règle unique), `FormModal`/inline, `confirmLabel`, `PendingButton`, `FormItem`, `useAppForm`                              | aucune                        |
| **L5** Navigation         | primitives d'onglet + vocabulaire, `PageHeader description`, fil d'Ariane, gating (`DisabledReasonTooltip`), forme chargement/erreur des détails, `useDocumentTitle` | aucune                        |
| **L6** API                | `parseListPagination` partout (+ exposé aux modules), commentaires/OpenAPI/AGENTS.md, 201, noms de compteurs, paramètres de chemin, validation stricte des requêtes  | L2 pour les runs              |
| **L7** Couche données     | clés typées partout (hors SSE), une forme de clé infinie, module-chat sur le client typé                                                                             | après L1                      |

Points restant à trancher côté produit :

- (a) déclencheur du chargement de la suite : bouton ou défilement automatique ;
- (b) toast après suppression suivie d'une navigation : oui ou non ;
- (c) retour arrière sur un changement d'onglet : annule ou non ;
- (d) parent d'un run ouvert depuis `/runs` : la liste d'où l'on vient, ou l'agent ;
- (e) sous-entités des réglages, webhooks inclus : modale ou page dédiée.
