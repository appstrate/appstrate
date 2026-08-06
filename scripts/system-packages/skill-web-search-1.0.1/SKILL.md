---
name: web-search
description: Chercher ou lire le web en lançant un run inline (le chat n'a pas d'accès web direct — le runtime est sandboxé). Charge ce skill dès qu'il faut une recherche web (requête en langage naturel) ou lire une/des URLs. Détecte au runtime les fournisseurs de recherche réellement présents et connectés (Firecrawl est le seul livré en standard ; Brave, Tavily, Exa, SerpAPI supposent une intégration ajoutée par l'organisation) et les utilise ; à défaut, dit clairement qu'aucun accès web n'est disponible plutôt que d'inventer. Donne le manifest inline, l'input et l'output structuré de chaque branche.
---

# Web Search — recette de run inline

L'assistant du chat (et les agents) n'a pas d'outil web natif : le runtime est sandboxé, l'egress
réseau est limité aux `authorized_uris` des intégrations. Pour chercher / lire le web, on **lance un
run inline** (`POST /api/runs/inline`) qui embarque une intégration web, puis on **attend** le run
(`wait_for_run` / `GET /api/runs/{id}`) et on lit son `result.output`.

Depuis le chat, tu fais ça via `invoke_operation` sur les opérations de l'API (`runInline`, puis
`wait_for_run`). Ne poll pas `getRun` en boucle toi-même.

## Arbre de décision

> **Rien n'est garanti présent.** Seul `@appstrate/firecrawl` est livré en standard avec Appstrate.
> Tous les ids en `@default/…` ci-dessous sont des intégrations que l'organisation doit avoir
> ajoutées elle-même : elles n'existent pas sur une instance neuve. Ne les cite jamais sans avoir
> vérifié leur présence à l'étape 1.

1. **Regarde ce qui existe ET ce qui est connecté.** Appelle `GET /api/integrations` : la réponse
   est la liste de ce qui existe RÉELLEMENT ici. Puis, pour chaque fournisseur de recherche présent
   dans cette liste, `GET /api/integrations/{packageId}/connections`. Fournisseurs reconnus, par
   ordre de préférence : `@appstrate/firecrawl` (livré en standard), puis, **s'ils apparaissent dans
   la liste**, `@default/brave-search`, `@default/tavily`, `@default/exa`, `@default/serpapi`. Un
   fournisseur est utilisable s'il est présent **et** a ≥1 connexion accessible (ou un défaut org).
2. **Si un fournisseur de recherche est utilisable** et que la demande est une _recherche_ (requête
   en langage naturel) → **Recette A** avec ce fournisseur.
3. **Si on te donne des URLs précises à lire** et que `@default/web-fetch` figure dans la liste de
   l'étape 1 → **Recette B**, qui fait un simple GET et renvoie le contenu. Pas de moteur de
   recherche : il faut connaître l'URL.
4. **Dans tous les autres cas, dis-le.** Aucun fournisseur utilisable, ou `@default/web-fetch`
   absent : annonce-le clairement (« aucun accès web disponible sur cette instance — Firecrawl peut
   être connecté en un clic, sinon donne-moi le contenu directement ») et propose la connexion via
   le flux natif. **N'invente jamais un résultat, et ne référence jamais une intégration que
   l'étape 1 n'a pas retournée.**

Toujours : citer ce que l'outil renvoie, ne jamais fabriquer un résultat.

## Recette A — recherche via un fournisseur (exemple Firecrawl)

Body de `POST /api/runs/inline` :

```json
{
  "manifest": {
    "name": "@default/inline-web-search",
    "version": "1.0.0",
    "type": "agent",
    "schema_version": "0.1",
    "display_name": "inline web search",
    "description": "Recherche web via le fournisseur connecté, renvoie des résultats structurés.",
    "dependencies": {
      "skills": {},
      "mcp_servers": {},
      "integrations": { "@appstrate/firecrawl": "^1.0.0" }
    },
    "integrations_configuration": {
      "@appstrate/firecrawl": { "auth_key": "primary", "tools": ["api_call"] }
    },
    "runtime_tools": ["output"],
    "input": {
      "schema": {
        "type": "object",
        "properties": {
          "query": { "type": "string" },
          "limit": { "type": "integer", "default": 5 }
        },
        "required": ["query"]
      }
    },
    "output": {
      "schema": {
        "type": "object",
        "properties": {
          "results": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "title": { "type": "string" },
                "url": { "type": "string" },
                "snippet": { "type": "string" }
              },
              "required": ["title", "url"]
            }
          }
        },
        "required": ["results"]
      }
    }
  },
  "prompt": "Avec l'integration @appstrate/firecrawl (api_call), fais un POST sur https://api.firecrawl.dev/v1/search avec le corps {\"query\": <query>, \"limit\": <limit>}. Mappe la reponse vers output.results = [{title, url, snippet}] (snippet = description/extrait). Ne renvoie que des resultats reels issus de l'API.",
  "input": { "query": "VOTRE REQUETE", "limit": 5 }
}
```

