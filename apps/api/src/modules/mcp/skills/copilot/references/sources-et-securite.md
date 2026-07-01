# Sources dynamiques & sécurité

> Chargé quand le copilote va chercher des idées (Phase 2) ou un skill/MCP (Phase 3).
> **Capacité d'accès** : le runtime est **sandboxé** — pas d'HTTP direct. Toute recherche / lecture
> web passe par le skill **`@default/web-search`** (recette de **run inline**) : il détecte les
> fournisseurs connectés (**Brave** déjà connecté sur i31, Firecrawl, Tavily…) et retombe sur
> `@default/web-fetch` pour lire une URL publique (n8n templates, `raw.githubusercontent.com`,
> registres MCP). Réutilise ce skill, n'invente pas d'accès réseau.

## Listings d'automatisation (inspiration « ce que les gens automatisent »)

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

## Repos de skills (récupérer un savoir-faire manquant)

Format standard `SKILL.md` + frontmatter (`name`, `description`). Fetch direct :
`https://raw.githubusercontent.com/<owner>/<repo>/main/<path>/SKILL.md`.

**Whitelist de confiance** (n'élargir qu'avec revue) :

- `anthropics/skills` — dont `skill-creator` (écrire un skill) et `mcp-builder` (scaffolder un MCP).
- `letta-ai/skills`.

## Registres MCP (brancher un service non built-in)

Pour un service sans connecteur Appstrate, chercher un serveur MCP distant publié
(registre MCP officiel, annuaires communautaires), puis le brancher en intégration
`source.kind: remote`. Si rien n'existe : scaffolder via `mcp-builder`, ou créer une
intégration REST `none` + auth.

## Garde-fous (leçon « ClawHavoc » — marketplace ouverte = skills malveillants)

- **Whitelist** de repos / MCP de confiance. Ne jamais fetcher un skill/MCP arbitraire sur simple nom.
- **Valider** tout package récupéré : lire le `SKILL.md` / le manifeste avant usage ; se méfier du typosquatting (nom proche d'un repo connu).
- **Aucune exécution de code non revue.** Un skill = du texte ; un MCP = du code → revue obligatoire avant de le brancher.
- **Dry-run** (`/api/runs/inline/validate`) avant tout import.
- La **curation** est un avantage Appstrate vs les marketplaces ouvertes — l'assumer.
