# Modèles — configurations et connexions

Statut : **plan, rien d'exécuté.** Base lue : `origin/main` @ `5033c5da1` (2026-11-28).
Origine : échange avec Olivier — unifier clés d'org et clés perso, dissocier « clé » et connexion,
unifier la sélection d'un modèle.
Lecture de code seule : rien n'a été mesuré en prod, l'interface n'a pas été ouverte.

## 1. Constat

Trois tables portent le sujet (`packages/db/src/schema/organizations.ts`) :

- `model_provider_credentials` — une ligne par clé. `owner_user_id NULL` = clé d'org, renseigné =
  clé perso. Clé API et abonnement OAuth au même endroit. Porte aussi `base_url_override`.
- `org_models` — une ligne par modèle. `credential_id` renseigné = modèle lié à UNE clé d'org ;
  `NULL` = « chacun sa clé perso ». Deux index uniques partiels selon le cas.
- `model_provider_pairings` — jetons d'appairage pour les abonnements.

Ce qui en découle :

| Symptôme                                               | Cause                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| Deux clés Anthropic → le même modèle en double         | le modèle est attaché à la clé                               |
| Changer de clé → refaire les modèles                   | idem                                                         |
| Modèle « perso » = autre type de ligne, autre dialogue | `credential_id NULL` est un second circuit                   |
| Clé perso interdite sur une passerelle                 | l'endpoint vit sur la clé ; un membre ne doit pas le choisir |
| Trois dialogues de choix (`model-choice-dialog.tsx`)   | un par circuit : clé d'org, perso par service, nouvelle clé  |
| Onglets « Clés org » / « Clés perso »                  | la portée est traitée comme deux écrans                      |

Précision sur le constat d'origine (« clé org charge depuis l'API, clé perso depuis le catalogue ») :
dans le code, la source de la liste dépend du **fournisseur**, pas de la portée
(`apps/web/src/lib/model-source.ts`) : `catalog` (registre Pi + overlay), `discover`
(`GET <baseUrl>/models`, passerelles sans catalogue), `search` (OpenRouter en direct, donne le prix).
Le vrai écart : le circuit perso n'a jamais `discover`.

## 2. Cible

Deux concepts imbriqués, calqués sur intégration → connexion.

**Configuration de modèle** (niveau organisation) : une famille de catalogue, un libellé, un endpoint
(passerelles seulement), les modèles activés, et un réglage « connexions personnelles autorisées ».

**Connexion** (sous une configuration) : un secret (clé API ou abonnement OAuth), un état de santé, un
propriétaire — `NULL` = connexion de l'organisation, sinon celle d'un membre.

Règles :

