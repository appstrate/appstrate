# Séquence de démarrage — plan en cinq lots

Statut : **lots A à D exécutés** (issue #2251, branche `refactor/boot-sequence`) ; **lot E reporté**.
Base lue : `origin/main` @ `444c28777` (2026-11-17). Les §2 et §9 notent ce que l'implémentation a
corrigé dans ce plan.
Périmètre : `apps/api/src/lib/boot.ts`, `apps/api/src/index.ts`, `apps/api/src/routes/health.ts`,
`packages/db/src/migrate.ts`, `deploy/docker-compose.yml`.

## 1. Constat mesuré

Mesure du 2026-11-17 sur `origin/main`, Postgres + Redis + MinIO + Docker locaux, base vide,
harnais hors dépôt appelant les fonctions de `boot.ts` dans l'ordre.

| Poste                                  | Base vide | À chaud    |
| -------------------------------------- | --------- | ---------- |
| Import du graphe de modules            | 562 ms    | 313–412 ms |
| Phase 1 `bootCritical` (avant le port) | 2914 ms   | 358–392 ms |
| dont migrations (107 / 0 en attente)   | 2406 ms   | 27–42 ms   |
| dont `ensureBucket`                    | 210 ms    | 155–160 ms |
| dont `loadModules`                     | 221 ms    | 100–111 ms |
| dont les 5 gardes de refus             | < 20 ms   | < 25 ms    |
| Phase 2 `bootBackground` (borne haute) | 513 ms    | 108–126 ms |

Conclusion : la séquence n'est pas lente. Les lots ci-dessous ne visent pas la vitesse nominale
mais quatre choses que la mesure ne montre pas : la disponibilité après incident, la dette des
gardes, l'observabilité du démarrage, le déploiement sans fenêtre d'arrêt.

**Non mesuré**, et donc à lire en production une fois le lot A livré : pré-pull d'images à froid,
runs orphelins avec conteneurs à arrêter, base peuplée, latence réseau.

## 2. Corrections à l'analyse initiale

Deux points de l'analyse orale étaient faux ou incomplets, relevés en lisant `main` :

- **Les migrations hors boot existent déjà à moitié.** `deploy/docker-compose.yml` porte un service
  `appstrate-migrate` (`bun packages/db/src/migrate.ts`). Mais le boot migre quand même, et
  `migrate.ts` ne prend pas le verrou consultatif que prend `applyCoreMigrations`. Le lot D
  unifie, il ne crée pas.
- **Un registre « script N appliqué » en table est une mauvaise idée ici.** Les gardes actuelles
  interrogent l'état des données avec le `WHERE` exact du script : elles discriminent. Une table
  de pointage dirait « passé » sur une base où le script a tourné à moitié, et demanderait un cas
  particulier pour les installations neuves. Le lot C garde les prédicats et ne factorise que la
  mécanique.

Trois corrections de plus, relevées en implémentant :

- **Le passage des orphelins ne tue pas un run lancé pendant le démarrage.** `listOrphanRunIds()` ne
  prend que les runs sans battement depuis `RUN_STALL_THRESHOLD_SECONDS`, et le balayage des
  conteneurs préserve tout conteneur `running`. La garde du lot B reste justifiée (orchestrateur pas
  encore initialisé, images pas encore tirées), mais pas par ce risque.
- **La garde du lot B vit dans les services, pas sur les routes.** Le planificateur et les connexions
  par conteneur n'entrent par aucune route ; MCP `run_and_wait` et le chat ré-entrent les routes en
  processus. `prepareAndExecuteRun` (et l'exécuteur de connexion) couvrent toutes les portes.
- **« En attente » se décide par filigrane, comme le migrateur Drizzle**, pas par empreinte : un
  fichier est appliqué quand son `when` dépasse `max(created_at)`. `verify` et `apply` ne peuvent
  donc pas diverger, et une base en avance sur le code démarre.

## 3. Ordre et dépendances

```
A (durées)  ──►  B (disponibilité par capacité)  ──►  E (rôles)
C (gardes)        indépendant                          ▲
D (migrations)    indépendant  ───────────────────────┘
```

Une PR par lot. A, C et D peuvent partir en parallèle : fichiers disjoints sauf `boot.ts`, où
A passe en premier (il touche toutes les lignes d'appel). E ne démarre que sur décision, voir §9.

## 4. Lot A — durée de chaque étape dans les logs

**But.** Savoir en production ce que coûte chaque étape, sans harnais.

**Changement.**

- Nouveau `apps/api/src/lib/boot-step.ts` : `bootStep(phase, name, fn)` qui exécute, chronomètre
  et émet une ligne `Boot step` `{ phase, step, durationMs, outcome }`. `outcome` vaut `ok`,
  `degraded` (erreur rattrapée par l'appelant) ou `failed` (erreur propagée).
- `boot.ts` : chaque étape passe par `bootStep`. Aucun changement d'ordre ni de sémantique
  d'erreur. Les `.catch(() => logger.warn(...))` existants restent où ils sont.
- `index.ts` : la ligne `Server ready` porte `startupMs` (depuis le lancement du processus), `criticalMs` et `servingMs` ; `Run capacity ready` porte `runCapacityMs`.
- Commentaire « ~45 ms » de `initSystemPackages` corrigé ou retiré.

**Tests.** Unitaire sur `bootStep` : durée émise, erreur propagée intacte, `outcome` correct.

**Fini quand.** Un démarrage local produit une ligne par étape, et la somme des durées de
phase 1 colle à `criticalMs` à quelques ms près.

**Risque.** Nul sur le comportement. Volume de logs : ~45 lignes par démarrage, niveau `info`.

## 5. Lot B — disponibilité par capacité

**But.** Après un incident, l'API de lecture, l'authentification et le tableau de bord répondent
tout de suite ; seul le lancement de runs attend l'orchestrateur.

**État actuel.** `bootGate()` répond 503 sur toutes les routes jusqu'à la fin de `bootBackground()`.
Cette phase attend la finalisation des orphelins (jusqu'à 5 s par conteneur, par 6) puis le premier
essai de `orchestrator.initialize()` (pré-pull). `isAgentRuntimeReady()` existe mais n'est lu que
par `/health` : aucune porte d'exécution ne le consulte.

**Changement.**

1. Scinder `bootBackground()` en deux fonctions :
   - `bootServing()` : sync des paquets système, triggers NOTIFY, LISTEN, bus de cache,
     abonné d'annulation, worker de reprise de facturation (reste fatal). `markServerReady()`
     se déclenche à sa résolution.
   - `bootRunCapacity()` : orphelins, `cleanupOrphans()`, `initializeAgentRuntime()`, puis
     planificateur, watchdog, réchauffeur d'images. L'ordre interne est conservé tel quel.
   - Les ménages ponctuels et les GC partent après, sans rien bloquer.
2. Nouvel état `runCapacityReady` (dans `agent-runtime-readiness.ts`), vrai quand
   `bootRunCapacity()` a fini son passage orphelins + nettoyage.
3. Garde `requireRunCapacity()` montée sur les portes d'exécution : 503 `run_capacity_starting`,
   `Retry-After`. Portes : `POST /api/agents/{scope}/{name}/run`,
   le run inline, le tour de chat qui lance un run, et le tick du planificateur (qui ne démarre
   de toute façon qu'après). `POST /api/runs/remote` n'est volontairement pas gardée : elle ne démarre aucune charge côté serveur, et la ligne de run créée porte `last_heartbeat_at = now()`, ce qui la tient hors du passage orphelins.
4. `/health` : agrégation inchangée. Le `HEALTHCHECK` du conteneur exige `healthy` ; laisser
   `agents: degraded` peser sur le statut garde un orchestrateur cassé visible (et redémarrable).

**Pourquoi la garde est obligatoire, pas un confort.** `cleanupOrphans()` supprime les conteneurs
étiquetés `appstrate.managed`, et `listOrphanRunIds()` prend les runs `pending`/`running`. Un run
accepté avant la fin de ce passage serait tué ou marqué en échec par le démarrage lui-même.

**Tests.**

- `test/integration/middleware/boot-gate.test.ts` étendu : lecture en 200 et lancement en 503
  entre les deux états, puis 201 après.
- Test de conformité calqué sur `isActiveAgentGate` : la garde est présente sur chaque porte
  d'exécution lue dans la table de routes Hono. Une porte ajoutée sans garde casse le test.

**Docs.** `apps/api/AGENTS.md` (pipeline de requête), `AGENTS.md` § Operational Notes,
OpenAPI : réponse 503 sur les portes concernées, puis `generate:api` et baseline.

**Fini quand.** Avec un `initialize()` rendu artificiellement lent, `GET /api/agents` répond 200
pendant que `POST …/run` répond 503, et aucun run n'est accepté avant la fin du nettoyage.

**Risques.**

- Le `HEALTHCHECK` du conteneur redémarre l'instance si `status !== "healthy"`. Vérifier que
  `agents: degraded` ne fait pas basculer le statut global, sinon boucle de redémarrage pendant
  un pré-pull long. À lire dans `health.ts` avant d'écrire la première ligne.
- Le SPA doit afficher le 503 de lancement comme un état transitoire, pas comme une erreur.
- Modules qui lancent des runs par un chemin propre : recenser avant de fusionner.

## 6. Lot C — gardes de refus factorisées

**But.** Ajouter ou retirer une garde coûte une entrée de tableau, pas une fonction, un texte de
120 mots et un fichier de tests. `boot.ts` redevient un fichier d'orchestration.

**État actuel.** Cinq gardes dans `boot.ts`, ~450 lignes. Trois sont transitoires et portent leur
propre consigne de suppression (`0011`, `0044`, `0048`). Deux sont permanentes (dérive du
filigrane `0006`, couverture du trousseau). Les scripts `0053` et `0054` n'ont pas de garde.

**Changement.**

1. Nouveau dossier `apps/api/src/lib/boot-guards/` :
   - `invariants.ts` : les deux gardes permanentes, déplacées telles quelles.
   - `pending-data-scripts.ts` : un tableau déclaratif. Chaque entrée porte `script`,
     `afterMigration`, `pending(db) → nombre`, `consequence` (une phrase), `removeWhen` (la
     condition de suppression). Une seule fonction `assertNoPendingDataScripts()` parcourt le
     tableau et construit le message, commande `DATABASE_URL` ou `PGLITE_DATA_DIR` incluse.
2. Les prédicats SQL restent **exactement** ceux des scripts. Rien ne passe par une table de
   pointage (voir §2).
3. Les tests par garde deviennent un test paramétré sur le tableau, plus un test par prédicat
   contre une base réelle.
4. Test unitaire (pas une tâche de `bun run check`) : chaque entrée référence un fichier existant
   de `scripts/migration/`, et `removeWhen` n'est pas vide.

**Hors périmètre.** Ajouter des gardes pour `0053`/`0054` : décision à part, le lot rend
seulement l'ajout bon marché.

**Docs.** `docs/NO_TRANSITIONAL_CODE.md` §4 : pointer le tableau comme l'endroit unique où vit
une garde transitoire. `scripts/migration/README.md` : une ligne.

**Fini quand.** `boot.ts` ne contient plus aucun texte d'erreur de garde, les cinq refus
produisent les mêmes informations qu'avant, et supprimer une garde transitoire est un diff d'une
entrée.

**Risque.** Régression d'un message opérateur. Parade : test d'instantané sur les cinq messages
avant et après.

## 7. Lot D — migrations hors du démarrage, au choix de l'opérateur

**But.** Permettre un déploiement où le schéma est appliqué par une étape distincte et où l'API
se contente de vérifier. Le défaut reste « tout au démarrage » pour le tier 0 et l'installeur.

**État actuel.** Deux chemins qui ne se connaissent pas : `applyCoreMigrations()` dans `boot.ts`
(avec verrou consultatif) et `packages/db/src/migrate.ts` (sans verrou), ce dernier déjà appelé
par le service `appstrate-migrate` du compose de production. Le boot rejoue ensuite la même
opération.

**Changement.**

1. Une seule implémentation dans `@appstrate/db` : `applyCoreMigrations()` avec le verrou.
   `boot.ts` et `migrate.ts` l'appellent tous les deux. PGlite garde son chemin propre.
2. Nouvelle fonction `listPendingCoreMigrations()` : entrées du journal dont le `when` dépasse
   `max(created_at)` de `drizzle.__drizzle_migrations`, la règle même du migrateur Drizzle. Une base
   **en avance** sur le code n'est pas un refus : le retour arrière reste possible.
3. Variable `MIGRATIONS_ON_BOOT` : `apply` (défaut) ou `verify`. En `verify`, le boot n'écrit
   aucun schéma et refuse de démarrer s'il reste des migrations en attente, en les nommant.
   Mot-clé explicite, jamais une valeur vide.
4. `deploy/docker-compose.yml` : l'application passe en `verify` et attend
   `appstrate-migrate` en `service_completed_successfully`.
5. `@appstrate/module-ee` migre ses tables dans `init()` : même variable, même comportement.

**Tests.** Intégration Postgres : `verify` avec une migration en attente refuse ; `verify` à jour
démarre ; `apply` inchangé ; deux `migrate.ts` concurrents ne se marchent pas dessus.

**Docs.** `docs/ENV.md` et `.env.example` (`verify:env-docs`), `deploy/README.md`, runbook de
release : l'ordre « scripts de données, puis migrations, puis démarrage » devient exécutable
sans arrêter l'application pour les migrations additives.

**Fini quand.** En production, une release sans script de données se déploie sans fenêtre : le
service de migration passe, puis l'application redémarre en `verify`.

**Risques.**

- Une migration non additive garde besoin d'une fenêtre. Le lot ne change pas ça, il le rend
  visible : à écrire noir sur blanc dans le runbook.
- Coolify : vérifier qu'il honore `service_completed_successfully` avant de compter dessus.

## 8. Lot E — rôles `web` et `worker`

**But.** Pouvoir faire tourner plusieurs réplicas HTTP sans que chacun relance planificateur,
ménages et finalisation d'orphelins.

**Changement.**

1. Variable `PROCESS_ROLE` : `all` (défaut), `web`, `worker`. Refus au démarrage si le rôle n'est
   pas `all` sans `DATABASE_URL` et `REDIS_URL` : les files en mémoire ne traversent pas les
   processus.
2. `web` : `bootCritical()` + `bootServing()`. Pas de planificateur, pas de ménages, pas de
   worker de file.
3. `worker` : migrations en `verify`, modules, puis tous les workers. Serveur HTTP réduit à
   `/health`.
4. Contrat de module : `ModuleInitContext` expose le rôle, pour que `webhooks` et `module-ee`
   ne démarrent leurs workers que là où il faut. **Changement de `@appstrate/core`**, donc
   publication npm mineure et mise à jour de la base d'exports publiés.
5. `deploy/docker-compose.yml` : deux services sur la même image.

**Ce que le lot ne fait pas.** L'exécution d'un run reste dans le processus qui l'a accepté
(`run-tracker`, arrêt gracieux, battement par instance). Déplacer l'exécution vers `worker` est un
autre chantier, plus gros, et n'est pas nécessaire pour l'objectif ci-dessus.

**Point dur.** La finalisation des orphelins au démarrage suppose aujourd'hui qu'une instance qui
redémarre possède ses runs. Avec deux rôles, dire lequel finalise quoi, et prouver que le seuil
de battement suffit à ne pas tuer le run d'un voisin vivant.

**Tests.** Conformité : en rôle `web`, aucun worker n'est instancié (liste lue, pas supposée).
E2E à deux processus sur Postgres + Redis : une planification ne se déclenche qu'une fois.

## 9. Décisions à prendre

| #   | Question                                                                | Proposition                                                                                                                                                                                        |
| --- | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Lot E : le faire maintenant ?                                           | Non. Attendre un besoin de multi-réplica réel                                                                                                                                                      |
| 2   | Lot D : `verify` par défaut en production dès la sortie ?               | Oui dans `deploy/`, `apply` partout ailleurs                                                                                                                                                       |
| 3   | Lot B : statut de `/health` pendant que la capacité de run se construit | Agrégation inchangée (`degraded`), voir §5                                                                                                                                                         |
| 4   | Lot C : ajouter des gardes pour `0053` et `0054` dans la foulée ?       | PR séparée, après le lot                                                                                                                                                                           |
| 5   | Lot D : `module-ee` suit-il la même variable ?                          | Non : son journal est verrouillé et appliqué par le module à son `init()` ; le faire appliquer par `migrate.ts` franchirait la frontière de licence. Dit dans le message de refus et `docs/ENV.md` |

## 10. Vérification commune à chaque lot

- Tests ciblés du lot, puis un `bun run check` avant de pousser.
- Étiquette `integration` sur B, D et E ; `e2e` sur B et E.
- Après fusion du lot A : relever les durées par étape sur staging, puis en production après
  la release, et réévaluer les lots B et E à la lumière de ces chiffres.
