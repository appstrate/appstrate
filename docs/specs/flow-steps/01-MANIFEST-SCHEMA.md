# Phase 1 — Extension du Manifest AFPS + Validation + ZIP

**Effort estimé** : ~2 jours
**Dépendances** : Aucune
**Fichiers impactés** : `@appstrate/core/validation`, `flow.schema.json`, `services/schema.ts`, `system-packages.ts`

---

## 1. Extension du manifest.json

### 1.1 Nouveau champ `steps` (optionnel)

Le champ `steps` est un tableau ordonné d'objets `StepDefinition`. Sa présence transforme le flow de "mono-prompt" en "pipeline".

```jsonc
{
  "$schema": "https://afps.appstrate.dev/schema/v1/flow.schema.json",
  "name": "@acme/lead-qualifier",
  "version": "1.0.0",
  "type": "flow",
  "schemaVersion": "1.1",
  "displayName": "Lead Qualifier Pipeline",
  "author": "demo@acme.com",

  // Input/output GLOBAL du flow (inchangé)
  "input": { "schema": { "type": "object", "properties": { ... } } },
  "output": { "schema": { "type": "object", "properties": { ... } } },

  // Dependencies GLOBALES (union de tous les steps) — pour compatibilité registry
  "dependencies": {
    "providers": {
      "@appstrate/hubspot": "*",
      "@appstrate/google-sheets": "*",
      "@appstrate/slack": "*",
      "@appstrate/gmail": "*"
    },
    "skills": { "@acme/crm-helpers": "^1.0.0" }
  },

  // ── NOUVEAU ──
  "steps": [
    {
      "id": "enrich",
      "displayName": "Enrichir le lead",
      "prompt": "steps/enrich.md",
      "providers": ["@appstrate/hubspot", "@appstrate/google-sheets"],
      "skills": ["@acme/crm-helpers"],
      "tools": [],
      "timeout": 120,
      "output": {
        "schema": {
          "type": "object",
          "properties": {
            "company_size": { "type": "string", "enum": ["small", "medium", "enterprise"] },
            "enriched_data": { "type": "object" }
          },
          "required": ["company_size"]
        }
      }
    },
    {
      "id": "qualify",
      "displayName": "Qualifier le lead",
      "prompt": "steps/qualify.md",
      "providers": ["@appstrate/hubspot"],
      "skills": [],
      "tools": [],
      "modelId": "claude-sonnet",   // modèle puissant pour le raisonnement
      "output": {
        "schema": {
          "type": "object",
          "properties": {
            "score": { "type": "number" },
            "qualified": { "type": "boolean" }
          },
          "required": ["score", "qualified"]
        }
      }
    },
    {
      "id": "notify",
      "displayName": "Notifier le commercial",
      "prompt": "steps/notify.md",
      "providers": ["@appstrate/slack", "@appstrate/gmail"],
      "skills": [],
      "tools": [],
      "modelId": "claude-haiku"     // modèle léger suffisant pour notifier
    }
  ],

  // Routing (Phase 3 — ignoré en Phase 1-2)
  "routing": [ ... ]
}
```

### 1.2 Type `StepDefinition`

```typescript
interface StepDefinition {
  /** Identifiant unique du step dans le flow (slug, ex: "enrich") */
  id: string;

  /** Nom affiché dans l'UI */
  displayName: string;

  /** Chemin relatif du prompt dans le ZIP (ex: "steps/enrich.md") */
  prompt: string;

  /** Sous-ensemble des providers déclarés dans dependencies.providers */
  providers?: string[];

  /** Sous-ensemble des skills déclarés dans dependencies.skills */
  skills?: string[];

  /** Sous-ensemble des tools déclarés dans dependencies.tools */
  tools?: string[];

  /** Timeout spécifique au step (secondes). Défaut: timeout global du flow / nb steps */
  timeout?: number;

  /**
   * Modèle IA à utiliser pour ce step (optionnel).
   * Référence un ID de modèle configuré dans l'org (DB ou system).
   * Si absent, le step utilise le modèle du flow (cascade standard :
   * request override → flow column → org default → system default).
   *
   * Cas d'usage : step de triage rapide avec un modèle léger/pas cher (e.g. Haiku),
   * suivi d'un step de rédaction avec un modèle puissant (e.g. Sonnet/Opus).
   */
  modelId?: string;

  /** Schema de l'output structuré du step (optionnel) */
  output?: {
    schema: JSONSchemaObject;
  };

  /** Condition d'exécution — expression évaluée (Phase 3) */
  condition?: string;
}
```

