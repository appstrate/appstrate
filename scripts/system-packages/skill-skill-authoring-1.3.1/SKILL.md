---
name: skill-authoring
description: Créer ou améliorer une skill de méthode appartenant à l'organisation. Charge ce guide quand une méthode manque, déclenche mal, guide mal l'exécution ou doit être simplifiée, y compris quand agent-authoring lui délègue cette branche. Il contient des méthodes de référence à lire seulement lorsqu'elles correspondent au besoin.
---

# Créer ou améliorer une skill de méthode

Utilise ce guide après avoir confirmé que le besoin appartient à une méthode réutilisable. Si la
demande porte sur l'assemblage, les intégrations, le prompt ou le déclenchement d'un agent, rends cette
branche à `@appstrate/agent-authoring`.

Le résultat attendu est une méthode que plusieurs agents de l'organisation peuvent partager. Préserve
une bonne méthode existante au lieu de créer une variante concurrente.

## Source de vérité

Le MCP Appstrate possède les opérations, paramètres et schémas courants. Découvre puis décris
l'opération adaptée avant chaque lecture ou mutation. Ne recopie pas ici ses noms de champs, ses
formes de body, ses sélecteurs de version ou ses codes d'erreur.

Cette skill possède la méthode d'écriture et d'évaluation : les deux lecteurs des descriptions, la
structure du `SKILL.md`, les critères de déclenchement et la comparaison contrôlée avant publication.

## Bibliothèque de méthodes à charger au besoin

Cette bibliothèque sert de point de départ lorsqu'aucune skill de l'organisation ne possède encore
la méthode. Après avoir vérifié les skills existantes, choisis la branche qui correspond au besoin et
lis uniquement le fichier lié. Découvre et décris d'abord l'opération courante de lecture d'un
fichier de package, puis demande le chemin exact indiqué par le lien. Ne charge pas l'index complet
des fichiers ni toute la bibliothèque. Si aucune branche ne correspond, construis la méthode depuis
le besoin observé.

- Revoir un diff ou une pull request : [revue de code](references/code-review.md)
- Rédiger un contenu publiable ou un message marketing : [rédaction de contenu](references/content-writing.md)
- Enrichir un lead ou tenir le pipeline à jour : [mise à jour CRM](references/crm-update.md)
- Qualifier un compte ou préparer une vue prospect : [recherche client](references/customer-research.md)
- Interpréter un tableau ou un export chiffré : [analyse de données](references/data-analysis.md)
- Extraire des champs d'un document : [extraction documentaire](references/doc-extraction.md)
- Trier des emails et préparer des réponses : [réponse email](references/email-reply.md)
- Résumer seulement les changements depuis le dernier passage : [digest incrémental](references/incremental-digest.md)
- Préparer un rendez-vous à partir de plusieurs sources : [préparation de réunion](references/meeting-prep.md)
- Transformer une réunion en décisions et actions : [compte-rendu et actions](references/minutes-actions.md)
- Répondre depuis une base documentaire avec citations : [réponse sourcée](references/sourced-rag.md)
- Rechercher sur le web avec des sources vérifiables : [recherche web sourcée](references/sourced-research.md)
- Produire un état d'avancement depuis des tickets et changements : [rapport de sprint](references/sprint-report.md)
- Classer des demandes entrantes et décider d'une escalade : [triage et sentiment](references/triage-sentiment.md)

Une référence est du matériau d'authoring, pas une skill attachable. Adapte son contenu au contexte de
l'organisation, retire les hypothèses qui ne sont pas satisfaites, ajoute le déclenchement exigé plus
bas, puis matérialise une skill sous le scope de l'organisation. La référence ne devient jamais une
dépendance de l'agent.

## Processus

### 1. Choisir entre création et amélioration

Cherche une skill de l'organisation qui possède déjà le même besoin conceptuel. Lis les candidates
ambiguës avant de trancher.

- Améliore l'existante quand son intention et sa frontière correspondent.
- Crée une nouvelle skill seulement quand aucune méthode n'a le même propriétaire conceptuel.
- Garde le nom stable pendant une amélioration. Un défaut ne justifie pas un suffixe ou un doublon.

Si aucune skill existante ne convient, consulte ensuite une seule branche pertinente de la
bibliothèque ci-dessus. Une référence accélère la création, mais l'objectif réel, les accès
disponibles et les cas observés restent la source de vérité.

Avant de modifier une skill, découvre les opérations courantes qui permettent de lire son draft, ses
versions publiées et les fichiers du package. Lis tous les fichiers pertinents, pas seulement le
contenu principal. Identifie la base publiée, les changements déjà présents dans le draft et le
mécanisme de concurrence demandé par l'opération de mise à jour.

Cette étape est terminée lorsque tu peux nommer la règle défaillante, sa source actuelle et les
consommateurs affectés.

### 2. Garder uniquement la méthode

Écris les critères, heuristiques, arbitrages, étapes métier, cas limites et formes de restitution qui
resserviraient dans plusieurs agents.

Écarte les connecteurs, canaux, identifiants, fréquences, limites de volume et correspondances de
champs propres à une instance. `@appstrate/agent-authoring` possède ces décisions.

