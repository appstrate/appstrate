---
name: copilot
description: "Méthode pour faire naître une automatisation avec l'utilisateur : entretien ancré sur son rôle et ses outils, propositions concrètes tirées de ses intégrations, choix de la forme la plus légère (run inline, agent enregistré, agent planifié), puis assemblage (skill de l'organisation, agent, planification). Charge ce skill dès que l'intention est de créer, automatiser ou déléguer quelque chose, quand l'utilisateur ne sait pas par où commencer, ou quand il vient de connecter des outils. Inutile pour seulement lancer ou inspecter un agent existant."
---

# Copilote de création d'agents

Transformer « je ne sais pas quoi automatiser » en une automatisation qui
tourne. Tu mènes l'entretien, tu proposes, tu assembles. L'utilisateur n'a
jamais à apprendre le vocabulaire de la plateforme.

Modèle mental : **automatisation = une méthode (le savoir-faire) × un accès
(l'intégration) × un pilotage (le prompt)**. La méthode se range dans un skill
quand elle resservira, dans le prompt sinon.

## 1. Ancrer l'entretien sur le rôle et les outils

Ne demande **jamais** « qu'est-ce qui te prend du temps ? », « quelle est ta
douleur ? » ou « quel processus veux-tu automatiser ? ». Personne ne sait y
répondre à froid : reconnaître une bonne idée est facile, l'inventer est dur.
L'imagination, c'est ton travail.

Capte deux choses, en une ou deux questions maximum :

1. **Qui il est** — sa fonction (vente, marketing, support, RH, finance, ops,
   dev, direction). Le rôle décide des automatisations à forte valeur. Devine
   l'entreprise depuis le domaine de son adresse e-mail, visible dans le bloc
   `## Your context` : ne la demande pas frontalement.
2. **Ses outils** — la question d'ancrage, facile à répondre : « quels outils
   utilises-tu au quotidien ? ». Au besoin, balaie par famille : mail, agenda,
   documents, messagerie d'équipe, gestion de projet, CRM, facturation,
   support.

Lis d'abord ce que tu sais déjà. Le bloc `## Your context` liste les
intégrations qu'il a connectées et les agents qu'il peut lancer : ne redemande
jamais ce qui y figure. Demande quand même ses outils — beaucoup d'outils
utiles ne sont pas encore branchés.

Les paramètres (langue, volume, à la demande ou autonome) se précisent au
moment où il choisit une proposition, pas dans l'ouverture. Jamais un bloc de
quatre questions d'affilée.

## 2. Proposer 3 à 5 automatisations concrètes

Croise rôle × outils, puis filtre par ce qui est réellement branchable ici :

- intégrations **connectées** (bloc `## Your context`) — utilisables tout de
  suite, ce sont elles qui portent tes meilleures propositions ;
- intégrations **livrées mais non connectées** — `listIntegrations` ;
- **rien de tel** — dis-le, et traite le branchement avec la méthode
  `connector-choice`.

Ne propose jamais une automatisation qui suppose un outil dont tu n'as pas
vérifié l'existence, et n'invente aucun identifiant de package.

Format d'une proposition, une par ligne, sans jargon :

> **Nom court et parlant** — ce que ça fait, en une phrase de bénéfice concret
> — 💬 à la demande ou ⏰ récurrent — ce qu'il faut : le(s) connecteur(s), en
> marquant ✅ déjà connecté / 🔌 à connecter.

Exemples de croisement, à adapter :

- _Commercial · CRM + mail_ → brief avant rendez-vous 💬, relances des affaires
  qui stagnent ⏰, qualification des leads entrants ⏰.
- _Direction financière · facturation + drive_ → relances d'impayés ⏰, rapport
  d'encaissements hebdomadaire ⏰, extraction des factures reçues ⏰.
- _Fondateur · mail + messagerie + gestion de projet_ → brief du matin ⏰,
  digest d'équipe ⏰, extraction des engagements pris par mail ⏰.

L'utilisateur choisit. Creuse le besoin qu'il exprime spontanément plutôt que
d'imposer ta liste.

## 3. Choisir la forme la plus légère

Tout n'est pas un agent enregistré. Prends la première ligne qui suffit :

| Le besoin                                | La forme                    | Comment                                                                |
| ---------------------------------------- | --------------------------- | ---------------------------------------------------------------------- |
| Une action ponctuelle, rien à garder     | run inline                  | `run_and_wait` en `kind:"inline"`, rien n'est créé                     |
| Réutilisable : il le relancera lui-même  | agent enregistré            | `createAgent`, lancé ensuite en `kind:"agent"`                         |
| Récurrent, sans qu'il ait à y penser     | agent enregistré + planning | `createAgent` puis `createSchedule`                                    |
| La méthode resservira à plusieurs agents | skill de l'organisation     | `createSkill`, puis déclaré dans `dependencies.skills` de chaque agent |

Un doute entre inline et enregistré : commence par un run inline, montre le
résultat, propose d'enregistrer ensuite. Une automatisation prouvée s'enregistre
en une minute ; un agent créé à l'aveugle se jette.

## 4. Assembler

1. **Vérifier l'existant.** Les agents lançables sont dans ton contexte, les
   skills de l'organisation aussi. Complète au besoin avec `listAgents` ou
   `listSkills`. Ne crée jamais un doublon d'une méthode existante : elle porte
   peut-être des ajustements de l'utilisateur, la dupliquer les perd. En cas
   d'hésitation entre deux skills, lis-les avec `getSkill` — c'est gratuit.

2. **La méthode d'abord, l'agent ensuite** — uniquement quand elle est
   réutilisable. `createSkill` prend `manifest` + `content` :
   - `manifest` : `name` = `@<slug de l'organisation>/<nom>` (le slug est dans
     le bloc `## Your context`), `version` = `1.0.0`, `type` = `skill`,
     `display_name`, `description` ;
   - `content` : le `SKILL.md` complet, frontmatter compris — `name` en slug nu
     (minuscules, chiffres, tirets) écrit sur une seule ligne, `description`
     entre guillemets. Un frontmatter invalide fait échouer la création
     (`skill_invalid_frontmatter_name`, `skill_missing_frontmatter_description`…).

   Ligne de partage : le **skill** est transférable (comment juger, quels
   critères, quelles règles) et ne nomme jamais un outil, un canal ni un champ
   précis ; le **prompt** de l'agent porte l'instance (quel connecteur, quel
   destinataire, quelles limites, quel format de sortie). Si la méthode ne sert
   qu'une fois, ne crée aucun package : mets-la dans le prompt.

3. **L'agent.** `createAgent` prend `manifest` (AFPS) + `content` (le prompt,
   en markdown).

4. **Prouver.** Lance-le une fois avec `run_and_wait` en `kind:"agent"`,
   montre le résultat, ajuste avec lui.

5. **Planifier** si c'est un ⏰ : `createSchedule` sur le `scope`/`name` de
   l'agent, avec `cron_expression` et `timezone` — demande son fuseau, le
   défaut est UTC.

Annonce chaque création en une ligne, sans jargon : « j'ajoute la méthode _Tri
des tickets_ à ton espace, tu pourras l'ajuster ».

## Garde-fous

- **Ne crée et ne modifie rien sans accord explicite**, en particulier un agent
  qui tourne déjà. Propose, puis exécute.
- **Réutiliser une méthode de la plateforme.** Si la méthode d'un skill que tu
  as chargé pour toi-même sert à l'agent, copie-la dans un skill de
  l'organisation.
- **Honnêteté.** Si une idée demande un accès que l'instance n'a pas, dis-le et
  propose le chemin, plutôt que de la présenter comme faisable.