### 1.3 Contraintes de validation

| Règle | Détail |
|-------|--------|
| `id` unique | Chaque `steps[].id` doit être unique dans le tableau |
| `id` format | Slug : `/^[a-z][a-z0-9-]*$/` (pas de `@`, pas de `/`) |
| `prompt` existe | Le fichier référencé doit exister dans le ZIP |
| `prompt` non vide | Le contenu du fichier ne peut pas être vide |
| `providers` ⊆ `dependencies.providers` | Chaque provider d'un step doit être dans les dépendances globales |
| `skills` ⊆ `dependencies.skills` | Idem pour les skills |
| `tools` ⊆ `dependencies.tools` | Idem pour les tools |
| `steps.length` ≥ 2 | Un pipeline d'un seul step n'a pas de sens (utiliser un flow normal) |
| `steps.length` ≤ 20 | Limite raisonnable pour éviter les abus |
| `timeout` > 0 | Si spécifié |
| `modelId` valide | Si spécifié, doit référencer un modèle existant dans l'org (validé à l'exécution, pas à l'import — les modèles sont configurés per-org) |
| Somme timeouts ≤ flow timeout | La somme des timeouts individuels ne dépasse pas le timeout global |

### 1.4 Champ `routing` (Phase 3 — définition anticipée)

Défini ici pour le schema, mais ignoré à l'exécution jusqu'à la Phase 3.

```jsonc
"routing": [
  {
    "after": "enrich",                    // step ID après lequel évaluer
    "rules": [
      {
        "when": "output.company_size == 'small'",   // expression
        "goto": "notify",                            // saut vers un step
        "reason": "Skip qualification for small cos" // trace/log
      },
      {
        "when": "output.company_size == 'enterprise'",
        "goto": "qualify"
      }
    ],
    "default": "qualify"     // si aucune rule ne matche, aller ici (null = step suivant)
  },
  {
    "after": "qualify",
    "rules": [
      {
        "when": "output.qualified == false",
        "stop": true,                                // arrêt anticipé du flow
        "reason": "Lead not qualified"
      }
    ]
  }
]
```

---

## 2. Structure du ZIP `.afps`

### 2.1 Flow classique (inchangé)

```
package/
├── manifest.json
└── prompt.md
```

### 2.2 Flow avec steps

```
package/
├── manifest.json
├── prompt.md                  ← conservé, sert de "description longue" / fallback
├── steps/
│   ├── enrich.md
│   ├── qualify.md
│   └── notify.md
└── (skills, tools si embarqués)
```

