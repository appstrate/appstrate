# Phase 6 — Éditeur de Steps

**Effort estimé** : ~5 jours
**Dépendances** : Phase 5 (frontend pipeline view), Phase 1 (manifest schema)
**Fichiers impactés** : `apps/web/src/components/flow-editor/`, `apps/web/src/hooks/`, `apps/web/src/locales/`

---

## 1. Vue d'ensemble

L'éditeur de steps permet de créer et configurer un flow pipeline directement dans l'UI Appstrate, sans écrire de JSON à la main. Il s'intègre dans le flow editor existant (`flow-editor/`) comme un nouvel onglet ou une section dédiée.

---

## 2. Architecture des composants

### 2.1 Nouveaux composants

```
apps/web/src/components/flow-editor/
├── (existants)
│   ├── metadata-section.tsx
│   ├── prompt-editor.tsx
│   ├── provider-picker.tsx
│   ├── resource-section.tsx
│   ├── schema-section.tsx
│   ├── execution-section.tsx
│   ├── types.ts
│   └── utils.ts
│
├── (nouveaux)
│   ├── steps-section.tsx          # Section principale : liste des steps + controls
│   ├── step-editor.tsx            # Éditeur d'un step (modale ou panneau inline)
│   ├── step-prompt-editor.tsx     # Éditeur de prompt par step (Monaco)
│   ├── step-provider-picker.tsx   # Sélecteur de providers par step (sous-ensemble)
│   ├── step-resource-picker.tsx   # Sélecteur de skills/tools par step (sous-ensemble)
│   ├── step-output-schema.tsx     # Éditeur de schema output par step
│   ├── step-condition-editor.tsx  # Éditeur de condition (Phase 3)
│   └── routing-editor.tsx         # Éditeur visuel du routing (Phase 3)
```

### 2.2 Interaction avec le flow editor existant

Le flow editor fonctionne avec un `FlowFormState` (défini dans `types.ts`). On l'étend :

```typescript
// types.ts — extension
export interface StepFormState {
  _id: string;               // UUID local pour la key React + dnd-kit
  id: string;                // slug (step ID dans le manifest)
  displayName: string;
  prompt: string;            // contenu du prompt Markdown
  providers: string[];       // subset des providers du flow
  skills: string[];          // subset des skills du flow
  tools: string[];           // subset des tools du flow
  timeout?: number;
  modelId?: string;          // override modèle IA (ref org model ID)
  outputSchema: SchemaField[];
  condition?: string;
}

export interface FlowFormState {
  // ... (existants) ...
  steps: StepFormState[];   // ← NOUVEAU ([] = flow classique)
}
```

### 2.3 Mise à jour de `defaultFormState()`

```typescript
export function defaultFormState(orgSlug?: string, userEmail?: string): FlowFormState {
  return {
    // ... existant ...
    steps: [],   // par défaut : flow classique (pas de pipeline)
  };
}
```

---

## 3. `StepsSection` — Composant principal

### 3.1 Design

Mode toggle : le flow editor propose un switch **"Mode simple / Mode pipeline"**.

- **Mode simple** (défaut) : onglet "Prompt" classique, un seul prompt
- **Mode pipeline** : section "Steps" avec la liste des steps, chacun éditable

Le switch est **irréversible dans un sens** : passer de simple à pipeline crée 1 step initial avec le prompt existant. Passer de pipeline à simple supprime tous les steps (avec confirmation).

### 3.2 Implémentation

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { DndContext, closestCenter } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { StepFormState, ProviderEntry, ResourceEntry } from "./types";
import { StepEditor } from "./step-editor";

interface StepsSectionProps {
  steps: StepFormState[];
  onChange: (steps: StepFormState[]) => void;
  flowProviders: ProviderEntry[];        // providers disponibles (du flow)
  flowSkills: ResourceEntry[];            // skills disponibles
  flowTools: ResourceEntry[];             // tools disponibles
  availableModels: OrgModelInfo[];        // modèles configurés dans l'org (pour le select par step)
}

