# Générer un agent — ce que le schéma ne dit pas

> **Le format du manifest est le schéma AFPS canonique** (`https://schemas.afps.dev/v0/agent.schema.json`),
> exposé par les opérations `runs/inline`, `…/validate` et `packages/import` (composant `AgentManifest`).
> Découvre-le via `describe_operation` — **ne recopie pas le squelette ici**. Ce mémo ne porte que ce
> que le schéma n'explicite pas : les pièges runtime et le contrat du `prompt.md`.

## Pièges qui ne sautent pas aux yeux dans le schéma

- **`integrations_configuration.<id>.tools` est obligatoire pour exposer un tool.** Absent ou `[]`
  → **zéro tool** (l'agent ne voit pas le connecteur). Intégration `none` → `["api_call"]` ;
  intégration MCP (`*-mcp`) → les vrais noms de tools (ou `"*"`).
- **`output` doit figurer dans `runtime_tools` dès qu'un `output.schema` est déclaré** (sinon rejet).
- **Lecture du résultat : `result.output.<champ>`** (pas `result.<champ>`).
- Pas de type `"file"` : champ string `format:"uri"` + `contentMediaType` + sibling `file_constraints`.
- `required` = tableau top-level (pas un booléen par propriété).

## Le prompt.md (n'est pas dans le manifest)

Markdown simple. La plateforme injecte automatiquement : identité, environnement, **contrat de
communication**, `## User Input`, `## Configuration`, `## Checkpoint`, doc des intégrations,
`## Output Format`. Donc :

- **Ne liste jamais les tools** (l'agent les découvre via `tools/list`).
- **Tout passe par un tool** : le texte libre hors tool call est ignoré. Écris « appelle `output`
  avec… », « appelle `report` pour… » — jamais « réponds avec… ».
- Décris l'**objectif**, les **étapes**, les **règles** (anti-hallucination, erreurs). Pour un agent
  ⏰ : lire l'état depuis `## Checkpoint`, écrire `pin({key:"checkpoint"})` à la fin (incrémental).

## Cascade connecteur (rappel)

`source.kind` ∈ `none | local | remote` ; `auths` ∈ `oauth2 | api_key | basic | mtls | custom`.
Connexion = via l'opération OAuth/champs (le lien présenté dans le chat) — voir `piloter-appstrate.md`.
