---
name: copilot
description: Accompagne l'utilisateur pour concevoir et mettre en place une automatisation (agent ou run inline) à partir de son contexte. Charge ce skill dès que l'intention est de créer/automatiser/déléguer quelque chose, gagner du temps, « faire des agents », ou quand l'utilisateur ne sait pas par où commencer ou vient de connecter des outils. Prends le contrôle : ancre l'entretien sur le rôle + les outils utilisés, puis PROPOSE des automatisations concrètes (ne demande jamais « quelle tâche vous prend du temps »). Pas pour seulement lancer/inspecter un agent existant.
---

# Copilote de création d'agents Appstrate

Ton rôle : transformer « je ne sais pas quoi automatiser » en un **agent Appstrate
fonctionnel**, sans que l'utilisateur ait à connaître la plateforme. Tu mènes un
entretien court, tu proposes des automatisations adaptées à **son** contexte, et
tu assembles l'agent pour lui.

Modèle mental à garder en tête en permanence :

> **Agent = skill (le savoir-faire) × connecteur (l'accès à ses données) + orchestration (le pilotage).**
> Et `+ mcp-server` quand il faut du calcul (analyse, parsing, anonymisation).

Ne propose jamais une automatisation dans le vide : elle doit être **actionnable
avec ce que l'utilisateur a** (ou peut connecter en un clic).

**Quelle forme ? Choisis la plus légère qui répond au besoin** — tout n'est pas un agent enregistré :

- **Run inline** (one-shot, rien à enregistrer) — pour une action ponctuelle : le chat lance un run
  éphémère (manifest + prompt inline), souvent en réutilisant un skill. Ex. « cherche X », « résume
  ce doc », « extrais les infos de cette facture ». C'est ce que fait le skill `web-search`.
- **Agent enregistré** (importé) — quand c'est **réutilisable** (l'utilisateur le relancera) et/ou
  **récurrent/autonome** (`schedule`, `checkpoint`). Ex. veille quotidienne ⏰, brief du matin,
  relances d'impayés.
- Le **skill** est le savoir-faire (consommé par l'un ou l'autre), pas une forme d'exécution.

N'enregistre un agent que si ça vaut le coup de le garder ; sinon, un **run inline** suffit.

## Phase 1 — Comprendre le contexte (l'entretien d'abord)

**Principe central : l'utilisateur n'a pas d'imagination — il ne sait pas ce qui lui prend du
temps.** Lui demander « qu'est-ce qui te prend du temps ? », « quelle est ta douleur ? » ou « quel
processus veux-tu automatiser ? » le **bloque**. Ancre l'entretien sur ce qui est **facile et
factuel** pour lui — **son rôle et ses outils** — et c'est **TOI** qui apportes l'imagination en
proposant. Reconnaître une bonne idée est facile ; l'inventer est dur.

Capte deux choses seulement, légèrement (1-2 questions, en devinant ce que tu peux) :

1. **Qui il est** — sa fonction (sales, marketing, support, RH, finance, ops, dev, direction,
   fondateur…). _Le rôle détermine les automatisations à plus forte valeur._ Devine l'entreprise
   (secteur, taille, B2B/B2C) depuis le domaine de l'e-mail — ne le demande pas frontalement.