Pour un **autre fournisseur** : garde la même structure, change `dependencies.integrations` +
`integrations_configuration` pour l'id du fournisseur, et adapte l'URL/le corps dans le `prompt` :

- Brave : `GET https://api.search.brave.com/res/v1/web/search?q=<query>&count=<count>` (en-tête `Accept: application/json`), mappe `web.results[]`.
- Tavily : `POST https://api.tavily.com/search`.
- Exa : `POST https://api.exa.ai/search`.
- SerpAPI : `GET https://serpapi.com/search`.

L'output structuré `results[]` reste identique. La plupart des moteurs ne renvoient que titre/url/
description. Pour le **contenu** d'une page trouvée, enchaîne avec la Recette B (`@default/web-fetch`)
sur l'URL choisie.

## Recette B — fetch d'URL publique (fallback sans credential)

> **Conditionnelle.** `@default/web-fetch` n'est PAS livré avec Appstrate. Cette recette ne
> s'applique que si l'étape 1 a bien retourné cette intégration. Sinon, applique l'étape 4.

Intégration `@default/web-fetch` (source none, `allow_all_uris`, **sans clé**). Body de
`POST /api/runs/inline` :

```json
{
  "manifest": {
    "name": "@default/inline-web-fetch",
    "version": "1.0.0",
    "type": "agent",
    "schema_version": "0.1",
    "display_name": "inline web fetch",
    "description": "GET d'une ou plusieurs URLs publiques, renvoie leur contenu.",
    "dependencies": {
      "skills": {},
      "mcp_servers": {},
      "integrations": { "@default/web-fetch": "^1.0.0" }
    },
    "integrations_configuration": {
      "@default/web-fetch": { "auth_key": "primary", "tools": ["api_call"] }
    },
    "runtime_tools": ["output"],
    "input": {
      "schema": {
        "type": "object",
        "properties": { "urls": { "type": "array", "items": { "type": "string" } } },
        "required": ["urls"]
      }
    },
    "output": {
      "schema": {
        "type": "object",
        "properties": {
          "pages": {
            "type": "array",
            "items": {
              "type": "object",
              "properties": {
                "url": { "type": "string" },
                "status": { "type": "integer" },
                "content": {
                  "type": "string",
                  "description": "Contenu textuel/HTML nettoyé de la page"
                }
              },
              "required": ["url", "content"]
            }
          }
        },
        "required": ["pages"]
      }
    }
  },
  "prompt": "Pour chaque URL de input.urls, utilise @default/web-fetch (api_call) pour faire un GET. Renvoie output.pages = [{url, status, content}] ou content = le corps de la reponse (si HTML, extrais le texte lisible principal). N'invente rien : si une URL echoue, mets son status et un content vide.",
  "input": { "urls": ["https://example.com"] }
}
```

## Après le lancement

`runInline` renvoie `202 { runId }`. Appelle `wait_for_run` avec ce `runId` (il bloque jusqu'à la fin),
puis lis `result.output` (`output.results` pour A, `output.pages` pour B). Status terminaux :
`success | failed | timeout | cancelled`. En cas d'échec, lis `GET /api/runs/{id}/logs` pour la cause.

## Notes

- `@default/web-fetch` n'est pas un package système : il doit avoir été ajouté à l'organisation.
  Une fois présent, il a besoin d'une **connexion** (même sans credential : champ `note` bidon) et
  d'un **défaut org** pour que le run inline la résolve. Si elle manque, propose de la créer.
- Le fetch générique ne contourne pas les portails authentifiés / anti-bot ni le JS côté client ;
  pour ça, préférer un fournisseur de scraping (Firecrawl `/v1/scrape`).
- Limite le nombre d'URLs / la taille par run (réponses > ~32 KB spillent en `resource_link`).