Quand la méthode suppose une capacité de runtime, exprime le besoin sémantique et son comportement de
repli, par exemple conserver un état durable entre deux passages ou publier un document. L'agent
traduira ce besoin avec les capacités que son schéma courant expose.

### 3. Écrire pour les deux lecteurs

Une skill créée dans l'organisation présente deux descriptions qui provoquent deux décisions
différentes :

- `manifest.description` est lue par le chat qui choisit une dépendance pour un agent. Décris le
  besoin couvert, la frontière avec les méthodes voisines et le geste de sélection attendu.
- la `description` du frontmatter du `SKILL.md` est lue par l'agent au runtime. Décris les situations
  où l'agent doit ouvrir cette méthode pour exécuter sa tâche.

Écris-les séparément. Le corps ne peut pas réparer une description qui déclenche le mauvais geste.

Le frontmatter contient au minimum le nom non scopé de la skill et sa description destinée à l'agent.
Le nom doit correspondre au dernier segment du package matérialisé par le runtime.

### 4. Écrire une méthode exécutable

Organise le corps dans l'ordre où l'agent doit travailler :

1. objectif concret ;
2. étapes avec une condition de fin observable ;
3. prérequis sémantiques que l'agent devra satisfaire ;
4. règles et cas limites au point où ils deviennent utiles ;
5. exemple ou schéma seulement s'il change le comportement.

Garde dans le fichier principal ce qui est requis à chaque exécution. Place une référence volumineuse
ou une variante rare dans un fichier séparé seulement si elle fait partie du package et si le corps
indique précisément quand la lire.

Formule le comportement cible positivement. Lorsqu'un garde-fou est indispensable, place l'issue de
secours autorisée dans la même règle. Exige des critères vérifiables et exhaustifs plutôt que des
adverbes comme « soigneusement » ou « correctement ».

Supprime les conseils que le modèle applique déjà, les branches périmées et les reformulations d'une
même règle. Lors d'une amélioration, change la plus petite surface qui explique l'échec observé et
préserve le reste.

### 5. Vérifier le déclenchement

Écris deux requêtes réalistes qui doivent sélectionner la skill et un quasi-cas qui partage son
vocabulaire sans demander la même méthode. Conserve ces trois cas dans une section `Déclenchement` du
`SKILL.md` afin qu'ils restent versionnés avec l'artefact.

Dans des conversations vierges, vérifie que les cas positifs chargent la skill et que le quasi-cas ne
la charge pas. Si la sélection est mauvaise, corrige les descriptions. Si la sélection est bonne mais
l'exécution échoue, corrige le corps.

Une vérification où la méthode ou le résultat attendu était déjà présent dans le contexte ne prouve
pas le déclenchement.

## Boucle d'amélioration

Applique cette boucle avant de proposer la publication d'une modification :

1. **Reproduire.** Choisis les cas qui exposent le défaut et définis le signal attendu avant de
   modifier le draft.
2. **Modifier.** Mets à jour le draft complet avec le mécanisme de concurrence décrit par l'opération
   courante. Si le draft a changé, relis et réapplique la modification au lieu d'écraser le travail
   concurrent.
3. **Comparer.** Lance deux runs adjacents avec le même agent de test, le même prompt, la même entrée
   et la même configuration. Seule la sélection de cette dépendance change : version publiée dans le
   premier run, draft dans le second. Utilise le mécanisme de sélection propre au run que l'outil MCP
   décrit au moment du test.
4. **Observer.** Lis les ressources et logs des deux runs. Vérifie dans leur snapshot de dépendances
   résolues que chacun a réellement chargé la variante annoncée. Compare ensuite le résultat, les
   erreurs, les reprises, le coût et chaque critère défini avant la modification.
5. **Décider.** Garde le draft seulement s'il améliore les cas positifs sans déclencher le quasi-cas
   ni dégrader une contrainte existante.

Lorsqu'aucune version publiée n'existe, compare un run sans la nouvelle skill au même run avec le
draft. Une sélection demandée dans les arguments mais absente du snapshot résolu ne constitue pas une
preuve.

Présente les ids des runs, les différences observées et les incertitudes. Une exécution réussie ne
publie jamais automatiquement la méthode. La publication reste une décision humaine séparée.

## Contrôle final

Considère le draft prêt à être proposé seulement si :

- aucune skill existante ne possède déjà le même besoin, ou l'existante a été améliorée ;
- tous les fichiers pertinents et la base publiée ont été lus ;
- chaque instruction appartient à la méthode, pas à une instance d'agent ;
- les deux descriptions provoquent le bon geste chez leur lecteur ;
- chaque étape possède une condition de fin observable ;
- les prérequis sont exprimés comme besoins sémantiques avec un repli ;
- deux cas positifs et un quasi-cas ont été vérifiés dans des contextes vierges ;
- en amélioration, la comparaison ne change qu'une dépendance et les snapshots résolus prouvent la
  sélection ;
- chaque ligne restante change une décision ou une action de l'agent.

Si l'une de ces preuves manque, garde le draft non publié et nomme la vérification restante.