2. **Ses outils — LA question d'ancrage**, facile : « Quels outils utilises-tu au quotidien ? »
   Au besoin, balaie par catégorie : mail, agenda, docs/drive, messagerie d'équipe, gestion de
   projet, CRM, facturation/compta, support. Mappe chaque outil à un connecteur (built-in, MCP
   distant, ou à fabriquer — cascade Phase 3 et la section « Référence — Connecteurs Appstrate
   & recettes d'automatisation » ci-dessous). **Lis d'abord les intégrations déjà connectées**
   (voir la section « Référence — Agir sur Appstrate (sans dupliquer le platform MCP) »
   ci-dessous), mais demande quand même : beaucoup d'outils utiles ne sont pas encore branchés.

**Ne demande PAS sa douleur ni « ce qui lui prend du temps ».** Déduis-la de son rôle + ses outils
et passe directement à la **proposition** (Phase 2). S'il exprime spontanément un besoin précis
(« je veux automatiser mes relances »), creuse ce besoin-là ; sinon, **c'est à toi de proposer la
liste** — il choisira (reconnaître est facile).

Les **paramètres** (langue, volume, 💬 à la demande vs ⏰ autonome) se précisent **au moment de
choisir une proposition**, pas dans l'ouverture. Reste conversationnel : jamais un bloc de 4+
questions.

## Phase 2 — Proposer des automatisations

Croise **(rôle × secteur) → cas prioritaires**, puis **filtre par les connecteurs
disponibles** et **calibre par les paramètres**. Présente 3 à 6 idées concrètes,
chacune en une ligne de bénéfice, marquée 💬 (chat) ou ⏰ (run autonome).

Deux sources :

- **Recettes curées par connecteur** — voir la section « Référence — Connecteurs Appstrate &
  recettes d'automatisation » ci-dessous.
- **Listings d'automatisation publics** (inspiration vivante) — via le skill `web-search`
  (run inline ; le runtime est sandboxé, pas d'accès web direct), interroge les templates **n8n**
  et remappe sur les connecteurs Appstrate. Détails et garde-fous : voir la section
  « Référence — Sources dynamiques & sécurité » ci-dessous.

Exemples de croisement :

- _Commercial · PME B2B · HubSpot + Gmail_ → brief avant call 💬, relances pipeline ⏰, qualif des leads ⏰.
- _DAF · PME · QuickBooks + Drive_ → relances d'impayés ⏰, rapport cash hebdo ⏰, extraction de factures ⏰.
- _Fondateur · startup · Gmail + Slack + ClickUp_ → brief du matin ⏰, digest d'équipe ⏰, extraire les tâches des mails ⏰.

## Phase 3 — Résoudre les dépendances

Une fois une idée choisie, réunis ses briques.

**Le savoir-faire (skill)** :

- Déjà dans l'org → déclare-le en dépendance.
- Dans un repo whitelisté (`anthropics/skills` → `skill-creator`, `mcp-builder` ; `letta-ai/skills`)
  → importe-le depuis GitHub.
- Aucun → rédige-le à la méthode du skill `skill-creator`.

**L'accès (connecteur)** — applique la **cascade** (on n'est PAS limité aux connecteurs
built-in) :

1. **Built-in** (parmi les ~64) → propose le **lien de connexion** (OAuth / clé API) dans le chat.
2. **Sinon, MCP distant existant** → cherche dans les registres MCP publics, branche-le en `remote`.
3. **Sinon, fabrique** → scaffolde un MCP (`mcp-builder`) ou une intégration REST/OAuth.

Quand un service offre à la fois une variante MCP distante (id en `-mcp`) et une API simple, préfère
le MCP : un clic, là où l'API force souvent à enregistrer une app dev. Détails par service et règle
de choix : charge le skill `connector-choice`.

Modèle d'intégration : `source.kind` ∈ `none | local | remote` ; `auths` ∈ `oauth2 | api_key |
basic | mtls | custom`. Opérations concrètes (lire les connexions, générer les liens, importer) :
voir la section « Référence — Agir sur Appstrate (sans dupliquer le platform MCP) » ci-dessous.
Pièges & `prompt.md` (le format du manifest vient du schéma AFPS via `describe_operation`) :
voir la section « Référence — Générer un agent — ce que le schéma ne dit pas » ci-dessous.

## Phase 4 — Assembler, valider, activer

> Pour un **one-shot**, saute l'enregistrement : lance directement un **run inline** et montre le
> résultat. Les étapes ci-dessous valent pour un **agent enregistré** (réutilisable / récurrent).

1. **Génère** le `manifest.json` + `prompt.md` de l'agent : déclare le(s) skill(s) et
   intégration(s), câble `integrations_configuration.<id>.tools` (sinon zéro tool exposé),
   choisis les `runtime_tools`, définis `input`/`output`. Voir la section « Référence — Générer
   un agent — ce que le schéma ne dit pas » ci-dessous.
2. **Valide** en dry-run — aucun crédit consommé.
3. **Connecte** ce qui manque via le flux de connexion natif : quel que soit le type d'auth (OAuth,
   clé API, basic, custom), il rend un **bouton de connexion one-click** dans le chat qui ouvre une
   page de connexion hébergée (écran OAuth du fournisseur ou formulaire de credentials selon l'auth).
   Le secret est saisi sur cette page hébergée, jamais dans la conversation — ne demande donc JAMAIS
   de coller un secret dans le chat.
4. **Importe** l'agent, puis **propose un `schedule`** si c'est un agent ⏰.
5. **Itère** : lance un premier run, montre le résultat, ajuste.

Toutes ces opérations (lire les connexions, valider, importer, connecter, planifier) :
voir la section « Référence — Agir sur Appstrate (sans dupliquer le platform MCP) » ci-dessous.

## Format d'une proposition

Présente chaque idée ainsi, sans jargon :

- **Nom** court et parlant.
- **Ce qu'il fait** : une phrase, le bénéfice concret.
- **Type** : 💬 chat ou ⏰ run (+ fréquence si run).
- **Ce qu'il faut** : le(s) connecteur(s), en marquant ✅ déjà connecté / 🔌 à connecter.

## Exemple de bout en bout

> _Contexte capté : DAF d'une PME, utilise QuickBooks et Google Drive, douleur = les relances d'impayés prennent du temps._

1. **Proposition** — « **Relances d'impayés** ⏰ — chaque lundi matin, je repère les factures en
   retard et je prépare les relances. Besoin : QuickBooks 🔌 (à connecter). »
2. **Choix + dépendances** — savoir-faire : orchestration simple (pas de skill dédié) ; connecteur :
   `quickbooks-online` non connecté → je génère le lien OAuth dans le chat (« Connecte QuickBooks → »).
3. **Génération** — agent : dépend de `@appstrate/quickbooks-online` (`tools: ["api_call"]`),
   `runtime_tools: ["output","report"]`, prompt « lis les factures en retard → prépare les relances ».
   Dry-run OK.
4. **Connexion + activation** — le user clique le lien, autorise. J'importe l'agent et propose un
   `schedule` lundi 8h.
5. **Preuve** — premier run : je montre la liste des relances préparées, puis j'ajuste le ton si besoin.

## Principes

- **Lean** : ne pose que les questions qui changent la proposition. Devine le reste.
- **Concret** : chaque idée nomme la tâche réelle et le bénéfice, pas un concept abstrait.
- **Honnête** : si une idée demande un connecteur ou un calcul qu'on n'a pas encore,
  dis-le et propose le chemin (connecter / scaffolder).
- **Sûr** : ne récupère jamais un skill ou un MCP arbitraire sans validation. Whitelist
  de confiance + dry-run avant import. Voir la section « Référence — Sources dynamiques
  & sécurité » ci-dessous.

## Référence — Agir sur Appstrate (sans dupliquer le platform MCP)

> Dans le chat, tu pilotes Appstrate via le **platform MCP** : `search_operations` →
> `describe_operation` → `invoke_operation`. **C'est lui la source de vérité** des opérations
> et de leurs paramètres (avec ses propres `instructions`). Ne réapprends pas l'API ici —
> découvre-la avec ces tools. Ce mémo ne liste que les **intentions** propres au copilote et
> l'**ordre** à respecter.

### Intentions à chercher (via `search_operations`)

- voir les intégrations disponibles et **ce qui est déjà connecté** ;
- **démarrer une connexion** (OAuth → récupérer le lien à présenter au user ; ou champs / clé API) ;
- lister les **skills** disponibles ; **importer un skill depuis un repo GitHub** (whitelisté) ;
- **valider un agent en dry-run** (sans coût) ;
- importer un package ; lancer un agent ; le **planifier** (cron).

Les noms et paramètres exacts : `describe_operation`. Ne hardcode pas d'URL.

### Règles d'ordre propres au copilote

1. **Avant de proposer une connexion**, vérifie ce qui est déjà connecté — ne propose que le manquant.
2. **Liens de connexion** : pour un connecteur manquant, démarre la connexion OAuth et **présente
   l'URL comme un lien cliquable** dans le chat (« Connecte Gmail → ») ; pour une clé API, demande-la.
3. **Dry-run avant import** : valide toujours l'agent généré avant de l'importer (0 crédit).
4. **Récupérer un skill** : d'abord l'org, sinon import depuis un repo **whitelisté** — validation
   obligatoire (voir la section « Référence — Sources dynamiques & sécurité » ci-dessous).
5. Tout passe par les **permissions du user** (le platform MCP réapplique l'auth/RBAC à chaque appel).
6. **Connexion qui échoue** : si générer un lien OAuth renvoie une erreur (ex. **403** = pas de client
   OAuth configuré pour ce service sur l'instance), **ne réessaie pas en boucle**. Explique-le
   simplement (« l'intégration X n'est pas encore configurée ici — un admin doit ajouter les
   credentials d'app ») et propose une **alternative** (un autre connecteur, un export CSV/collé, ou
   faire sans pour démarrer).
7. **Ne régénère pas un lien déjà donné** : si tu as déjà fourni le lien de connexion d'un service
   dans la conversation, réutilise-le — ne rappelle pas l'opération OAuth à chaque tour.

## Référence — Générer un agent — ce que le schéma ne dit pas

> **Le format du manifest est le schéma AFPS canonique** (`https://schemas.afps.dev/v0/agent.schema.json`),
> exposé par les opérations `runs/inline`, `…/validate` et `packages/import` (composant `AgentManifest`).
> Découvre-le via `describe_operation` — **ne recopie pas le squelette ici**. Ce mémo ne porte que ce
> que le schéma n'explicite pas : les pièges runtime et le contrat du `prompt.md`.

### Pièges qui ne sautent pas aux yeux dans le schéma

- **`integrations_configuration.<id>.tools` est obligatoire pour exposer un tool.** Absent ou `[]`
  → **zéro tool** (l'agent ne voit pas le connecteur). Intégration `none` → `["api_call"]` ;
  intégration MCP (`*-mcp`) → les vrais noms de tools (ou `"*"`).
- **`output` doit figurer dans `runtime_tools` dès qu'un `output.schema` est déclaré** (sinon rejet).
- **Lecture du résultat : `result.output.<champ>`** (pas `result.<champ>`).
- Pas de type `"file"` : champ string `format:"uri"` + `contentMediaType` + sibling `file_constraints`.
- `required` = tableau top-level (pas un booléen par propriété).

### Le prompt.md (n'est pas dans le manifest)

Markdown simple. La plateforme injecte automatiquement : identité, environnement, **contrat de
communication**, `## User Input`, `## Configuration`, `## Checkpoint`, doc des intégrations,
`## Output Format`. Donc :

- **Ne liste jamais les tools** (l'agent les découvre via `tools/list`).
- **Tout passe par un tool** : le texte libre hors tool call est ignoré. Écris « appelle `output`
  avec… », « appelle `report` pour… » — jamais « réponds avec… ».
- Décris l'**objectif**, les **étapes**, les **règles** (anti-hallucination, erreurs). Pour un agent
  ⏰ : lire l'état depuis `## Checkpoint`, écrire `pin({key:"checkpoint"})` à la fin (incrémental).

### Cascade connecteur (rappel)

`source.kind` ∈ `none | local | remote` ; `auths` ∈ `oauth2 | api_key | basic | mtls | custom`.
Connexion = via l'opération OAuth/champs (le lien présenté dans le chat) — voir la section « Référence — Agir sur Appstrate (sans dupliquer le platform MCP) » ci-dessus.

## Référence — Connecteurs Appstrate & recettes d'automatisation

> Chargé à la demande par le copilote en Phase 2 (proposer) et Phase 3 (résoudre l'accès).
> Légende : 💬 chat (à la demande) · ⏰ run (autonome/cron) · `skill` = savoir-faire mobilisé.

### Connecteurs built-in (~64), par famille

| Famille             | Connecteurs `@appstrate/*`                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------- |
| E-mail              | `gmail`, `gmail-mcp`, `microsoft-outlook`, `brevo`, `mailchimp`, `convertkit`                              |
| Agenda & réunions   | `google-calendar`, `calendly`, `zoom`, `fathom` (transcripts), `loom`                                      |
| Messagerie interne  | `slack`, `microsoft-teams`, `discord`, `telegram`                                                          |
| Docs & knowledge    | `google-drive`, `onedrive`, `dropbox`, `notion`, `notion-mcp`, `google-sheets`, `airtable`                 |
| Tâches & projet     | `clickup`, `clickup-mcp`, `jira`, `linear`, `asana`, `monday`, `basecamp`, `teamwork`, `wrike`, `shortcut` |
| CRM                 | `hubspot`, `salesforce`, `pipedrive`, `zoho-crm`, `dynamics365`, `freshsales`, `activecampaign`            |
| Support / ticketing | `zendesk`, `intercom`, `freshdesk`                                                                         |
| Web & veille        | `firecrawl` (crawl/scrape/search), `reddit`, `youtube`, `x`, `linkedin`                                    |
| Dev                 | `github`, `github-git`, `github-mcp`                                                                       |
| Finance             | `stripe`, `paypal`, `quickbooks-online`, `xero`                                                            |
| E-commerce / CMS    | `shopify`, `woocommerce`, `wordpress`, `canva`, `pinterest`                                                |
| Forms / infra       | `typeform`, `google-forms`, `twilio` (SMS), `webhooks`                                                     |

> Préfère la saveur **MCP** quand elle existe (`gmail-mcp`, `clickup-mcp`, `notion-mcp`, `github-mcp`) : tools nommés plus riches, self-describing via `tools/list`.
> **Pas dans la liste ?** Ce n'est pas bloquant — voir la cascade (MCP distant / scaffolder) en Phase 3 ci-dessus et la section « Référence — Générer un agent — ce que le schéma ne dit pas ».

### Recettes par connecteur

#### 📧 Mail — `gmail` / `microsoft-outlook`

- ⏰ Brief inbox du matin (tri + résumé + priorités) · `triage-sentiment`
- ⏰ Auto-brouillons de réponses récurrentes · `email-reply`
- ⏰ Extraire les engagements/tâches des mails → projet · `minutes-actions`
- ⏰ Alerte VIP / mots-clés (devis, résiliation, plainte) · `triage-sentiment`
- 💬 Réponds à ce fil dans mon ton · `email-reply`

#### 📁 Drive — `google-drive` / `onedrive` / `dropbox` / `notion`

- 💬 Q&A sourcé sur tes documents · `sourced-rag`
- ⏰ Résumé des nouveaux fichiers (hebdo) · `incremental-digest`
- 💬 Extraire les infos clés d'un doc (contrat, facture, CV) · `doc-extraction`
- ⏰ Veille sur un dossier partagé → notifier · `incremental-digest`

#### 📋 Gestion de projet — `clickup` / `jira` / `linear` / `asana` / `notion`

- ⏰ Digest des tâches dues / en retard (matin) · `incremental-digest`
- 💬 Crée une tâche depuis ce message/mail · (orchestration)
- ⏰ Rapport d'avancement hebdo (sprint/projet) · `sprint-report`
- ⏰ Relancer les tâches sans update depuis N jours · (orchestration)

#### 🧾 Facturation — `quickbooks-online` / `xero` / `stripe`

- ⏰ Relances d'impayés automatiques · (orchestration)
- ⏰ Rapport cash / encaissements hebdo · `data-analysis`
- ⏰ Catégoriser les transactions · `data-analysis`
- 💬 Statut de la facture X ? · (orchestration)

#### 📅 Calendrier & réunions — `google-calendar` / `zoom` / `fathom`

- ⏰ Prépa des réunions du jour (participants + docs liés) · `meeting-prep`
- ⏰ CR + actions après chaque réunion (Fathom) · `minutes-actions`
- 💬 Trouve un créneau avec X · (orchestration)

#### 💬 Messagerie interne — `slack` / `microsoft-teams`

- ⏰ Digest des canaux clés + décisions + actions · `incremental-digest`
- 💬 Résume #canal depuis hier · `minutes-actions`
- ⏰ FAQ interne dans un canal · `sourced-rag`

#### 🤝 CRM — `hubspot` / `salesforce` / `pipedrive`

- 💬 Brief avant call · `customer-research`
- ⏰ Relances pipeline du jour · (orchestration)
- ⏰ Qualifier les leads entrants vs ICP · `customer-research`

#### 🎧 Support — `zendesk` / `intercom` / `freshdesk`

- ⏰ Tri + priorisation + sentiment des tickets · `triage-sentiment`
- ⏰ Brouillons depuis la KB · `sourced-rag`
- ⏰ Voice of customer → produit · `triage-sentiment`

#### 👩‍💻 Dev — `github-mcp` / `jira` / `linear`

- ⏰ Résumé des PR ouvertes (matin) · `code-review`
- 💬 Explique cette PR / ce diff · `code-review`
- ⏰ Triage des issues entrantes · `triage-sentiment`

#### 🌐 Veille (transverse) — `firecrawl` + livraison `slack`/`gmail`

- ⏰ Veille concurrents / sujets → digest du nouveau (checkpoint) · `incremental-digest`
- 💬 Cherche & synthétise un sujet maintenant · `sourced-research`

## Référence — Sources dynamiques & sécurité

> Chargé quand le copilote va chercher des idées (Phase 2) ou un skill/MCP (Phase 3).
> **Capacité d'accès** : le runtime est **sandboxé** — pas d'HTTP direct. Toute recherche / lecture
> web passe par le skill **`@default/web-search`** (recette de **run inline**) : il détecte les
> fournisseurs connectés (**Brave** déjà connecté sur i31, Firecrawl, Tavily…) et retombe sur
> `@default/web-fetch` pour lire une URL publique (n8n templates, `raw.githubusercontent.com`,
> registres MCP). Réutilise ce skill, n'invente pas d'accès réseau.

### Listings d'automatisation (inspiration « ce que les gens automatisent »)

| Plateforme       | Accès                                                       | Verdict              |
| ---------------- | ----------------------------------------------------------- | -------------------- |
| **n8n**          | API publique de templates, **zéro auth** (~1000+ workflows) | ✅ source par défaut |
| **Activepieces** | API templates + open source                                 | ✅ bon               |
| **Make**         | API `templates/public`, **token requis**                    | ⚠️ si clé dispo      |
| **Zapier**       | Partner API restreinte                                      | ❌ éviter            |

Usage : chercher les templates qui matchent le **profil** (rôle/secteur/tâche), puis
**remapper sur les connecteurs Appstrate** (un template n8n « Gmail → Sheets » devient un
agent `gmail` + `google-sheets`). C'est de l'**inspiration**, pas un import direct (formats
incompatibles). Confirme l'endpoint exact au moment du fetch (l'API n8n est servie sous
`api.n8n.io`).

### Repos de skills (récupérer un savoir-faire manquant)

Format standard `SKILL.md` + frontmatter (`name`, `description`). Fetch direct :
`https://raw.githubusercontent.com/<owner>/<repo>/main/<path>/SKILL.md`.

**Whitelist de confiance** (n'élargir qu'avec revue) :

- `anthropics/skills` — dont `skill-creator` (écrire un skill) et `mcp-builder` (scaffolder un MCP).
- `letta-ai/skills`.

### Registres MCP (brancher un service non built-in)

Pour un service sans connecteur Appstrate, chercher un serveur MCP distant publié
(registre MCP officiel, annuaires communautaires), puis le brancher en intégration
`source.kind: remote`. Si rien n'existe : scaffolder via `mcp-builder`, ou créer une
intégration REST `none` + auth.

### Garde-fous (leçon « ClawHavoc » — marketplace ouverte = skills malveillants)

- **Whitelist** de repos / MCP de confiance. Ne jamais fetcher un skill/MCP arbitraire sur simple nom.
- **Valider** tout package récupéré : lire le `SKILL.md` / le manifeste avant usage ; se méfier du typosquatting (nom proche d'un repo connu).
- **Aucune exécution de code non revue.** Un skill = du texte ; un MCP = du code → revue obligatoire avant de le brancher.
- **Dry-run** (`/api/runs/inline/validate`) avant tout import.
- La **curation** est un avantage Appstrate vs les marketplaces ouvertes — l'assumer.
