---
name: connector-choice
description: Choisir le bon connecteur pour brancher un service à un agent. Charge ce skill quand il faut connecter un nouvel outil (Gmail, Slack, Notion, ClickUp, HubSpot…) et qu'il existe plusieurs variantes. Règle : préférer la variante MCP distante (id en -mcp, un clic) à la variante API (qui force souvent à enregistrer une app dev avec client id/secret). Donne la cascade de décision et le garde-fou « ne jamais coller un secret dans le chat ».
---

# Choix du connecteur — MCP distant d'abord

Quand l'utilisateur doit brancher un service, plusieurs chemins existent. Choisis le plus léger
**pour lui**, pas le plus puissant pour toi.

## Étape 0 — cherche le sibling `-mcp` AVANT de connecter (obligatoire)

Ne génère **jamais** un formulaire ou un lien de connexion sur le premier connecteur qui matche le nom
du service. Le caller-context ne liste que les intégrations **déjà connectées** : un service pas encore
branché n'y figure pas, et sa variante `-mcp` non plus. Tu dois donc la **chercher activement** :

1. Liste les intégrations disponibles : `GET /api/integrations`.
2. Pour le service demandé (ex. `clickup`), cherche un **sibling dont l'id se termine par `-mcp`**
   (`clickup-mcp`, `notion-mcp`, `github-mcp`…). Le nom nu (`clickup`) est presque toujours la variante
   API lourde ; la variante un-clic est le sibling `-mcp`.
3. Si le sibling `-mcp` existe → connecte **celui-là**. Ne te rabats sur la variante API que si **aucun**
   `-mcp` n'existe pour ce service. Ne prends jamais le premier match par défaut.

## Cascade

1. **Le service a une variante MCP distante** (son id se termine par `-mcp`, `source.kind: "remote"`) →
   **préfère-la**. Elle connecte en **un clic** (OAuth/DCR côté fournisseur), sans que l'utilisateur ait à
   créer quoi que ce soit. C'est le défaut.
2. **Sinon, la variante API simple** (`source.kind: "local"`, `auths: oauth2 | api_key`) → utilise-la.
   Quel que soit le type d'auth (OAuth, clé API, basic, custom), déclenche le flux de connexion natif :
   il rend un **bouton one-click** dans le chat qui ouvre une page de connexion hébergée (écran OAuth du
   fournisseur ou formulaire de credentials selon l'auth — le secret y est saisi, jamais dans le chat).
   Ne fabrique jamais d'URL à la main. Attention : beaucoup d'API à clé forcent quand même l'utilisateur
   à **enregistrer une app développeur** (client id / secret) chez le fournisseur — c'est friction,
   d'où la préférence pour le MCP.
3. **Aucune des deux** → fabrique (MCP via `mcp-builder`, ou intégration REST/OAuth). Voir le skill
   `copilot`, Phase 3.

## Garde-fou (toujours)

Ne demande **jamais** à l'utilisateur de coller une clé API, un secret OAuth (client id/secret), un
token ou un mot de passe **dans la conversation**. La connexion passe par le flux natif : un **bouton
one-click** dans le chat qui ouvre une page de connexion **hébergée** où le secret est saisi (jamais
dans le chat), quel que soit le type d'auth.

## Vérifier ce qui existe

Avant de proposer une connexion, regarde si une variante est déjà disponible / connectée :
`GET /api/integrations` liste les intégrations de l'org (l'id en `-mcp` signale la variante MCP), et
`GET /api/integrations/{packageId}/connections` dit si une connexion existe déjà. Si le service n'est
pas configurable sur l'instance (par ex. un 403 à la génération du lien), dis-le franchement et
propose une alternative plutôt que de boucler.
