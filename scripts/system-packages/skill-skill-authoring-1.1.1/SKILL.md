---
name: skill-authoring
description: Créer ou améliorer une skill de méthode de l'organisation. Charge ce guide avant createSkill ou updateSkill quand une méthode manque, déclenche mal, guide mal l'exécution ou doit être simplifiée. Il impose la lecture complète de l'existant, une modification minimale et une comparaison publiée contre draft avant publication.
---

# Créer ou améliorer une skill de méthode Appstrate

Utilise ce guide après avoir vérifié les skills de l'organisation et les méthodes de référence. Le
résultat attendu est une méthode durable que plusieurs agents peuvent réutiliser sans hériter des
détails d'une instance particulière. Préserve une bonne méthode existante au lieu de créer une
variante concurrente.

Une création transmet deux artefacts séparés à `createSkill` :

1. le `manifest`, qui présente le package au copilote ;
2. le `content`, un `SKILL.md` avec son propre frontmatter, que l'agent exécutera.

Une amélioration part du draft courant et de son `lock_version`, puis transmet les deux artefacts
complets à `updateSkill`. Ne publie jamais une version pendant l'itération.

## Processus

### 0. Choisir entre création et amélioration

Cherche d'abord une méthode existante dont le besoin et la frontière correspondent. Si elle existe,
améliore-la. Crée une nouvelle skill seulement quand aucune méthode n'a le même propriétaire
conceptuel.

Avant toute amélioration :

1. appelle `getSkill` pour obtenir le manifest, le contenu et le `lock_version` du draft ;
2. appelle `listPackageFiles` avec `version: "draft"`, puis lis le contenu `inline` de chaque fichier
   pertinent, notamment `SKILL.md`, `manifest.json` et les références Markdown ;
3. appelle `getSkillVersionInfo`. Si une version publiée existe, relis aussi ses fichiers avec
   `listPackageFiles` et son numéro exact, afin de distinguer la base publiée du draft courant.

Un fichier texte pertinent sans contenu `inline` n'est pas réputé lu. Signale cette limite et ne
réécris pas à l'aveugle une règle qui peut dépendre de ce fichier. Cette étape est terminée quand tu
peux nommer la règle défaillante, sa source actuelle et les consommateurs qu'elle affecte.

### 1. Isoler la méthode de l'instance

Passe chaque instruction au test suivant :

> Cette phrase resservirait-elle telle quelle à un autre agent de l'organisation ?

- **Oui** : place-la dans la skill. Exemples : critères de décision, heuristiques, ordre des étapes,
  cas ambigus, seuils métier, forme de restitution et conditions de fin.
- **Non** : place-la dans le `prompt.md` de l'agent. Exemples : connecteur, opération d'API, canal,
  libellé, identifiant, fréquence, limite de volume et correspondance des champs.

Une capacité runtime Appstrate requise par la méthode est un contrat, pas un détail d'instance.
Déclare-la dans une section `Prérequis du manifest`, puis fais ajouter son id au
`runtime_tools` de l'agent.

Cette étape est terminée quand chaque phrase a un seul propriétaire et que la skill ne dépend
d'aucun connecteur précis.

### 2. Écrire les deux descriptions pour leurs deux lecteurs

La description est un déclencheur, pas un résumé décoratif. Le corps ne peut pas réparer une
description qui déclenche le mauvais geste.

**`manifest.description` est lu par le copilote qui assemble les agents.** Écris le besoin qui doit
faire sélectionner cette skill, sa frontière avec les méthodes voisines et l'action attendue :

- pour une skill de l'organisation, sélectionner ce package et le déclarer dans l'agent ;
- pour une méthode système de référence, créer la copie sous le scope de l'organisation, puis
  déclarer cette copie.

**Le frontmatter `description` du `SKILL.md` est lu par l'agent au runtime.** Écris les situations
où l'agent doit ouvrir la méthode pour exécuter sa tâche. Garde les instructions détaillées dans le
corps.

Écris les deux descriptions séparément, même si elles partagent le même vocabulaire métier. Cette
étape est terminée quand chacune provoque le bon geste chez son lecteur sans dépendre du corps.

### 3. Écrire le frontmatter et le corps

Le frontmatter contient au minimum :

