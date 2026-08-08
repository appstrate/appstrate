---
name: agent-authoring
description: Assembler, modifier ou valider un agent enregistré Appstrate. Charge ce guide après avoir choisi cette forme et avant toute mutation du package agent. Il résout les dépendances, sépare méthode et instance, applique le minimum de privilèges et exige un run réel comme preuve. Il délègue le contenu d'une méthode à skill-authoring et relit toujours les contrats courants depuis le MCP.
---

# Créer ou améliorer un agent Appstrate

Utilise ce guide lorsqu'une automatisation doit devenir un agent enregistré ou lorsqu'un agent
existant doit changer. Pour une action ponctuelle, reste sur un run inline et ne crée aucun package.

Le résultat attendu n'est pas un manifest plausible. C'est un agent que l'organisation possède,
dont les dépendances sont lisibles, les permissions proportionnées et le comportement prouvé par un
run réel.

## Source de vérité

Les opérations et leurs schémas appartiennent au MCP Appstrate. Avant chaque lecture, validation ou
mutation, découvre l'opération adaptée puis lis sa description courante. Construis les arguments
contre ce contrat reçu pendant ce tour.

Ne conserve pas dans ton raisonnement un ancien squelette, une liste de champs ou un exemple de body.
Une validation passée ne prouve pas non plus qu'un autre body respecte le contrat courant.

Ce guide possède seulement les décisions que le schéma ne peut pas prendre : quel artefact porte une
règle, quelle dépendance réutiliser, quel niveau d'accès accorder et quelle preuve clôt le travail.

## Processus

### 1. Fixer le résultat et l'état de départ

Nomme le résultat observable, la source, la destination, le mode de déclenchement et les limites qui
changent réellement le comportement. Déduis ce qui est déjà visible dans le contexte et ne redemande
que l'information qui bloque une décision.

Fixe aussi l'identifiant canonique exact du package cible, scope et nom compris. Conserve-le comme
invariant pendant tout le processus : une lecture, une vérification de collision ou une mutation qui
vise un autre identifiant ne prouve rien sur la cible. Juste avant une création, relis l'identifiant
exact avec l'opération courante. S'il existe déjà, arrête la création et décide explicitement entre
mise à jour et abandon selon l'intention de l'utilisateur. N'emprunte jamais le nom d'un package voisin
ou cité plus tôt dans la conversation.

Pour une modification, lis d'abord l'agent courant et les versions pertinentes avec les opérations
que le MCP expose maintenant. Identifie la règle défaillante et son propriétaire avant d'écrire. Une
modification est prête à commencer lorsque tu peux dire si le défaut vient de la méthode, de
l'instance, de l'accès ou de l'orchestration.

### 2. Résoudre la méthode sans la dupliquer

Cherche d'abord une skill de l'organisation qui possède déjà le besoin conceptuel. Lis les candidates
ambiguës et réutilise celle qui correspond, même si son nom diffère de ton premier choix.

- Si la méthode convient, déclare cette dépendance.
- Si elle possède le bon besoin mais doit être corrigée, charge `@appstrate/skill-authoring` et
  améliore cette skill. Ne crée pas une variante concurrente.
- Si une méthode système de référence convient et qu'aucune copie n'existe dans l'organisation,
  matérialise-la sous le scope de l'organisation avant de l'utiliser.
- Si aucune méthode ne convient, charge `@appstrate/skill-authoring` et crée celle de l'organisation
  avant l'agent.

Une assistant skill système est un guide ou une référence du chat, pas une dépendance à attacher telle
quelle. Cette étape est terminée lorsque chaque savoir-faire réutilisable pointe vers un package que
l'organisation peut lire, versionner et améliorer.

### 3. Donner un seul propriétaire à chaque instruction

Applique cette frontière :

- la **skill** possède la méthode réutilisable, notamment les critères, heuristiques, arbitrages,
  étapes métier, cas limites et forme de restitution ;
- le **prompt de l'agent** possède l'instance, notamment les sources et destinations choisies,
  correspondances de champs, fréquence, volumes et limites propres à ce déploiement.