1. **Une configuration = une famille** (`familyOf`, soit `catalogProviderId ?? providerId`). Une
   connexion s'y branche si son fournisseur est de cette famille. Conséquence : « Anthropic » accepte
   clé API et abonnement Claude Code ; Codex (`openai-codex`, autre forme d'API, autre endpoint) reste
   une configuration distincte d'OpenAI. Aucun cas particulier.
2. **L'endpoint appartient à la configuration.** Fixé par l'admin, donc une connexion perso devient
   possible sur une passerelle.
3. **Les modèles appartiennent à la configuration**, pas à une connexion. Cochables sans secret.
4. **Pas de connexion d'org + perso autorisé** = chacun fournit la sienne. Un admin peut brancher sa
   connexion perso comme tout membre ; c'est `owner_user_id` qui décide, pas le rôle.
5. **Abonnement autorisé en connexion d'org** (décision du 2026-11-28).
6. **Modèle par défaut** : réglage d'organisation en tête de page, hors des configurations.

### Ordre de service au run

Parmi les connexions de la configuration qui servent le modèle (`servesModel`) et que l'appelant peut
utiliser :

1. perso, abonnement
2. perso, clé API
3. org, abonnement
4. org, clé API

Puis la plus ancienne. Le proxy LLM écarte toujours les abonnements (`viaProxy`, inchangé). Un appel
sans payeur humain (planification, clé d'API, end-user) n'a que les rangs 3 et 4.

Cet ordre est une proposition : perso d'abord parce que le membre a choisi de payer, forfait avant
usage parce que le coût marginal est nul.

## 3. Décisions

Actées :

- D1 — configuration sans connexion d'org : avertissement « les planifications et l'API ne peuvent pas
  utiliser ces modèles ».
- D2 — modèle par défaut en tête de page, sélecteur groupé par configuration.
- D3 — deux gestes libellés (« Connecter pour l'organisation », « Utiliser ma clé »), qui paie écrit
  sous chacun.
- D4 — abonnement autorisé en connexion d'org.
- D5 — unification par famille de catalogue.

À confirmer avec Olivier avant le lot 2 :

- **Q1 — ordre de service** ci-dessus.
- **Q2 — plusieurs connexions d'org par configuration.** Le plan les autorise sans ordre réglable (la
  règle ci-dessus tranche) : c'est déjà nécessaire pour clé API + abonnement sur Anthropic. Pas
  d'écran de priorité.
- **Q3 — portée.** Le plan garde les configurations au niveau organisation, comme aujourd'hui.
- **Q4 — perte d'un réglage fin.** Aujourd'hui un admin peut lier Sonnet à la clé d'org et laisser
  Opus « chacun sa clé ». Avec la cible, la connexion d'org sert tous les modèles de la
  configuration : Opus passerait sur la facture de l'org. Deux issues : accepter (plus simple), ou
  garder un drapeau par modèle « connexions perso seulement ». À trancher sur données : le script du
  lot 2 compte en lecture seule les organisations qui ont ce mélange.
- **Q5 — clés de permission.** Le plan garde les clés RBAC actuelles (`models:*`, celles des
  identifiants) pour ne pas réécrire les rôles existants.

## 4. Schéma

```
model_configs
  id, org_id, family_id, label,
  base_url                      -- NULL sauf fournisseur à endpoint libre
  personal_connections_allowed  -- booléen
  created_by, created_at, updated_at
  unique (org_id, family_id) where base_url is null
  unique (org_id, family_id, base_url) where base_url is not null

model_provider_credentials      -- renommée model_connections au lot 5
  + config_id  not null  → model_configs
  - base_url_override           -- remonté sur la configuration
  (provider_id reste : c'est le type de connexion, anthropic ou claude-code)

org_models
  + config_id  not null  → model_configs
  - credential_id, - provider_id
  unique (config_id, model_id) where not aliased
  -- supprimés : uq_org_models_unaliased_binding, uq_org_models_unbound,
  --             org_models_alias_bound, org_models_credential_provider_fk
```

Inchangés : `organizations.default_model_id`, `runs.model_credential_id`, `llm_usage.credential_id`
(une connexion reste l'identité de ce qui a servi), `model_provider_pairings` (gagne `config_id`).

Non exprimable en SQL : « le fournisseur de la connexion est de la famille de la configuration » (le
registre vit dans le code). Garde au service, à la création et à l'appairage.

Le réglage d'organisation `personalModelCredentialsAllowed` disparaît au profit du booléen par
configuration.

## 5. Lots

Le basculement ne se découpe pas : retirer `credential_id` casse services, API et web d'un coup, et la
doctrine interdit une période à deux formes (`docs/NO_TRANSITIONAL_CODE.md`). D'où un lot préparatoire
sans effet, un lot de bascule, un lot de résidus.

### Lot 1 — composants (indépendant, démarrable tout de suite)

Dans `packages/ui`, absents aujourd'hui, issus du lot shadcn d'octobre 2025 :

| Composant      | Usage                                                                             |
| -------------- | --------------------------------------------------------------------------------- |
| `Item`         | ligne de configuration et ligne de connexion (média, titre, description, actions) |
| `Input Group`  | champ clé avec afficher/tester ; champ endpoint avec « Détecter »                 |
| `Button Group` | « Connecter » + menu clé API / abonnement                                         |

À vérifier dans `combobox.tsx` : exposition des puces (`ComboboxChips`, sélection multiple Base UI).
Aucun écran modifié dans ce lot.

### Lot 2 — bascule (une PR)

**2a. Migration + script de données.** Migration drizzle : nouvelles colonnes nullables, table
`model_configs`. Script `scripts/migration/00NN-model-configs.ts`, puis seconde migration qui pose
les `NOT NULL` et supprime les colonnes retirées. Le script :

1. Mode lecture seule d'abord : compte les organisations concernées par Q4, les doublons de modèles
   après fusion, les surcharges en conflit. Sortie relue avant toute écriture.
2. Une configuration par (org, famille) pour les familles à catalogue ; par (org, fournisseur,
   endpoint) pour les passerelles.
3. Rattache chaque clé à sa configuration, remonte l'endpoint.
4. Rattache chaque modèle ; fusionne les doublons nés de deux clés de même famille (garde le plus
   ancien, repointe le défaut d'org, les modèles fixés sur les agents et les planifications).
5. `personal_connections_allowed` = réglage actuel de l'org.
6. Vérification discriminante : pour chaque modèle, la connexion résolue sans payeur avant et après
   doit être la même ; tout écart est listé, pas agrégé.

La garde `PENDING_DATA_SCRIPTS` bloquera le preview tant que le script n'a pas tourné.

**2b. Résolution.** Dans `apps/api/src/services/org-models.ts` (1995 lignes), une seule fonction :
modèle → configuration → connexions candidates → ordre du §2. Remplace `describeRowBinding`,
`resolveDbModel`, `resolvePersonalModel`, `resolveOrgBinding`, `personalCredentialNotBindable`,
`refuseUnboundAlias`, `asDuplicateBinding`. `familyOf` et `servesModel`
(`model-providers/credential-chain.ts`) restent et deviennent la règle centrale.
`loadRunModel` (reprise d'un run sur la connexion enregistrée) garde son contrat.

**2c. API.** Routes imbriquées ; chaque nouvelle route déclarée dans l'inventaire des gardes, chaque
nouveau code de refus traduit.

```
GET|POST        /api/model-configs
PATCH|DELETE    /api/model-configs/:id
PUT             /api/model-configs/:id/models        (remplace POST /api/models/apply)
POST            /api/model-configs/:id/discover      (remplace /model-provider-credentials/discover)
GET|POST        /api/model-configs/:id/connections
PATCH|DELETE    /api/model-connections/:id
POST            /api/model-connections/:id/test
```

Sur le fil, `binding: org | user | managed | system` disparaît ; un modèle expose qui le sert pour
l'appelant et pourquoi il est indisponible le cas échéant. OpenAPI, `generate:api`, baseline.
`@appstrate/core` : types partagés modifiés, donc **majeure** — `connect-helper` à vérifier
(l'appairage gagne la configuration).

**2d. Web.** Voir §6.

**2e. Tests.** Environ 70 fichiers de test et 3 helpers `e2e/` touchent ces tables ou ces routes.
Labels `integration` et `e2e` sur la PR.

### Lot 3 — résidus

Renommage `model_provider_credentials` → `model_connections` (table, services, routes, types),
mécanique et seul dans sa PR. Passe `/audit-legacy` jusqu'à convergence. Documentation
(`docs/site`), README des modules `claude-code` et `codex`, note de release (changements de
comportement du §7).

## 6. Expérience

### Réglages d'organisation › Modèles (une page, plus d'onglets)

```
Modèle par défaut            [ Anthropic › Claude Sonnet 4.5        v ]
Utilisé quand un agent ne fixe pas son modèle.

Configurations                                  [ + Ajouter une configuration ]
┌ A  Anthropic              3 modèles · connexion org + 4 perso     Active        v ┐
│    Connexions
│      Connexion de l'organisation   sk-…4f2a                       Active     ⋯
│      Connexions personnelles · 4 membres                 Autorisées  [ on ]
│    Modèles
│      (Sonnet 4.5 · défaut) (Opus 4.5) (Haiku 4.5)   [ Choisir les modèles ]
└
  C  Codex (ChatGPT)        2 modèles · connexions perso seulement  Active        >
  ▣  Passerelle interne     https://llm.interne/v1 · 5 modèles      À reconnecter [Reconnecter] >
  O  OpenAI                 4 modèles · aucune connexion            À connecter   [Connecter]   >
  ✦  Appstrate              2 modèles inclus · facturés en crédits  Système
```

- État remonté sur la ligne : Active / À connecter / À reconnecter. Réparation sans déplier.
- Configuration créable et modèles cochables sans secret.
- « Connecter » ouvre un menu : pour l'organisation / ma clé, puis clé API / abonnement selon ce que
  la famille accepte. Sous chaque geste : qui paie.
- Avertissements portés par la configuration : sans connexion d'org (D1) ; abonnement seul = pas de
  service par le proxy ; modèle que l'abonnement peut refuser (`subscription_unverified`).

### Modèle par défaut

Sélecteur groupé par configuration, sur `model-picker.tsx` existant. Éligible = configuration avec une
connexion d'org vivante ; les autres visibles, grisés, raison affichée. Si la connexion du défaut
meurt : alerte sur la ligne et « Choisir un autre modèle ». Dans la configuration, la puce « défaut »
est en lecture seule.

### Dialogue unique « Choisir les modèles »

Combobox à puces + liste cochable groupée (Recommandés / Tout le catalogue), contexte et prix par
ligne. Catalogue, détection (passerelles) et recherche OpenRouter remplissent la même liste.
Remplace `ProviderModelsModal`, `PersonalModelsModal`, `NewProviderModelsModal`.

### Préférences › Modèles (membre)

Liste des configurations ouvertes au membre. Chaque ligne dit qui sert (« connexion de
l'organisation », « ma connexion ») et offre « Utiliser ma clé » si autorisé. Même forme que
Préférences › Connexions.

### À ne pas oublier

Squelettes alignés sur la nouvelle structure ; étape d'accueil (`pages/onboarding/model-step.tsx`,
`onboarding-quick-connect.tsx`) ; libellés FR et EN ; specs Playwright sur les libellés retirés
(« Clés org », « Ajouter une clé org »…) ; `packages/module-chat/ui` (deux fichiers lisent ces types).

## 7. Changements de comportement à annoncer

1. Un modèle servi jusqu'ici par la clé d'org peut l'être par la connexion perso du membre, si la
   configuration l'autorise : le payeur change.
2. Un modèle laissé « chacun sa clé » dans une famille qui a une clé d'org devient servi par l'org
   (Q4).
3. Le réglage d'organisation des clés perso devient un réglage par configuration.
4. Clé perso possible sur une passerelle.
5. API : routes et forme des modèles cassantes.

## 8. Risques

| Risque                                                            | Parade                                                     |
| ----------------------------------------------------------------- | ---------------------------------------------------------- |
| Fusion de doublons qui repointe mal un agent ou une planification | lecture seule d'abord, vérification avant/après par modèle |
| Facture d'org qui gonfle sans bruit (Q4)                          | compter avant de décider ; sinon drapeau par modèle        |
| Preview bloqué par la garde des scripts de données                | lancer le script sur le preview dans la même fenêtre       |
| Module `claude-code` retiré : connexions inertes                  | la configuration survit, connexions marquées indisponibles |
| Rouge CI masqué en local (tier 0 saute les modules Postgres)      | labels `integration` + `e2e`                               |

## 9. Pratiques comparables

Dify (clés en pool sous le fournisseur), OpenRouter et Vercel AI Gateway (clés ordonnées par
fournisseur, repli désactivable), LibreChat (`apiKey: user_provided` par endpoint), Open WebUI
(connexions admin + connexions directes sur interrupteur). Constante : le modèle n'est jamais
accroché à une clé ; le perso est un réglage de l'admin sur la configuration.

- https://docs.dify.ai/use-dify/workspace/model-providers
- https://openrouter.ai/docs/features/byok
- https://vercel.com/docs/ai-gateway/byok
- https://www.librechat.ai/docs/configuration/librechat_yaml/object_structure/custom_endpoint
- https://docs.openwebui.com/features/experimental/direct-connections
- https://ui.shadcn.com/docs/changelog/2025-10-new-components
