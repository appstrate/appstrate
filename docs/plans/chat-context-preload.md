# Chat : le contexte des espaces avant le premier appel d'outil

Plan d'implémentation. Établi par lecture de `origin/main` (`d75d5a647`, 2026-11-26).
Statut : **proposé**, rien n'est implémenté.

## Constat

Depuis l'endpoint MCP par organisation (#1825, #1886) et `get_me` sans espace (#2397), le
chat agit dans 1 à N espaces par tour. Son bloc de contexte ne porte plus que l'identité, le
rôle d'organisation, l'espace d'origine, l'union des permissions, la date, la langue et les
skills (`formatCallerContext`, `packages/module-chat/src/prompt.ts`). Les intégrations
connectées et les agents n'y sont plus : le persona envoie le modèle les lire avec `get_me`,
espace par espace (`prompt.ts`, étape 1 de « run an agent » et le paragraphe « Your context
block below is DATA »).

Conséquences :

- presque chaque tour qui agit commence par un `get_me` (parfois deux : sans espace, puis
  avec) ;
- le modèle applique les règles de choix d'espace des instructions MCP (« your personal
  space » pour un run inline) sans savoir, avant un appel, quel espace est le sien ni ce que
  son rôle y permet ;
- un espace où l'acte est interdit n'est appris que par un refus
  (`inline_run_not_allowed_in_space`).

## But

Le modèle sait, avant tout appel d'outil, dans quels espaces il peut agir et ce qu'il peut y
faire, puis quels agents et quelles intégrations y sont utilisables. Une seule implémentation
pour la vue par espace (N = 1) et la vue multi-espaces (N > 1). Les clients MCP externes
profitent de la même donnée par `get_me`.

Hors périmètre : `recent_runs` dans le prompt (casse le cache), la disponibilité des
intégrations requises d'un agent (reste au pré-vol de `run_and_wait`), un réglage global du
chat.

## Faits vérifiés sur `origin/main`

- **Espaces du tour** : `chat-stream.ts` calcule
  `spaces = conv.restricted && originSpace ? [originSpace] : acting`. `acting` vient de
  `c.get("reachable")` (`ReachableSpaceGrant[]` : `id`, `name`, `role`, `permissions`,
  `credentialProxyOpen`, `isDefault`, `personal`), lu une fois par le middleware du routeur.
- **Capacités par espace, deux côtés déjà écrits** :
  - chat : `turnCapabilities(has, spaces)` (`capabilities.ts`) rend `runLevel`, `authors`,
    `authorsPackages`, `callsIntegrationTools` ; appelé avec un seul espace, il donne les
    capacités de cet espace ;
  - MCP : chaque `McpSpace` porte `surface: McpSurface` (`modules/mcp/spaces.ts`,
    `deriveMcpSurface`) ;
  - `apps/api/test/unit/modules/mcp/catalog-requirements.test.ts` tient les deux ensemble.
- **Les capacités n'atteignent le modèle qu'en prose** : listes d'ids dans les instructions
  (`router.ts`, `inlineSpaces`, `proxySpaces`, `teamLaunches`). `get_me` rend `spaces[]` avec
  `id`, `name`, `role`, `personal` seulement (`buildGetMeTool`, `tools.ts`).
- **Une ligne par espace, formulée une fois** : `describeSpace` (`@appstrate/core/mcp-spaces`),
  partagée par le serveur MCP et les outils locaux du chat.
- **Précédent de lecture multi-espaces** : `readChatSkills` lit les skills des espaces du tour
  par la connexion MCP de l'appelant (`openCaller` → `callerMcpOpener`, `withCallerClient`,
  délai `CALLER_READ_TIMEOUT_MS` = 10 s). Cette connexion ne porte aucune session : une lecture
  par elle n'enregistre aucun espace. `AppstrateMcpClient.callTool` existe
  (`packages/mcp-transport/src/client.ts`).
- **Règle des espaces touchés** : tout espace dont une donnée entre dans la conversation est
  enregistré avant l'affichage (`touchSessionSpace`, `persistence.ts`). La conversation n'est
  listée et ouvrable que tant que son auteur atteint tout l'ensemble (`sessionVisible`). Une
  conversation dont l'ensemble est vide appartient à tous les filtres (`touchedUnder`). Le code
  dit déjà où passe la frontière : « Skills are procedures, not data: injecting one touches no
  space » (`chat-stream.ts`). Précédent d'exception pour l'espace personnel : les fichiers
  envoyés par l'auteur n'enregistrent rien.