```yaml
---
name: nom-de-la-skill
description: Déclencheur destiné à l'agent qui exécute la méthode.
---
```

Le `name` est le segment non scopé du package et doit égaler le nom du dossier parent matérialisé
par le runtime. Pour `@acme/qualification-candidatures`, écris
`name: qualification-candidatures`, jamais le nom scopé.

Organise le corps par ordre d'exécution :

1. objectif concret ;
2. étapes avec une condition de fin observable pour chacune ;
3. prérequis du manifest ;
4. règles et cas limites consultés au moment utile ;
5. exemple ou schéma seulement s'il change réellement le comportement.

Conserve dans le fichier principal tout ce qui est requis à chaque exécution. Déplace une table,
une référence volumineuse ou une variante rarement consultée dans un fichier dédié seulement si ce
fichier fait réellement partie du package et si le corps indique précisément quand le lire. Un
pointeur vers une référence absente rend la méthode incomplète. Regroupe une règle et son exception
sous le même titre afin qu'elles soient lues ensemble.

### 4. Rendre les instructions exécutables

- Formule le comportement cible positivement. Par exemple, « conserve le message en brouillon
  soumis à validation » active mieux le bon geste qu'une interdiction seule.
- Quand une interdiction est un garde-fou indispensable, donne l'issue de secours dans la même
  règle. Exemple : « garde le message en brouillon et demande une validation avant tout envoi ».
- Définis des critères de complétion vérifiables et exhaustifs. « Chaque candidature cite les
  preuves utilisées et marque les critères inconnus » est plus opérant que « analyse soigneusement ».
- Choisis un mot-guide métier compact quand il ancre plusieurs décisions, puis réutilise ce même
  mot dans les descriptions, les étapes et les critères. Un nouveau jargon qui exige sa propre
  explication n'est pas un mot-guide utile.
- Supprime les conseils que le modèle applique déjà par défaut. Garde les seuils métier, les
  arbitrages, les formats et les pièges qu'il ne peut pas deviner.
- Maintiens une seule source de vérité par règle. Une reformulation répétée attire trop d'attention
  sur un détail et finit par diverger.
- Retire les branches périmées au lieu d'empiler des correctifs. La skill doit décrire la méthode
  actuelle, pas conserver le journal de ses anciennes versions.
- Lors d'une amélioration, change la plus petite surface qui explique l'échec observé. Préserve les
  règles utiles, les noms stables et les références qui ne participent pas au problème.

### 5. Déclarer les capacités runtime

Un runtime tool absent du manifest de l'agent n'existe pas pendant le run. Si la méthode suppose
une capacité, nomme-la dans `Prérequis du manifest` et indique le comportement de repli :

- checkpoint entre deux passages : `pin` ;
- archivage durable : `note` ;
- document publié : `publish_document` ;
- sortie structurée : `output` avec le schéma correspondant dans le manifest de l'agent.

Vérifie les ids contre le schéma courant de l'agent avant `createAgent`. Une capacité facultative
doit avoir un repli explicite. Une capacité indispensable doit bloquer la création tant qu'elle
n'est pas déclarée.

### 6. Vérifier le déclenchement

Avant de considérer la méthode terminée, écris deux requêtes réalistes qui doivent la sélectionner
et un quasi-cas qui ne doit pas la sélectionner. Le quasi-cas doit partager son vocabulaire avec le
besoin sans exiger la même méthode.

Inscris ces trois requêtes dans le `SKILL.md`, sous une section `Déclenchement`, avant d'appeler
`createSkill` ou `updateSkill`. Elles font partie de l'artefact vérifiable : ne les garde pas
seulement dans ton raisonnement ou dans la conversation.

Si le comportement de départ est incertain, compare une exécution sans la skill et une exécution
avec la skill. Dans une conversation vierge, vérifie que :

- les cas positifs chargent la skill avant de produire l'artefact concerné ;
- le quasi-cas ne la charge pas ;
- la sortie respecte les critères de complétion avec les seuls outils déclarés.

Révise les descriptions quand la sélection est mauvaise. Révise le corps quand la sélection est
bonne mais l'exécution échoue. Appuie chaque affirmation de réussite sur cette vérification fraîche,
pas sur une exécution antérieure qui avait déjà la méthode en contexte.

