---
name: web-search
description: "Méthode pour chercher ou lire le web, que le chat ne peut faire lui-même : vérifier l'accès web réellement disponible, puis lancer UN run inline qui embarque l'intégration web, avec l'effort borné et les sources citées. Charge ce skill dès qu'une demande suppose une recherche web, la lecture d'une ou plusieurs URLs, ou une veille sur des sources externes. Seul @appstrate/firecrawl est livré avec la plateforme ; quand aucun accès n'existe, annonce-le plutôt que d'inventer."
---

# Recherche web par run inline

Le web passe par un **run inline** qui embarque une intégration web. Le seul fournisseur livré avec la plateforme est
`@appstrate/firecrawl` (clé API, tool `api_call`, domaine autorisé
`api.firecrawl.dev`). Une organisation peut en avoir ajouté d'autres — ne cite
que ce que tu as vu dans ton contexte ou dans `listIntegrations`.

## 1. Vérifier l'accès avant de promettre quoi que ce soit

1. `@appstrate/firecrawl` figure dans les intégrations connectées du bloc
   `## Your context` → utilisable, passe à la section 2. Reprends l'identifiant
   **et la version** affichés là, verbatim.
2. Sinon, `listIntegrations` : l'intégration existe-t-elle ici ?
   - **Présente mais pas connectée** → n'ouvre pas d'enquête supplémentaire :
     lance directement la recette de la section 2, c'est elle qui amène la
     connexion.
   - **Absente** → il n'y a pas d'accès web sur cette instance.
3. **Aucun accès** : dis-le franchement (« aucun accès web n'est disponible
   ici ») et propose l'alternative réelle — qu'il colle le contenu, ou qu'un
   administrateur ajoute un fournisseur. **N'invente jamais un résultat, une
   source ou une intégration.**

Pour savoir si une intégration présente a une connexion utilisable sans lancer
de run : `getIntegration` (`path_params: { packageId: "@appstrate/firecrawl" }`)
et lis `auths[].ready`.

## 2. Recette A — une recherche en langage naturel

Un seul `run_and_wait`, `kind:"inline"`. Adapte la version au contexte, le
`display_name` au sujet réel, et la borne d'effort à la demande :

```json
{
  "kind": "inline",
  "manifest": {
    "display_name": "Recherche web : tarifs des concurrents",
    "timeout": 300,
    "dependencies": { "integrations": { "@appstrate/firecrawl": "^1.0.0" } },
    "integrations_configuration": { "@appstrate/firecrawl": { "tools": ["api_call"] } }
  },
  "prompt": "Avec l'intégration @appstrate/firecrawl (api_call), fais un POST sur https://api.firecrawl.dev/v2/search avec le corps {\"query\": \"<la requête>\", \"limit\": 5} ; si ce chemin de version est refusé, refais le même appel sur /v1/search. Au plus 2 recherches, arrête-toi dès que tu as 5 sources pertinentes. Termine par l'outil output avec { \"results\": [{ \"title\", \"url\", \"snippet\" }], \"summary\": \"<3 lignes>\" }. N'invente aucune URL : ne renvoie que ce que l'API a retourné."
}
```

## 3. Recette B — lire des URLs précises

Même forme, autre prompt : pour chaque URL fournie, un POST sur
`https://api.firecrawl.dev/v2/scrape` avec `{"url": "<url>", "formats": ["markdown"]}`
(repli sur `/v1/scrape` si la version est refusée), et un `output` final
`{ "pages": [{ "url", "status", "content" }] }`. Borne le nombre d'URLs (5 au
plus par run) et demande un extrait, pas la page entière, quand seul un point
précis est cherché.

## 4. Borner l'effort — toujours les trois lignes

Tout prompt de sous-agent porte :

1. un **plafond** explicite (« au plus 2 recherches », « au plus 5 pages ») ;
2. un **critère d'arrêt** (« arrête-toi à 5 sources pertinentes ») ;
3. `output` comme **dernière action obligatoire**.

## 5. Restituer

- **Cite les sources** telles que le run les a renvoyées : titre + URL. Une
  affirmation sans source rattachable ne sort pas.
- **Ne fabrique rien.** Si le run ne trouve rien, dis-le ; si une page a
  échoué, dis laquelle.