- **`GET /api/me/context`** : sans espace, `user` et `org` ; avec, `space`, `connections`
  (`listUsableIntegrationsForActor`, sous `integrations:read`), `agents`
  (`listActiveAgentHints`, plafond 15, sous `agents:run`), `skills`, `recent_runs`.
  `connections` ne contient que les intégrations ayant une connexion liable ; les intégrations
  actives non connectées ne sortent que par `search` (`not_ready`).
  `listActiveIntegrationIds` existe (`services/integration-connections.ts`).
- **Cache du prompt** : le prompt système part en un bloc avec un seul point de cache ; toute
  différence d'un tour à l'autre invalide tout le préfixe (commentaire de `formatCallerContext`,
  horloge arrondie à l'heure pour cette raison).
- **Interrupteurs de conversation existants** : `skill_discovery` et `restricted` sont des
  colonnes de `chat_sessions`, écrites par PATCH et lues à chaque tour ; `restricted` est
  refusé pendant un tour (409 `chat_turn_in_flight`). Leur ligne est dans
  `composer-tools-panel.tsx` (`SheetMenuSwitchRow`). Dernière migration : `0113`.
- **Télémétrie** : chaque outil MCP émet un `McpToolEvent` (`emit` → `ctx.observe`), avec le
  nom de l'outil et, pour `search`, les espaces.

## Design : trois niveaux

Le découpage suit la règle des espaces touchés : ce qui décrit l'appelant n'enregistre rien,
ce qui décrit un espace n'est injecté que pour un espace déjà enregistré, et tout injecter est
une option qui enregistre.

### Niveau 1 — espaces et capacités (toujours actif)

Section `## Spaces` du bloc de contexte, une ligne par espace du tour :

```
## Spaces you can act in
- Perso (`spc_a`, role admin, your personal space) — can: run agents, inline runs, integration tools, create packages
- Équipe Ventes (`spc_b`, role operator, origin of this conversation) — can: run agents
```

- **Source** : `spaces` du tour, sans requête. Capacités par `turnCapabilities` appliqué à
  chaque espace sous le plafond du tour (`ceiling`).
- **Formulation** : `describeSpace` gagne un champ optionnel d'actes (`NamedSpace.can`). Le
  chat et le serveur MCP rendent la même ligne.
- **MCP** : `get_me` ajoute `can` à chaque entrée de `spaces[]`, lu de `space.surface`. Un acte
  absent de la liste n'est pas permis (même principe que `McpSurface` : enseigné par l'absence).
- **Doctrine** : faits sur l'appelant, aucun espace enregistré. `get_me` sans espace rend déjà
  les rôles.
- **Cache** : stable tant que les rôles ne changent pas.

### Niveau 2 — détail des espaces engagés (toujours actif)

Pour les espaces `(origine ∪ personnel ∪ touchés) ∩ espaces du tour`, les connexions et les
agents, rendus **par ressource** :

```
## Integrations
- `@appstrate/gmail`@1.2.0 — "Pro" (yours): usable in Perso, Équipe Ventes; active in Équipe Ventes only
- `@appstrate/slack` — active in Équipe Ventes, not connected

## Agents you can run
- `@acme/digest` — Digest: in Équipe Ventes (published, takes input)

Details above cover: Perso, Équipe Ventes. For another space: `get_me` with its `space_id`.
```

- **Source** : un `get_me` par espace concerné, par la connexion de l'appelant, dans le même
  `withCallerClient` que les skills (une connexion pour tout le préambule).
- **Rendu par ressource** : la taille suit le nombre d'intégrations et d'agents distincts, pas
  espaces × ressources ; la ligne répond directement à « où est-ce utilisable ».
- **Ordre déterministe** : origine, personnel, puis touchés par date ; entrées triées par id.
- **Plafond** : `CHAT_CONTEXT_DIGEST_BUDGET_CHARS` (valeur à fixer par la mesure du lot 0).
  Au-delà, les espaces restants sortent de « Details above cover ».
- **Exclus** : `recent_runs`, `skills` (déjà sous `## Skills`).
- **Échec** : un espace dont la lecture échoue ou dépasse le délai sort de « Details above
  cover » ; le tour continue.
- **Doctrine** : origine et touchés sont déjà enregistrés. Espace personnel : décision D1.
- **Cache** : invalidé une fois quand l'ensemble touché grandit, ou quand une connexion ou un
  agent change.

Ajout au payload par espace, utile aussi aux clients MCP : `connectable_integrations`, les ids
des intégrations actives sans connexion utilisable (plafonné, `listActiveIntegrationIds` moins
les connectées). Décision D4.