export function StepsSection({
  steps,
  onChange,
  flowProviders,
  flowSkills,
  flowTools,
}: StepsSectionProps) {
  const { t } = useTranslation(["flows"]);
  const [expandedStep, setExpandedStep] = useState<string | null>(null);

  const addStep = () => {
    const newStep: StepFormState = {
      _id: crypto.randomUUID(),
      id: `step-${steps.length + 1}`,
      displayName: "",
      prompt: "",
      providers: [],
      skills: [],
      tools: [],
      outputSchema: [],
    };
    onChange([...steps, newStep]);
    setExpandedStep(newStep._id);
  };

  const removeStep = (stepId: string) => {
    onChange(steps.filter((s) => s._id !== stepId));
  };

  const updateStep = (stepId: string, updates: Partial<StepFormState>) => {
    onChange(steps.map((s) => (s._id === stepId ? { ...s, ...updates } : s)));
  };

  const handleDragEnd = (event: { active: { id: string }; over: { id: string } | null }) => {
    if (!event.over || event.active.id === event.over.id) return;
    const oldIndex = steps.findIndex((s) => s._id === event.active.id);
    const newIndex = steps.findIndex((s) => s._id === event.over!.id);
    const reordered = [...steps];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved!);
    onChange(reordered);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">{t("editor.steps.title")}</h3>
        <Button variant="outline" size="sm" onClick={addStep}>
          {t("editor.steps.add")}
        </Button>
      </div>

      <DndContext collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext
          items={steps.map((s) => s._id)}
          strategy={verticalListSortingStrategy}
        >
          {steps.map((step, i) => (
            <StepEditor
              key={step._id}
              step={step}
              index={i}
              isExpanded={expandedStep === step._id}
              onExpand={() => setExpandedStep(step._id === expandedStep ? null : step._id)}
              onChange={(updates) => updateStep(step._id, updates)}
              onRemove={() => removeStep(step._id)}
              availableProviders={flowProviders}
              availableSkills={flowSkills}
              availableTools={flowTools}
            />
          ))}
        </SortableContext>
      </DndContext>

      {steps.length === 0 && (
        <p className="text-sm text-muted-foreground text-center py-8">
          {t("editor.steps.empty")}
        </p>
      )}

      {steps.length === 1 && (
        <p className="text-sm text-warning text-center">
          {t("editor.steps.needsTwo")}
        </p>
      )}
    </div>
  );
}
```

> **Note** : Le projet utilise déjà `@dnd-kit/core` et `@dnd-kit/sortable` (vus dans les dépendances du `package.json`). On réutilise le même pattern.

---

## 4. `StepEditor` — Éditeur d'un step

### 4.1 Design

Chaque step est une **card collapsible** avec un handle de drag. Quand expanded :

```
┌────────────────────────────────────────────┐
│ ≡  ①  Enrichir le lead                  ✕  │  ← header (drag handle, index, name, delete)
├────────────────────────────────────────────┤
│ ID:          [enrich        ]              │  ← slug auto-généré depuis displayName
│ Nom:         [Enrichir le lead]            │
│                                             │
│ Prompt:                                     │
│ ┌──────────────────────────────────────┐   │
│ │ (Monaco editor)                       │   │  ← éditeur Markdown
│ │ Tu es un expert enrichissement...     │   │
│ └──────────────────────────────────────┘   │
│                                             │
│ Providers:   [✓ @appstrate/hubspot]        │  ← checkboxes parmi les providers du flow
│              [✓ @appstrate/google-sheets]  │
│              [  @appstrate/slack]           │
│                                             │
│ Skills:      [✓ @acme/crm-helpers]         │  ← checkboxes
│                                             │
│ Modèle IA:    [Par défaut (hérité du flow) ▾] │  ← select parmi les modèles org
│              [Claude Haiku           ▾]     │
│                                             │
│ Output Schema: (optionnel)                 │
│ ┌──────────────────────────────────────┐   │
│ │ + Add field                           │   │  ← réutilise SchemaSection
│ └──────────────────────────────────────┘   │
│                                             │
│ Timeout:     [120] seconds (optionnel)     │
└────────────────────────────────────────────┘
```

### 4.2 Implémentation clé

```tsx
// step-editor.tsx (résumé)

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { MonacoEditor } from "@monaco-editor/react";
import { SchemaSection } from "./schema-section";