## Boucle d'amélioration publiée contre draft

Applique cette boucle à une skill existante avant de proposer sa publication :

1. **Reproduire.** Choisis les requêtes de `Déclenchement` qui exposent le défaut. Définis le signal
   attendu avant de modifier le draft : sélection de la skill, critère de sortie, erreur outil,
   reprise ou contrainte métier.
2. **Modifier.** Mets à jour le draft avec `updateSkill`, en renvoyant le manifest et le contenu
   complets ainsi que le dernier `lock_version`. Si le verrou a changé, relis le draft et réapplique
   la modification au lieu d'écraser le travail concurrent.
3. **Comparer.** Pour chaque requête retenue, lance deux `run_and_wait` inline adjacents avec le même
   manifest de test, le même prompt, le même input et la même configuration. Le run A sélectionne
   la dernière version publiée exacte dans `dependency_overrides`. Le run B sélectionne `draft`.
   N'altère aucun autre paramètre entre A et B.
4. **Observer.** Une fois les deux runs terminaux, lis leur ressource avec `getRun` pour les
   métadonnées de comparaison, puis leurs traces avec `getRunLogs`. Cet appel ne sert pas à attendre
   une seconde fois. Vérifie d'abord `resolved_skill_versions` : le run A doit nommer la version
   publiée exacte avec `source: "version"`, le run B doit porter `version: null` et
   `source: "draft"`. Ne confonds pas ce snapshot avec `version_ref`, qui décrit l'agent exécuté.
   Si le snapshot manque ou diverge, signale que la comparaison n'est pas prouvée au lieu de
   l'inférer depuis `dependency_overrides`. Compare ensuite le résultat, le statut, la durée,
   l'usage de tokens, les erreurs et reprises d'outils, le chargement de la skill et chaque critère
   défini à l'étape 1.
5. **Décider.** Garde le draft seulement s'il améliore les cas positifs sans faire déclencher le
   quasi-cas ni dégrader une contrainte existante. Sinon, corrige la cause précise et rejoue le plus
   petit sous-ensemble discriminant.

S'il n'existe aucune version publiée, utilise comme A un inline identique sans la nouvelle skill et
comme B le draft. Présente les ids des runs, les différences observées et les incertitudes. Demande
une validation humaine avant `createSkillVersion` : une exécution réussie ne publie jamais
automatiquement la méthode.

## Exemple de découpe

Besoin : qualifier des candidatures reçues par email, écrire les résultats dans un tableau et
signaler les dossiers prioritaires dans un canal RH.

**Dans la skill** : grille d'évaluation, preuves exigées, traitement des critères inconnus,
conditions d'escalade et ordre de priorité.

**Dans le prompt de l'agent** : boîte et libellé à lire, connecteur du tableau, correspondance des
colonnes, canal RH, fréquence et volume maximal par passage.

La skill reste ainsi valable si l'organisation change de messagerie, de tableur ou de canal.

## Contrôle avant écriture

Vérifie chaque point avant d'appeler `createSkill` ou `updateSkill` :

- le parcours choisi évite une skill parallèle quand une méthode existante possède déjà le besoin ;
- en amélioration, tous les fichiers pertinents ont été lus et la base publiée est identifiée ;
- le manifest et le `SKILL.md` portent deux descriptions adaptées à leurs lecteurs ;
- le `name` du frontmatter égale le dernier segment du nom de package ;
- la méthode reste indépendante des connecteurs et paramètres de l'instance ;
- chaque étape a une condition de fin observable ;
- toute capacité runtime supposée est déclarée avec son repli ;
- chaque garde-fou indique le comportement autorisé ;
- le corps contient une section `Déclenchement` avec deux cas positifs et un quasi-cas, puis ces cas
  vérifient le déclenchement dans une conversation vierge ;
- en amélioration, les runs publiée et draft ne diffèrent que par `dependency_overrides`, leurs logs
  ont été comparés, `resolved_skill_versions` confirme les sélections et leurs ids sont conservés
  dans le compte rendu ;
- chaque ligne restante change une décision ou une action de l'agent.

Le draft est prêt à être proposé quand les deux artefacts passent ce contrôle et que le prompt de
l'agent ne porte plus que l'instance. La publication reste une décision séparée.