### Niveau 3 — tous les espaces (option par conversation, désactivée par défaut)

- Colonne `chat_sessions.context_all_spaces boolean not null default false`, sur le modèle de
  `skill_discovery`.
- Activée : le niveau 2 couvre tous les espaces du tour, et le tour enregistre, avant
  l'inférence, chaque espace qui a rendu une entrée (même règle que `search` : une absence
  n'est pas une donnée, #2349).
- Sans effet sur une conversation limitée (un seul espace) ; la ligne n'y est pas proposée.
- À ne construire que si la mesure après le niveau 2 le justifie (décision D5).

## Décisions à prendre

| #   | Décision                                                     | Recommandation                                                                      |
| --- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| D1  | Injecter le détail de l'espace personnel l'enregistre-t-il ? | Non : données de l'auteur, il ne peut pas en perdre l'accès. Exception à documenter |
| D2  | Forme de `can` sur le fil                                    | Tableau de noms d'actes en snake_case ; absent = interdit                           |
| D3  | Valeur du plafond du niveau 2                                | Fixée par le lot 0, verrouillée par un test                                         |
| D4  | `connectable_integrations` dans `/api/me/context`            | Oui, ids seuls, plafonné                                                            |
| D5  | Construire le niveau 3                                       | Après mesure du niveau 2                                                            |

## Lots

Un lot = une PR, depuis une branche neuve sur `origin/main`.

### Lot 0 — mesure de départ

- Compter, sur les tours récents, les `get_me` en premier appel d'outil et les refus
  `inline_run_not_allowed_in_space`, à partir des `McpToolEvent`. Localiser d'abord où
  `ctx.observe` les écrit pour le chat.
- Mesurer la taille d'un `get_me` par espace (caractères) sur une organisation réelle à
  plusieurs espaces : c'est l'entrée de D3.
- Livrable : les chiffres dans ce document. Aucun code livré.

### Lot A — niveau 1

| Fichier                                    | Changement                                                                                              |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `packages/core/src/mcp-spaces.ts`          | `NamedSpace.can?`, `describeSpace` le rend ; entrée CHANGELOG `[Unreleased]`                            |
| `apps/api/src/modules/mcp/tools.ts`        | `buildGetMeTool` : `can` sur `spaces[]` depuis `space.surface` ; description de l'outil                 |
| `apps/api/src/modules/mcp/spaces.ts`       | projection `McpSurface` → liste d'actes, à un seul endroit                                              |
| `packages/module-chat/src/capabilities.ts` | capacités d'un espace sous le plafond du tour (réutilise `turnCapabilities`)                            |
| `packages/module-chat/src/prompt.ts`       | section `## Spaces` dans `formatCallerContext` ; persona : le contexte nomme les espaces et leurs actes |
| `packages/module-chat/src/chat-stream.ts`  | passe `spaces` (déjà fourni) et l'espace personnel au rendu                                             |

Tests :

- `packages/module-chat/test/caller-context.test.ts` : N = 1 limité, N > 1, sans origine,
  aperçu de rôle, sortie identique sur deux tours ;
- `packages/module-chat/test/prompt-invariants.test.ts`, `capabilities.test.ts` ;
- `apps/api/test/unit/modules/mcp/tools.test.ts` : `can` par espace, endpoint épinglé inchangé ;
- `catalog-requirements.test.ts` : la liste d'actes du chat égale celle du MCP pour un même
  jeu de permissions.