interface StepEditorProps {
  step: StepFormState;
  index: number;
  isExpanded: boolean;
  onExpand: () => void;
  onChange: (updates: Partial<StepFormState>) => void;
  onRemove: () => void;
  availableProviders: ProviderEntry[];
  availableSkills: ResourceEntry[];
  availableTools: ResourceEntry[];
  availableModels: OrgModelInfo[];       // modèles configurés dans l'org
}

export function StepEditor({
  step,
  index,
  isExpanded,
  onExpand,
  onChange,
  onRemove,
  availableProviders,
  availableSkills,
  availableTools,
}: StepEditorProps) {
  const { attributes, listeners, setNodeRef, transform, transition } =
    useSortable({ id: step._id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  // Auto-generate slug from displayName
  const handleNameChange = (displayName: string) => {
    const id = displayName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    onChange({ displayName, id: id || step.id });
  };

  return (
    <div ref={setNodeRef} style={style} className="border rounded-lg">
      {/* Header (always visible) */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer"
        onClick={onExpand}
      >
        <span {...attributes} {...listeners} className="cursor-grab text-muted-foreground">≡</span>
        <span className="text-xs font-mono text-muted-foreground w-6">
          {index + 1}
        </span>
        <span className="flex-1 font-medium text-sm">
          {step.displayName || t("editor.steps.untitled")}
        </span>
        <StatusBadge step={step} />
        <Button variant="ghost" size="icon" onClick={(e) => { e.stopPropagation(); onRemove(); }}>
          ✕
        </Button>
      </div>

      {/* Body (expanded) */}
      {isExpanded && (
        <div className="px-4 pb-4 space-y-4 border-t">
          {/* ID + Name */}
          <div className="grid grid-cols-2 gap-4 pt-4">
            <div>
              <label className="text-xs text-muted-foreground">{t("editor.steps.id")}</label>
              <Input value={step.id} onChange={(e) => onChange({ id: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t("editor.steps.name")}</label>
              <Input value={step.displayName} onChange={(e) => handleNameChange(e.target.value)} />
            </div>
          </div>

          {/* Prompt editor (Monaco) */}
          <div>
            <label className="text-xs text-muted-foreground">{t("editor.steps.prompt")}</label>
            <div className="h-48 border rounded-md overflow-hidden">
              <MonacoEditor
                language="markdown"
                value={step.prompt}
                onChange={(v) => onChange({ prompt: v ?? "" })}
                theme="vs-dark"
                options={{ minimap: { enabled: false }, lineNumbers: "off", wordWrap: "on" }}
              />
            </div>
          </div>

          {/* Provider checkboxes */}
          <div>
            <label className="text-xs text-muted-foreground">{t("editor.steps.providers")}</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {availableProviders.map((p) => (
                <label key={p.id} className="flex items-center gap-1.5 text-sm">
                  <input
                    type="checkbox"
                    checked={step.providers.includes(p.id)}
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...step.providers, p.id]
                        : step.providers.filter((id) => id !== p.id);
                      onChange({ providers: next });
                    }}
                  />
                  {p.id}
                </label>
              ))}
            </div>
          </div>

          {/* Skills checkboxes (same pattern) */}
          {/* Tools checkboxes (same pattern) */}

          {/* Model selector */}
          <div>
            <label className="text-xs text-muted-foreground">{t("editor.steps.model")}</label>
            <Select
              value={step.modelId ?? ""}
              onValueChange={(v) => onChange({ modelId: v || undefined })}
            >
              <SelectTrigger className="mt-1">
                <SelectValue placeholder={t("editor.steps.modelDefault")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">{t("editor.steps.modelDefault")}</SelectItem>
                {availableModels
                  .filter((m) => m.enabled)
                  .map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.label} ({m.modelId})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          </div>

          {/* Output schema (reuse SchemaSection) */}
          <SchemaSection
            label={t("editor.steps.outputSchema")}
            fields={step.outputSchema}
            onChange={(fields) => onChange({ outputSchema: fields })}
            mode="output"
          />

          {/* Timeout */}
          <div className="flex items-center gap-2">
            <label className="text-xs text-muted-foreground">{t("editor.steps.timeout")}</label>
            <Input
              type="number"
              className="w-24"
              value={step.timeout ?? ""}
              placeholder="auto"
              onChange={(e) => onChange({ timeout: e.target.value ? Number(e.target.value) : undefined })}
            />
            <span className="text-xs text-muted-foreground">s</span>
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## 5. Sérialisation : `assemblePayload` + `detailToFormState`

### 5.1 Extension de `assemblePayload` (dans `utils.ts`)

```typescript
// Dans assemblePayload()

// Steps
if (state.steps.length >= 2) {
  manifest.steps = state.steps.map((s) => {
    const step: Record<string, unknown> = {
      id: s.id,
      displayName: s.displayName,
      prompt: `steps/${s.id}.md`,   // convention: steps/{id}.md
    };
    if (s.providers.length > 0) step.providers = s.providers;
    if (s.skills.length > 0) step.skills = s.skills;
    if (s.tools.length > 0) step.tools = s.tools;
    if (s.timeout) step.timeout = s.timeout;
    if (s.modelId) step.modelId = s.modelId;

    const outputSchema = fieldsToSchema(s.outputSchema, "output");
    if (outputSchema) step.output = { schema: outputSchema };
    if (s.condition) step.condition = s.condition;

    return step;
  });
} else {
  delete manifest.steps;
}

// Le payload inclut aussi les contenus des step prompts (séparément du manifest)
const stepContents: Record<string, string> = {};
for (const s of state.steps) {
  stepContents[s.id] = s.prompt;
}

return {
  manifest,
  prompt: state.prompt,        // prompt legacy (conservé)
  stepContents,                // ← NOUVEAU
};
```

### 5.2 Extension de `detailToFormState` (dans `utils.ts`)

```typescript
// Dans detailToFormState()

// Steps
const rawSteps = (m.steps ?? []) as Array<Record<string, unknown>>;
const stepContentsRaw = (detail as Record<string, unknown>).stepContents as Record<string, string> | undefined;

const steps: StepFormState[] = rawSteps.map((s) => ({
  _id: crypto.randomUUID(),
  id: (s.id as string) ?? "",
  displayName: (s.displayName as string) ?? "",
  prompt: stepContentsRaw?.[(s.id as string)] ?? "",
  providers: (s.providers as string[]) ?? [],
  skills: (s.skills as string[]) ?? [],
  tools: (s.tools as string[]) ?? [],
  timeout: s.timeout as number | undefined,
  modelId: s.modelId as string | undefined,
  outputSchema: schemaToFields(
    (s.output as { schema?: JSONSchemaObject })?.schema,
    "output",
  ),
  condition: s.condition as string | undefined,
}));

return {
  // ... existant ...
  steps,
};
```

### 5.3 API : envoi des step contents

Le endpoint `PUT /api/flows/:scope/:name` (update flow) doit accepter `stepContents` en plus de `manifest` et `prompt` :

```typescript
// routes/flows.ts — PUT handler
const { manifest, prompt, stepContents } = await c.req.json();

// Stocker stepContents dans packages.draft_step_contents
await updateOrgItem(id, {
  manifest,
  content: prompt,
}, expectedVersion);

// Mise à jour séparée de draft_step_contents (si fourni)
if (stepContents) {
  await db.update(packages)
    .set({ draftStepContents: stepContents })
    .where(eq(packages.id, id));
}
```

### 5.4 API : lecture des step contents

Le endpoint `GET /api/flows/:scope/:name` (flow detail) doit retourner `stepContents` :

```typescript
// Ajouter dans la réponse du flow detail
stepContents: pkg.draftStepContents ?? undefined,
```

Ajouter le champ dans `FlowDetail` (`@appstrate/shared-types`) :

```typescript
export interface FlowDetail {
  // ... existant ...
  stepContents?: Record<string, string>;
}
```

---

## 6. Mode pipeline toggle

### 6.1 Switch dans l'éditeur

Un toggle dans les onglets de l'éditeur :

```tsx
// Dans le flow editor, section tabs ou header
<div className="flex items-center gap-2">
  <Switch
    checked={isPipeline}
    onCheckedChange={handlePipelineToggle}
  />
  <span className="text-sm">{t("editor.pipelineMode")}</span>
</div>
```

### 6.2 Logique du toggle

```typescript
const isPipeline = formState.steps.length > 0;

const handlePipelineToggle = (enabled: boolean) => {
  if (enabled) {
    // Créer un step initial avec le prompt existant
    setFormState((prev) => ({
      ...prev,
      steps: [
        {
          _id: crypto.randomUUID(),
          id: "step-1",
          displayName: prev.metadata.displayName || "Step 1",
          prompt: prev.prompt,
          providers: prev.providers.map((p) => p.id),
          skills: prev.skills.map((s) => s.id),
          tools: prev.tools.map((t) => t.id),
          outputSchema: [],
        },
      ],
    }));
  } else {
    // Confirmation requise
    if (confirm(t("editor.steps.disableConfirm"))) {
      // Restaurer le prompt du premier step
      const firstStepPrompt = formState.steps[0]?.prompt ?? "";
      setFormState((prev) => ({
        ...prev,
        prompt: firstStepPrompt || prev.prompt,
        steps: [],
      }));
    }
  }
};
```

### 6.3 Masquage de l'onglet Prompt

Quand le mode pipeline est actif, l'onglet "Prompt" classique est **masqué** (chaque step a son propre prompt dans le step editor). L'onglet `EditorTab` existant conditionne l'affichage :

```typescript
const availableTabs: EditorTab[] = isPipeline
  ? ["general", "providers", "schema", "skills", "tools", "json"]   // pas de "prompt"
  : ["general", "prompt", "providers", "schema", "skills", "tools", "json"];
```

> En mode pipeline, un nouvel onglet "Steps" (ou "Pipeline") remplace "Prompt".

---

## 7. Localisation i18n

### 7.1 Français

```json
{
  "editor.pipelineMode": "Mode pipeline",
  "editor.steps.title": "Étapes du pipeline",
  "editor.steps.add": "Ajouter une étape",
  "editor.steps.empty": "Aucune étape. Ajoutez au moins 2 étapes pour créer un pipeline.",
  "editor.steps.needsTwo": "Un pipeline nécessite au moins 2 étapes.",
  "editor.steps.untitled": "Étape sans titre",
  "editor.steps.id": "Identifiant",
  "editor.steps.name": "Nom affiché",
  "editor.steps.prompt": "Prompt",
  "editor.steps.providers": "Providers",
  "editor.steps.skills": "Skills",
  "editor.steps.tools": "Tools",
  "editor.steps.outputSchema": "Schema de sortie",
  "editor.steps.timeout": "Timeout",
  "editor.steps.model": "Modèle IA",
  "editor.steps.modelDefault": "Par défaut (hérité du flow)",
  "editor.steps.condition": "Condition d'exécution",
  "editor.steps.disableConfirm": "Désactiver le mode pipeline ? Le prompt du premier step sera restauré. Les autres steps seront perdus.",
  "editor.steps.deleteConfirm": "Supprimer l'étape \"{{name}}\" ?"
}
```

### 7.2 Anglais

```json
{
  "editor.pipelineMode": "Pipeline mode",
  "editor.steps.title": "Pipeline Steps",
  "editor.steps.add": "Add step",
  "editor.steps.empty": "No steps. Add at least 2 steps to create a pipeline.",
  "editor.steps.needsTwo": "A pipeline requires at least 2 steps.",
  "editor.steps.untitled": "Untitled step",
  "editor.steps.id": "Identifier",
  "editor.steps.name": "Display name",
  "editor.steps.prompt": "Prompt",
  "editor.steps.providers": "Providers",
  "editor.steps.skills": "Skills",
  "editor.steps.tools": "Tools",
  "editor.steps.outputSchema": "Output schema",
  "editor.steps.timeout": "Timeout",
  "editor.steps.model": "AI Model",
  "editor.steps.modelDefault": "Default (inherited from flow)",
  "editor.steps.condition": "Execution condition",
  "editor.steps.disableConfirm": "Disable pipeline mode? The first step's prompt will be restored. Other steps will be lost.",
  "editor.steps.deleteConfirm": "Delete step \"{{name}}\"?"
}
```

---

## 8. Routing Editor (sous-feature, post-MVP)

Le routing editor est le composant le plus complexe. En V1, le routing est configurable uniquement via l'onglet JSON. Un éditeur visuel peut être ajouté ultérieurement :

### 8.1 Design futur

```
┌─────────────────────────────────────────┐
│  Routing Rules                           │
│                                          │
│  After: [enrich ▾]                       │
│                                          │
│  Rule 1:                                 │
│  When: [output.company_size] [==] [small]│
│  Action: [→ Go to: notify ▾]            │
│                                          │
│  Rule 2:                                 │
│  When: [output.company_size] [==] [enterprise]
│  Action: [→ Go to: qualify ▾]           │
│                                          │
│  Default: [qualify ▾]                    │
│                                          │
│  [+ Add routing block]                   │
└─────────────────────────────────────────┘
```

### 8.2 Implémentation (future)

Un `RoutingEditor` composant avec :
- Select pour le step "after"
- Builder d'expressions avec auto-complete des champs du step output
- Select pour action (goto / stop)
- Select pour target step (filtré : pas de backward)

---

## 9. Tests

### 9.1 Tests unitaires

Fichier : `apps/web/src/components/flow-editor/test/steps-utils.test.ts`

```typescript
describe("steps serialization", () => {
  it("assemblePayload includes steps in manifest", () => { ... });
  it("assemblePayload omits steps when empty", () => { ... });
  it("assemblePayload generates correct step prompt paths", () => { ... });
  it("detailToFormState parses steps from manifest", () => { ... });
  it("detailToFormState handles flow without steps", () => { ... });
  it("roundtrip: assemble → parse → assemble is stable", () => { ... });
});
```

### 9.2 Tests d'intégration

Fichier : `apps/api/test/integration/routes/flow-step-editor.test.ts`

```typescript
describe("PUT /api/flows/:scope/:name with steps", () => {
  it("saves manifest with steps", () => { ... });
  it("saves step contents in draft_step_contents", () => { ... });
  it("rejects invalid steps (< 2)", () => { ... });
  it("rejects step with provider not in flow deps", () => { ... });
  it("GET returns stepContents", () => { ... });
});
```

---

## 10. Checklist de livraison

- [ ] `StepFormState` type dans `flow-editor/types.ts`
- [ ] `steps: StepFormState[]` dans `FlowFormState`
- [ ] `StepsSection` composant (liste + dnd-kit reorder)
- [ ] `StepEditor` composant (card collapsible, Monaco, checkboxes)
- [ ] Extension `assemblePayload()` pour steps
- [ ] Extension `detailToFormState()` pour steps
- [ ] `stepContents` dans `FlowDetail` shared type
- [ ] API : `PUT` accept `stepContents` + stockage DB
- [ ] API : `GET` retourne `stepContents`
- [ ] Mode pipeline toggle (switch + migration prompt)
- [ ] Masquage onglet "Prompt" en mode pipeline
- [ ] Clés i18n fr/en pour `editor.steps.*`
- [ ] Tests unitaires sérialisation steps
- [ ] Tests d'intégration API update/read avec steps
- [ ] `bun run check` passe
