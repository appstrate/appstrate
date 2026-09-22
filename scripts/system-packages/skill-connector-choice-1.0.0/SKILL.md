---
name: connector-choice
description: "Méthode pour choisir la bonne variante de connecteur quand plusieurs couvrent le même service (variante MCP distante en -mcp contre variante API), à partir de l'état d'auth réel de chaque variante, et pour la faire connecter sans jamais demander de secret dans la conversation. Charge ce skill quand il faut brancher un nouvel outil, quand un run échoue faute d'intégration prête, ou quand l'utilisateur demande comment connecter un service."
---

# Choisir la bonne variante de connecteur

Un même service peut être couvert par plusieurs intégrations : une variante
**MCP distante** (identifiant suffixé `-mcp`, `source.kind: "remote"`) et une
variante **API** (`source.kind: "none"`, tool `api_call`). Choisis celle qui
demande le moins à l'utilisateur — pas la première qui apparaît.

## 1. Ne connecte jamais le premier identifiant qui ressemble au nom

Le bloc `## Your context` ne liste que les intégrations **déjà connectées** : un
service pas encore branché n'y figure pas, et sa variante `-mcp` non plus. Il
faut donc la chercher :

1. `invoke_operation` avec `operation_id: "listIntegrations"` et
   `query: { fields: "id,active" }` — c'est la liste de ce qui existe
   réellement dans cet espace.
2. Pour le service demandé, cherche le voisin dont l'identifiant se termine par
   `-mcp`. Le nom nu est presque toujours la variante API.
3. Deux variantes existent → ne tranche pas sur l'identifiant, lis leur état
   d'auth (étape 2).

## 2. Lire l'état d'auth, puis trancher

`getIntegration` (`path_params: { packageId: "@appstrate/<id>" }`) renvoie, pour
chaque auth : `type`, `ready`, `connections`, `client_auto_provisioned`,
`has_system_client`, `has_oauth_client` — plus `tool_catalog`, `default_tools`,
`allow_undeclared_tools` et `active`.

Première ligne vraie gagne :

| Signal sur une auth de la variante              | Coût pour l'utilisateur                                                        | Verdict                 |
| ----------------------------------------------- | ------------------------------------------------------------------------------ | ----------------------- |
| `ready: true`, ou une entrée dans `connections` | rien, c'est déjà branché                                                       | prends cette variante   |
| `client_auto_provisioned: true`                 | un clic — le client OAuth est provisionné à la connexion                       | préfère celle-ci        |
| `has_system_client: true`                       | un clic — l'instance fournit un client OAuth partagé                           | bon second choix        |
| `has_oauth_client: true`                        | un clic — l'organisation a déjà enregistré son application                     | convenable              |
| `type: "api_key"`                               | une clé à saisir sur la page de connexion hébergée                             | acceptable, annonce-le  |
| aucun des précédents (oauth2 sans client)       | un administrateur doit d'abord enregistrer une application chez le fournisseur | dernier recours, dis-le |

**`-mcp` n'est pas synonyme d'un clic.** Certaines variantes MCP distantes
exigent malgré tout une application enregistrée : c'est `client_auto_provisioned`
qui le dit, pas le suffixe de l'identifiant. Lis le drapeau, ne déduis rien du
nom.

Quand les deux variantes coûtent pareil, prends celle qui couvre la tâche :
regarde `tool_catalog` (MCP distant) contre `api_call` (variante API, qui atteint
n'importe quel point de l'API du fournisseur autorisé).

## 3. Conséquence immédiate sur la sélection des tools

- **Variante API** — `default_tools: ["api_call"]` : omettre
  `integrations_configuration.<id>.tools` suffit, l'héritage s'applique.
- **Variante MCP distante** — pas de `default_tools` : tu **dois** nommer les
  tools, pris tels quels dans le `tool_catalog` de `getIntegration`. `"*"` n'est
  permis que si `allow_undeclared_tools` est vrai.
- Dans les deux cas, une intégration déclarée dont la sélection de tools est
  vide est refusée à la publication et interrompt le run : sélectionne au moins
  un tool, ou retire l'intégration des dépendances.

## 4. Faire connecter — sans jamais voir le secret

**Garde-fou absolu : ne demande jamais de coller une clé API, un client
id/secret, un token ou un mot de passe dans la conversation.** Tout se saisit
sur la page de connexion hébergée, quel que soit le type d'auth. Ne fabrique
jamais une URL de connexion à la main.

Le chemin le plus court est de lancer le run : la préflight le refuse sans
consommer de crédit et l'erreur sur `integrations.<id>` porte souvent déjà un
`connect_url` — dans ce cas, n'appelle rien d'autre. Sinon, démarre le flux
toi-même avec `initiateIntegrationConnect`, en transmettant l'`auth_key` et les
`required_scopes` que l'erreur a nommés.

Le chat affiche le bouton de connexion à partir de ce résultat : **ne colle pas
le lien, ne décris pas où cliquer**, termine le tour par une phrase disant que
tu reprends une fois l'intégration connectée. Ne relance pas le flux à chaque
tour pour un lien déjà donné.

Si le fournisseur n'est pas configurable ici (403 au démarrage de la connexion),
ne boucle pas : explique qu'un administrateur doit ajouter les identifiants
d'application, et propose une alternative.

## 5. Connecté n'est pas actif

Une erreur `integration_not_active` sur `integrations.<id>` ne se répare pas en
connectant davantage : connecter est personnel, activer est organisationnel.
Active l'intégration dans l'espace avec `activatePackage`
(`body: { packageId: "@appstrate/<id>" }` ; lis son schéma avec
`describe_operation`, et reprends l'id d'espace de la ligne `Current space:`
de ton contexte), puis relance une fois. L'activation est réservée aux
administrateurs : sur un 403, dis simplement qu'un administrateur doit activer
cette intégration, et arrête-toi.

## 6. Quand rien ne convient

Aucune variante pour ce service : dis-le et propose ce qui existe réellement —
un outil déjà connecté qui couvre le besoin, ou un export que l'utilisateur
fournit lui-même. N'invente jamais un identifiant de package ni une intégration
absente de `listIntegrations`.