Pas de migration, pas de changement OpenAPI REST (`spaces[]` est ajouté par l'outil MCP).

### Lot A2 — instructions MCP (optionnel, après A)

Les listes d'ids en prose (`inlineSpaces`, `proxySpaces`, `teamLaunches` dans `router.ts`)
peuvent renvoyer à `can` au lieu d'énumérer. À ne faire qu'avec les scénarios réels du lot de
vérification : ces phrases portent des comportements réglés en #2347.
Test : `server-instructions.test.ts`.

### Lot B — niveau 2

| Fichier                                   | Changement                                                                                                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `apps/api/src/routes/me.ts`               | `connectable_integrations` (D4)                                                                             |
| `apps/api/src/openapi/paths/me.ts`        | schéma ; puis `bun run generate:api` et `bun run openapi:baseline`                                          |
| `apps/api/src/modules/mcp/tools.ts`       | description de `get_me`                                                                                     |
| `packages/module-chat/src/persistence.ts` | l'ensemble touché lu avec la session du tour (une lecture, pas une requête de plus par espace)              |
| `packages/module-chat/src/prompt.ts`      | lecture `get_me` par espace dans le `withCallerClient` des skills ; rendu par ressource ; plafond ; persona |
| `packages/module-chat/src/chat-stream.ts` | passe l'ensemble touché et l'espace personnel à `buildCallerContextBlock`                                   |
| `apps/api/src/modules/mcp/router.ts`      | phrase `grounding` de la branche `rendersCards`                                                             |

Persona, deux phrases à réécrire dans `buildSystemPrompt` :

- « It lists neither the integrations… » → le contexte liste, pour les espaces qu'il nomme,
  les intégrations et les agents tels qu'au début du tour ; `get_me` pour un autre espace ou
  après une connexion ou une activation pendant le tour ;
- étape 1 de « run an agent » : lire le contexte d'abord, `get_me` pour un espace non détaillé.

Tests :

- `caller-context.test.ts` : fusion par ressource, ordre, plafond atteint, espace en échec,
  espace sans `integrations:read` ou `agents:run`, stabilité sur deux tours ;
- `chat-session-mcp.test.ts` : la lecture du préambule n'enregistre aucun espace ;
- `integration-sheet-chat-parity.test.ts` et un test d'intégration de `/api/me/context` pour
  `connectable_integrations` (session, jeton MCP d'instance, clé d'API d'espace) ;
- label `integration` sur la PR.

### Lot C — niveau 3 (sous réserve de D5)

| Fichier                                                | Changement                                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| `packages/db/src/schema/chat.ts`, `drizzle/0114_*.sql` | colonne ; journal et snapshot écrits à la main ; `schema-catalog.txt` régénéré            |
| `packages/module-chat/src/routes.ts`, `openapi.ts`     | PATCH de session : `context_all_spaces`, refusé pendant un tour comme `restricted`        |
| `packages/module-chat/src/chat-stream.ts`              | champ lu à la création ; `organization.touch` des espaces contributeurs avant l'inférence |
| `packages/module-chat/src/persistence.ts`              | lecture et écriture de la colonne                                                         |
| `packages/module-chat/src/ui/composer-tools-panel.tsx` | ligne `SheetMenuSwitchRow`, absente d'une conversation limitée ; skeletons alignés        |
| `apps/web/src/locales/{fr,en}/chat.json`               | libellés et phrase d'explication (la conversation dépend alors de tous ces espaces)       |

Tests : enregistrement des seuls espaces contributeurs ; conversation limitée inchangée ;
bascule pendant un tour refusée ; spec e2e du panneau (chercher les libellés dans `e2e/`).
Labels `integration` et `e2e`.

### Vérification par scénarios réels (après A, après B)

Avec un vrai modèle sur une instance de campagne (harnais de #2347) :

1. conversation limitée à un espace d'équipe, « lance l'agent X » : aucun `get_me` avant
   `run_and_wait` ;
2. conversation sans origine, « résume mes derniers mails » : run inline dans l'espace
   personnel sans `get_me` ;
3. connexion d'équipe absente de l'espace personnel : le modèle s'arrête et propose l'espace
   d'équipe, sans y lancer ;
4. espace où le run inline est interdit : jamais proposé comme destination ;
5. connexion ajoutée pendant le tour : le modèle relit avec `get_me`.

Puis refaire le comptage du lot 0.

## Risques

- **Divergence chat / MCP sur les capacités** : couverte par `catalog-requirements.test.ts`
  et par `describeSpace` unique.
- **Fuite hors de la règle des espaces touchés** : le niveau 2 ne lit que des espaces
  enregistrés, plus l'espace personnel (D1) ; test dédié.
- **Latence du préambule** : 2 à quelques `get_me` en parallèle, bornés par
  `CALLER_READ_TIMEOUT_MS`. À chiffrer au lot 0 ; chaque `get_me` calcule aussi `recent_runs`
  et `skills`, jetés par le chat : ne les retirer que si la mesure le demande.
- **Cache** : le niveau 2 ajoute des causes d'invalidation rares ; le test de stabilité sur
  deux tours garde le déterminisme.
- **Contexte daté** : le bloc décrit le début du tour ; le persona le dit, `get_me` reste
  déclaré.

## À la release

- `@appstrate/core` : `NamedSpace.can` est un ajout (mineure), mais `[Unreleased]` porte déjà
  deux retraits de #2397 : la prochaine version de core est majeure de toute façon. Rafraîchir
  `published-export-baseline.json` après publication.
- Lot C seulement : une migration, sans réécriture de données.