**Convention** : les fichiers prompt des steps vivent dans `steps/` par convention, mais le chemin est libre (c'est `steps[].prompt` qui fait foi). Les chemins sont relatifs à la racine du ZIP.

### 2.3 Prompt legacy (`prompt.md`)

Quand `steps` est défini :
- `prompt.md` existe toujours (validation existante non cassée)
- Il sert de **description longue** du flow (README du pipeline)
- Il n'est **pas** injecté comme prompt d'exécution
- Chaque step utilise son propre fichier via `steps[].prompt`

---

## 3. Modifications `@appstrate/core/validation`

### 3.1 Zod schema

Le module `@appstrate/core/validation` est un package npm externe. Deux options :

**Option A** — Publier une nouvelle version de `@appstrate/core` avec le schema étendu.

**Option B** — Ajouter la validation côté plateforme dans `services/schema.ts` (plus rapide, pas de release npm).

**Recommandation : Option B pour le MVP**, avec migration vers Option A quand le format sera stabilisé.

### 3.2 Nouvelle fonction `validateSteps()`

Fichier : `apps/api/src/services/schema.ts`

```typescript
import type { JSONSchemaObject } from "@appstrate/shared-types";

const STEP_ID_REGEX = /^[a-z][a-z0-9-]*$/;
const MAX_STEPS = 20;
const MIN_STEPS = 2;

export interface StepDefinition {
  id: string;
  displayName: string;
  prompt: string;
  providers?: string[];
  skills?: string[];
  tools?: string[];
  timeout?: number;
  modelId?: string;
  output?: { schema: JSONSchemaObject };
  condition?: string;
}

export interface StepValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSteps(
  steps: StepDefinition[],
  manifest: {
    dependencies?: {
      providers?: Record<string, string>;
      skills?: Record<string, string>;
      tools?: Record<string, string>;
    };
    timeout?: number;
  },
  zipEntries: Set<string>,   // fichiers présents dans le ZIP
): StepValidationResult {
  const errors: string[] = [];

  // Taille du tableau
  if (steps.length < MIN_STEPS) {
    errors.push(`steps must have at least ${MIN_STEPS} entries`);
  }
  if (steps.length > MAX_STEPS) {
    errors.push(`steps cannot exceed ${MAX_STEPS} entries`);
  }

  // Unicité des IDs
  const ids = new Set<string>();
  for (const step of steps) {
    if (!STEP_ID_REGEX.test(step.id)) {
      errors.push(`step.id '${step.id}' must match /^[a-z][a-z0-9-]*$/`);
    }
    if (ids.has(step.id)) {
      errors.push(`step.id '${step.id}' is duplicated`);
    }
    ids.add(step.id);

    // displayName requis
    if (!step.displayName?.trim()) {
      errors.push(`step '${step.id}' must have a displayName`);
    }

    // Prompt file existe dans le ZIP
    if (!step.prompt?.trim()) {
      errors.push(`step '${step.id}' must have a prompt path`);
    } else if (!zipEntries.has(step.prompt)) {
      errors.push(`step '${step.id}' references prompt '${step.prompt}' which is not in the package`);
    }

    // Providers ⊆ dependencies.providers
    const globalProviders = new Set(Object.keys(manifest.dependencies?.providers ?? {}));
    for (const p of step.providers ?? []) {
      if (!globalProviders.has(p)) {
        errors.push(`step '${step.id}' references provider '${p}' not in flow dependencies`);
      }
    }

    // Skills ⊆ dependencies.skills
    const globalSkills = new Set(Object.keys(manifest.dependencies?.skills ?? {}));
    for (const s of step.skills ?? []) {
      if (!globalSkills.has(s)) {
        errors.push(`step '${step.id}' references skill '${s}' not in flow dependencies`);
      }
    }

    // Tools ⊆ dependencies.tools
    const globalTools = new Set(Object.keys(manifest.dependencies?.tools ?? {}));
    for (const t of step.tools ?? []) {
      if (!globalTools.has(t)) {
        errors.push(`step '${step.id}' references tool '${t}' not in flow dependencies`);
      }
    }

    // Timeout > 0
    if (step.timeout != null && step.timeout <= 0) {
      errors.push(`step '${step.id}' timeout must be > 0`);
    }
  }

  // Somme des timeouts individuels vs timeout global
  const globalTimeout = manifest.timeout ?? 300;
  const sumTimeouts = steps.reduce((sum, s) => sum + (s.timeout ?? 0), 0);
  if (sumTimeouts > 0 && sumTimeouts > globalTimeout) {
    errors.push(
      `sum of step timeouts (${sumTimeouts}s) exceeds flow timeout (${globalTimeout}s)`
    );
  }

  return { valid: errors.length === 0, errors };
}
```

---

## 4. Modifications `flow.schema.json`

Fichier : `apps/web/src/lib/schemas/flow.schema.json`

Ajout au niveau `properties` :

```jsonc
"steps": {
  "type": "array",
  "minItems": 2,
  "maxItems": 20,
  "items": {
    "type": "object",
    "properties": {
      "id": {
        "type": "string",
        "pattern": "^[a-z][a-z0-9-]*$"
      },
      "displayName": {
        "type": "string",
        "minLength": 1
      },
      "prompt": {
        "type": "string",
        "minLength": 1
      },
      "providers": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^@[a-z0-9]([a-z0-9-]*[a-z0-9])?\\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
        }
      },
      "skills": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^@[a-z0-9]([a-z0-9-]*[a-z0-9])?\\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
        }
      },
      "tools": {
        "type": "array",
        "items": {
          "type": "string",
          "pattern": "^@[a-z0-9]([a-z0-9-]*[a-z0-9])?\\/[a-z0-9]([a-z0-9-]*[a-z0-9])?$"
        }
      },
      "timeout": {
        "type": "number",
        "exclusiveMinimum": 0
      },
      "modelId": {
        "type": "string",
        "description": "Model ID override for this step. References an org-configured model. If omitted, uses the flow's model (standard cascade)."
      },
      "output": {
        "type": "object",
        "properties": {
          "schema": {
            "$ref": "#/$defs/jsonSchemaObject"
          }
        },
        "required": ["schema"]
      },
      "condition": {
        "type": "string"
      }
    },
    "required": ["id", "displayName", "prompt"],
    "additionalProperties": false
  }
},
"routing": {
  "type": "array",
  "items": {
    "type": "object",
    "properties": {
      "after": { "type": "string" },
      "rules": {
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "when": { "type": "string" },
            "goto": { "type": "string" },
            "stop": { "type": "boolean" },
            "reason": { "type": "string" }
          },
          "required": ["when"]
        }
      },
      "default": { "type": "string" }
    },
    "required": ["after", "rules"]
  }
}
```

> **Note** : Le `$ref` vers `jsonSchemaObject` devra être extrait comme `$defs` dans le schema existant pour éviter la duplication. Le schema actuel duplique la structure pour input/output/config — c'est l'occasion de factoriser.

---

## 5. Chargement des step prompts

### 5.1 Modification de `LoadedFlow`

Fichier : `apps/api/src/types/index.ts`

```typescript
export interface StepPrompt {
  id: string;
  displayName: string;
  prompt: string;          // contenu du .md
  providers: string[];
  skills: string[];
  tools: string[];
  timeout?: number;
  modelId?: string;        // override modèle IA pour ce step
  output?: { schema: JSONSchemaObject };
  condition?: string;
}

export interface LoadedFlow {
  id: string;
  manifest: FlowManifest;
  prompt: string;
  skills: SkillMeta[];
  tools: ToolMeta[];
  source: "system" | "local";
  steps?: StepPrompt[];    // ← NOUVEAU (undefined = flow classique)
}
```

### 5.2 Lecture des prompts depuis la DB

Les flows locaux stockent le prompt dans `packages.draftContent`. Avec les steps, deux approches possibles :

**Option A** — Stocker les prompts de step dans un nouveau champ JSONB `draftStepContents: Record<stepId, string>` sur la table `packages`.

**Option B** — Stocker les prompts comme un objet concaténé dans `draftContent` avec un délimiteur.

**Recommandation : Option A** — Ajouter une colonne `draft_step_contents JSONB` à la table `packages`. C'est propre, requêtable, et ne casse pas la colonne existante `draft_content` qui garde le prompt legacy.

### 5.3 Migration DB

```sql
ALTER TABLE packages ADD COLUMN draft_step_contents JSONB;
```

Drizzle schema (`packages.ts`) :

```typescript
draftStepContents: jsonb("draft_step_contents"),  // Record<stepId, string> | null
```

### 5.4 Chargement dans `flow-service.ts`

Modification de `dbRowToLoadedFlow()` pour lire les step contents :

```typescript
function dbRowToLoadedFlow(row: DbPackageRow): LoadedFlow {
  const manifest = row.draftManifest as FlowManifest;
  // ... (existing code) ...

  // Steps — merge manifest definitions with prompt contents from DB
  const rawSteps = (manifest as Record<string, unknown>).steps as StepDefinition[] | undefined;
  const stepContents = (row.draftStepContents ?? {}) as Record<string, string>;

  const steps: StepPrompt[] | undefined = rawSteps?.map((s) => ({
    id: s.id,
    displayName: s.displayName,
    prompt: stepContents[s.id] ?? "",
    providers: s.providers ?? [],
    skills: s.skills ?? [],
    tools: s.tools ?? [],
    timeout: s.timeout,
    output: s.output,
    condition: s.condition,
  }));

  return {
    id: row.id,
    manifest,
    prompt: row.draftContent,
    skills: depSkills,
    tools: depTools,
    source: (row.source as "system" | "local") ?? "local",
    steps,
  };
}
```

### 5.5 Chargement depuis ZIP (import / system packages)

Quand un package `.afps` contient des `steps`, le code d'import doit :
1. Lire `manifest.json` → extraire `steps[].prompt` (chemins)
2. Pour chaque step, lire le fichier `.md` correspondant dans le ZIP
3. Stocker dans `draft_step_contents` en DB

Fichier impacté : `services/package-storage.ts` et le code d'import ZIP existant.

---

## 6. Validation à l'import

### 6.1 Point d'intégration

La validation des steps s'insère dans le pipeline d'import existant, après la validation du manifest de base et avant le stockage :

```
extractManifest() → validateManifest() → [validateSteps()] → computeIntegrity() → store
```

### 6.2 Validation du contenu

En plus de `validateSteps()` (structure), valider :
- Chaque fichier prompt référencé existe dans le ZIP
- Chaque fichier prompt n'est pas vide (même règle que `prompt.md`)
- Pas de path traversal dans `steps[].prompt` (pas de `../`)

---

## 7. Tests

### 7.1 Tests unitaires

Fichier : `apps/api/test/unit/step-validation.test.ts`

```typescript
import { describe, it, expect } from "bun:test";
import { validateSteps } from "../../src/services/schema.ts";

describe("validateSteps", () => {
  const baseManifest = {
    dependencies: {
      providers: { "@appstrate/hubspot": "*", "@appstrate/gmail": "*" },
      skills: { "@acme/helpers": "^1.0.0" },
      tools: { "@acme/tool": "^1.0.0" },
    },
    timeout: 300,
  };
  const zipEntries = new Set(["steps/a.md", "steps/b.md", "steps/c.md"]);

  it("accepts a valid 2-step pipeline", () => { ... });
  it("rejects fewer than 2 steps", () => { ... });
  it("rejects more than 20 steps", () => { ... });
  it("rejects duplicate step IDs", () => { ... });
  it("rejects invalid step ID format", () => { ... });
  it("rejects missing prompt path", () => { ... });
  it("rejects prompt not in ZIP", () => { ... });
  it("rejects provider not in global dependencies", () => { ... });
  it("rejects skill not in global dependencies", () => { ... });
  it("rejects tool not in global dependencies", () => { ... });
  it("rejects if sum of timeouts exceeds flow timeout", () => { ... });
  it("allows steps without optional fields", () => { ... });
});
```

### 7.2 Tests d'intégration (import)

Fichier : `apps/api/test/integration/routes/flow-steps-import.test.ts`

Tester l'import d'un ZIP avec steps, vérifier que :
- Le manifest est correctement stocké avec `steps`
- Les prompt contents sont dans `draft_step_contents`
- La validation refuse les ZIPs invalides (prompt manquant, etc.)

---

## 8. Checklist de livraison

- [ ] Type `StepDefinition` dans `@appstrate/shared-types`
- [ ] Fonction `validateSteps()` dans `services/schema.ts`
- [ ] Extension `flow.schema.json` (steps + routing)
- [ ] Colonne `draft_step_contents` dans schema DB + migration
- [ ] `LoadedFlow.steps` dans `types/index.ts`
- [ ] `dbRowToLoadedFlow()` lit les step contents
- [ ] Import ZIP : extraction des step prompts
- [ ] Tests unitaires `validateSteps()` (10+ cases)
- [ ] Tests d'intégration import ZIP avec steps
- [ ] `bun run check` passe (TypeScript + OpenAPI)