Quand une instruction resservirait telle quelle dans un autre agent de l'organisation, elle appartient
à la skill. Sinon, elle appartient au prompt. Ne recopie jamais la méthode dans le prompt pour éviter
de créer sa dépendance.

Une méthode peut déclarer des besoins sémantiques de runtime, par exemple conserver un état entre deux
passages ou publier un document. Traduis ces besoins avec les capacités que le schéma courant expose au
moment d'assembler l'agent. La skill exprime le besoin, l'agent réalise le contrat.

### 4. Résoudre l'accès au moindre privilège

Préfère une intégration déjà connectée qui couvre le besoin. Si plusieurs formes d'accès sont
possibles, charge `@appstrate/connector-choice` avant de choisir.

Lis le détail courant de chaque intégration retenue afin de connaître ses capacités effectives et ses
valeurs par défaut. Sélectionne seulement les outils et permissions nécessaires au scénario prouvé.
Une dépendance d'intégration sans capacité utilisable est un défaut à corriger avant la validation.

Présente le flux de connexion natif quand un accès manque. Les secrets se saisissent dans ce flux,
jamais dans la conversation ou dans le prompt de l'agent.

### 5. Construire contre le contrat courant

Découvre et décris les opérations de validation et de persistance disponibles pour un agent, puis
construis le manifest et le prompt selon les schémas renvoyés.

Le prompt décrit l'objectif concret de cette instance, son trajet de données, ses limites et la
condition de fin. Il ne recopie ni le schéma des outils, ni la méthode déjà portée par une skill. Les
dépendances et capacités requises restent déclarées dans le manifest selon le contrat courant.

Pour une mise à jour, préserve les parties non concernées et respecte le mécanisme de concurrence
exposé par l'opération. Si l'état a changé depuis ta lecture, relis puis réapplique la modification au
lieu d'écraser le travail concurrent.

### 6. Valider avant de persister

Valide l'artefact complet avant toute création ou mise à jour persistée. En cas d'erreur, relis le
contrat courant, corrige la cause précise et revalide. Une suite de tentatives qui change plusieurs
variables à la fois ne permet pas de savoir quelle règle était fausse.

Persiste seulement l'artefact valide. Relis ensuite l'agent enregistré et vérifie que ses dépendances,
son prompt et ses paramètres correspondent à ce qui vient d'être validé. Cette relecture doit viser
le même identifiant canonique que la vérification préalable et la mutation.

### 7. Prouver le comportement

Lance un premier run avec une entrée réaliste et le niveau d'accès prévu. Attends son état terminal,
puis inspecte la ressource du run et ses logs avec les opérations courantes.

Vérifie au minimum :

- que les dépendances effectivement résolues correspondent aux versions attendues ;
- que la méthode pertinente a été chargée et appliquée ;
- que seules les capacités nécessaires ont été utilisées ;
- que la sortie satisfait chaque critère observable annoncé ;
- qu'aucune action externe irréversible n'a dépassé l'autorisation donnée.

Un dry-run prouve la forme, pas le comportement. Une réponse du modèle qui affirme avoir réussi ne
remplace ni l'état persisté ni les logs. Active un déclenchement récurrent seulement après ce premier
run et après accord de l'utilisateur sur le rythme et les effets.

## Contrôle final

Considère l'agent prêt seulement si :

- la forme enregistrée est justifiée face au run inline ;
- chaque règle possède un seul artefact ;
- les skills déclarées appartiennent à l'organisation et il n'existe aucun doublon conceptuel ;
- les intégrations et permissions sont minimales pour le scénario ;
- le manifest a été construit et validé contre les contrats MCP lus pendant ce tour ;
- l'état persisté a été relu après la mutation ;
- un run réel a atteint un état terminal et ses logs prouvent le résultat ;
- les dépendances réellement résolues correspondent à celles annoncées.

Si une preuve manque, présente l'agent comme un draft à vérifier et nomme précisément la preuve
restante.
