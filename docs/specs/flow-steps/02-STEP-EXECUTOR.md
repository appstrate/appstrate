# Phase 2 — Service d'exécution séquentielle

**Effort estimé** : ~3 jours
**Dépendances** : Phase 1 (manifest + validation + LoadedFlow.steps)
**Fichiers impactés** : `routes/executions.ts`, `services/adapters/`, `services/env-builder.ts`, `services/flow-readiness.ts`

---

## 1. Modèle d'exécution

### 1.1 Choix : N containers séquentiels

Chaque step lance un couple **sidecar + agent** dédié, identique au flow classique. Raisons :

| Critère | N containers (choisi) | Container unique |
|---------|-----------------------|-----------------|
| Isolation credentials | ✅ Chaque sidecar n'a que les tokens du step | ❌ Sidecar a tous les tokens |
| Réutilisation de `PiAdapter` | ✅ Aucune modification | ❌ Hot-swap d'agent à concevoir |
| Timeout granulaire | ✅ Natif (un timeout par step) | ⚠️ À implémenter manuellement |
| Latence | ⚠️ Boot ~3-5s × N | ✅ 1 seul boot |
| Sidecar pool | ✅ Amortit le coût de boot | N/A |

Le sidecar pool (`sidecar-pool.ts`) est déjà conçu pour amortir la latence de boot. Avec un pool de taille ≥ 2, le premier step boot pendant que le pool replenish pour le step suivant.

### 1.2 Flux de données entre steps

```
Flow Input (global)
       │
       ▼
┌─────────────────┐
│   Step "enrich"  │ ← prompt: steps/enrich.md
│   providers: [H] │ ← H = hubspot seulement
│                   │
│   output.data ────┼──→ { company_size: "enterprise", enriched_data: {...} }
└─────────────────┘
       │
       ▼  input = flow_input ∪ steps.enrich.output
┌─────────────────┐
│  Step "qualify"  │ ← prompt: steps/qualify.md
│  providers: [H]  │
│                   │
│  output.data ────┼──→ { score: 85, qualified: true }
└─────────────────┘
       │
       ▼  input = flow_input ∪ steps.enrich.output ∪ steps.qualify.output
┌─────────────────┐
│  Step "notify"   │ ← prompt: steps/notify.md
│  providers: [S,G]│ ← S = slack, G = gmail
└─────────────────┘
       │
       ▼
Flow Output (dernier step, ou agrégé)
```

Chaque step reçoit dans son prompt :
- L'**input global** du flow (inchangé)
- Les **outputs structurés** de tous les steps précédents
- Sa propre **config** (la config globale du flow)

---

## 2. Nouveau service : `services/step-executor.ts`

### 2.1 Signature

```typescript
/**
 * Execute a stepped flow — runs each step sequentially as an independent
 * container pair (sidecar + agent), passing structured outputs forward.
 *
 * Yields ExecutionMessages for the parent execution loop (same contract
 * as PiAdapter.execute).
 */
export async function* executeSteppedFlow(params: {
  executionId: string;
  actor: Actor;
  orgId: string;
  flow: LoadedFlow;
  promptContext: PromptContext;        // base context (global config, providers, model, etc.)
  flowPackage: Buffer | null;
  inputFiles?: UploadedFile[];
  signal?: AbortSignal;
}): AsyncGenerator<ExecutionMessage>;
```

### 2.2 Implémentation (pseudo-code annoté)

```typescript
export async function* executeSteppedFlow(params) {
  const { executionId, flow, promptContext, signal } = params;
  const steps = flow.steps!;   // garanti non-null par le caller

  // Accumulateur des outputs de chaque step, indexé par step.id
  const stepOutputs: Record<string, Record<string, unknown>> = {};

  // Report accumulé (chaque step peut contribuer)
  let globalReport = "";

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // ── Vérifier l'annulation ──
    if (signal?.aborted) return;

    // ── Émettre step_start ──
    yield {
      type: "step_start" as ExecutionMessage["type"],
      message: step.displayName,
      data: { stepId: step.id, stepIndex: i, totalSteps: steps.length },
    };

    // ── Résoudre le modèle IA du step (override ou héritage du flow) ──
    let stepLlmConfig = promptContext.llmConfig;  // default: modèle du flow
    if (step.modelId) {
      const resolvedModel = await resolveModel(orgId, flow.id, step.modelId);
      if (resolvedModel) {
        stepLlmConfig = {
          api: resolvedModel.api,
          baseUrl: resolvedModel.baseUrl,
          modelId: resolvedModel.modelId,
          apiKey: resolvedModel.apiKey,
          input: resolvedModel.input,
          contextWindow: resolvedModel.contextWindow,
          maxTokens: resolvedModel.maxTokens,
          reasoning: resolvedModel.reasoning,
          cost: resolvedModel.cost,
        };
      } else {
        yield {
          type: "progress",
          message: `Step "${step.displayName}": model '${step.modelId}' not found, using flow default`,
          level: "warn",
          data: { stepId: step.id },
        };
      }
    }

    // ── Construire le PromptContext spécifique au step ──
    const stepCtx = buildStepPromptContext({
      step,
      baseContext: promptContext,
      flow,
      globalInput: promptContext.input,
      previousStepOutputs: stepOutputs,
      stepIndex: i,
      llmConfig: stepLlmConfig,            // ← modèle potentiellement différent
    });

    // ── Filtrer le flowPackage pour ne garder que les skills/tools du step ──
    // (optionnel en V1 — on peut passer le package complet)
    const stepFlowPackage = params.flowPackage;

    // ── Exécuter le step via PiAdapter (réutilisation directe) ──
    const adapter = getAdapter();
    const stepTimeout = step.timeout ?? Math.floor((flow.manifest.timeout ?? 300) / steps.length);

    let stepReport = "";
    const stepData: Record<string, unknown> = {};
    let stepState: Record<string, unknown> | null = null;
    let lastError: string | null = null;

    try {
      for await (const msg of adapter.execute(
        executionId,                    // même executionId (logs groupés)
        stepCtx,
        stepTimeout,
        stepFlowPackage ?? undefined,
        signal,
        i === 0 ? params.inputFiles : undefined,  // fichiers injectés seulement au 1er step
      )) {
        // ── Préfixer les messages pour traçabilité ──
        switch (msg.type) {
          case "progress":
            yield { ...msg, data: { ...msg.data, stepId: step.id, stepIndex: i } };
            break;

          case "report":
          case "report_final":
            stepReport += (msg.content ?? "") + "\n\n";
            yield { ...msg, data: { stepId: step.id } };
            break;

          case "structured_output":
            if (msg.data) Object.assign(stepData, msg.data);
            yield { ...msg, data: { ...msg.data, stepId: step.id } };
            break;

          case "set_state":
            if (msg.data) stepState = msg.data;
            break;

          case "error":
            lastError = msg.message ?? null;
            yield { ...msg, data: { ...msg.data, stepId: step.id } };
            break;

          case "usage":
            // Forward usage as-is (coûts accumulés par le caller)
            yield msg;
            break;

          default:
            yield msg;
        }
      }
    } catch (err) {
      // ── Step timeout ou erreur ──
      yield {
        type: "step_complete" as ExecutionMessage["type"],
        message: `Step "${step.displayName}" failed`,
        data: {
          stepId: step.id,
          stepIndex: i,
          status: err instanceof TimeoutError ? "timeout" : "failed",
          error: err instanceof Error ? err.message : String(err),
        },
      };
      // Un step en échec arrête le pipeline (pas de "continue on error" en V1)
      throw err;
    }

    // ── Valider l'output du step (si schema défini) ──
    if (step.output?.schema && Object.keys(stepData).length > 0) {
      const validation = validateOutput(stepData, step.output.schema);
      if (!validation.valid) {
        yield {
          type: "progress",
          message: `Step "${step.displayName}" output validation warning`,
          data: { stepId: step.id, valid: false, errors: validation.errors },
          level: "warn",
        };
        // Warning, pas erreur bloquante (même comportement que les flows classiques)
      }
    }

    // ── Stocker l'output ──
    stepOutputs[step.id] = stepData;
    globalReport += stepReport;

    // ── Émettre step_complete ──
    yield {
      type: "step_complete" as ExecutionMessage["type"],
      message: `Step "${step.displayName}" completed`,
      data: {
        stepId: step.id,
        stepIndex: i,
        status: "success",
        hasOutput: Object.keys(stepData).length > 0,
        hasReport: stepReport.length > 0,
      },
    };
  }

  // ── Émettre le résultat final agrégé ──
  // Le report final est la concaténation des reports de chaque step
  if (globalReport.trim()) {
    yield { type: "report_final", content: globalReport.trim() };
  }

  // L'output structuré final est l'output du dernier step
  // (ou l'agrégation — à décider, mais le dernier step est le plus intuitif)
  const lastStep = steps[steps.length - 1];
  const finalOutput = stepOutputs[lastStep.id];
  if (finalOutput && Object.keys(finalOutput).length > 0) {
    yield { type: "structured_output", data: finalOutput };
  }

  // State final = agrégation de tous les states des steps
  const finalState: Record<string, unknown> = {};
  for (const [stepId, output] of Object.entries(stepOutputs)) {
    finalState[stepId] = output;
  }
  yield { type: "set_state", data: finalState };
}
```

---

## 3. Construction du PromptContext par step

### 3.1 Nouvelle fonction `buildStepPromptContext()`

Fichier : `services/step-prompt-builder.ts`

Cette fonction construit un `PromptContext` adapté au step en cours :

```typescript
export function buildStepPromptContext(params: {
  step: StepPrompt;
  baseContext: PromptContext;
  flow: LoadedFlow;
  globalInput: Record<string, unknown>;
  previousStepOutputs: Record<string, Record<string, unknown>>;
  stepIndex: number;
  llmConfig?: PromptContext["llmConfig"];  // override modèle par step
}): PromptContext {
  const { step, baseContext, flow, previousStepOutputs, stepIndex } = params;

  // 1. Filtrer les providers pour ne garder que ceux du step
  const stepProviderIds = new Set(step.providers);
  const filteredProviders = baseContext.providers.filter((p) => stepProviderIds.has(p.id));
  const filteredTokens: Record<string, string> = {};
  for (const [id, token] of Object.entries(baseContext.tokens)) {
    if (stepProviderIds.has(id)) filteredTokens[id] = token;
  }

  // 2. Filtrer les skills et tools pour ne garder que ceux du step
  const stepSkillIds = new Set(step.skills);
  const stepToolIds = new Set(step.tools);
  const filteredSkills = flow.skills.filter((s) => stepSkillIds.has(s.id));
  const filteredTools = flow.tools.filter((t) => stepToolIds.has(t.id));

  // 3. Construire un PromptContext avec le prompt du step
  return {
    rawPrompt: step.prompt,                          // prompt du step, pas du flow
    tokens: filteredTokens,                          // seulement les tokens du step
    config: baseContext.config,                       // config globale
    previousState: baseContext.previousState,         // state du flow
    executionApi: baseContext.executionApi,
    input: params.globalInput,                        // input global toujours disponible
    files: stepIndex === 0 ? baseContext.files : undefined,  // fichiers seulement au step 0
    schemas: {
      input: baseContext.schemas.input,               // schema input global (pour ref)
      config: baseContext.schemas.config,
      output: step.output?.schema,                    // schema output du STEP
    },
    providers: filteredProviders,
    memories: baseContext.memories,
    llmModel: (params.llmConfig ?? baseContext.llmConfig).modelId,
    llmConfig: params.llmConfig ?? baseContext.llmConfig,
    proxyUrl: baseContext.proxyUrl,
    timeout: step.timeout,
    availableTools: filteredTools.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    availableSkills: filteredSkills.map((s) => ({ id: s.id, name: s.name, description: s.description })),
    logsEnabled: baseContext.logsEnabled,
  };
}
```

### 3.2 Enrichissement du prompt par step

Modifier `buildEnrichedPrompt()` dans `prompt-builder.ts` pour détecter un contexte de step et ajouter des sections additionnelles :

```typescript
// À ajouter dans buildEnrichedPrompt(), avant le "--- raw prompt" final

// --- Step context (si applicable) ---
if (ctx._stepContext) {
  const { stepIndex, totalSteps, stepName, previousOutputs } = ctx._stepContext;

  sections.push(`## Pipeline Context\n`);
  sections.push(`You are executing **step ${stepIndex + 1} of ${totalSteps}**: "${stepName}".\n`);
  sections.push(
    `Complete your specific task, then use \`structured_output\` to return your results. ` +
    `Your output will be passed to the next step in the pipeline.\n`
  );

  if (Object.keys(previousOutputs).length > 0) {
    sections.push(`## Previous Steps Output\n`);
    sections.push(
      `The following data was produced by previous steps in this pipeline:\n`
    );
    sections.push("```json");
    sections.push(JSON.stringify(previousOutputs, null, 2));
    sections.push("```\n");
    sections.push(
      "Use this data as context for your task. Reference specific fields when needed.\n"
    );
  }
}
```

**Option de design** : Plutôt que d'étendre `PromptContext` avec un champ `_stepContext`, on peut ajouter un champ optionnel propre :

```typescript
// Dans types.ts
export interface PromptContext {
  // ... existant ...

  /** Step pipeline metadata (only set when executing a step within a pipeline) */
  stepContext?: {
    stepIndex: number;
    totalSteps: number;
    stepName: string;
    previousOutputs: Record<string, Record<string, unknown>>;
  };
}
```

---

## 4. Intégration dans `executeFlowInBackground`

### 4.1 Point de branchement

Fichier : `routes/executions.ts`, dans `executeFlowInBackground()`

Le branchement se fait **après** la construction du `promptContext` et **avant** la boucle `for await` sur l'adapter :

```typescript
// ── Existing code: adapter.execute() ──
// Remplacer par :

const hasSteps = (flow.steps?.length ?? 0) > 0;

if (hasSteps) {
  // Pipeline mode : délègue au step executor
  for await (const msg of executeSteppedFlow({
    executionId,
    actor: _actor,
    orgId,
    flow,
    promptContext,
    flowPackage: flowPackage ?? null,
    inputFiles,
    signal,
  })) {
    // ── Même traitement que le flow classique ──
    if (msg.usage) accumulateUsage(accumulated, msg.usage);
    if (msg.cost != null) accumulatedCost += msg.cost;

    switch (msg.type) {
      case "step_start":
      case "step_complete":
        // Loguer comme progress avec métadonnées de step
        await appendExecutionLog(
          executionId, orgId, "system", msg.type,
          msg.message ?? null, msg.data ?? null,
          msg.type === "step_complete" && msg.data?.status === "failed" ? "error" : "info",
        );
        break;

      // ... tous les autres cases identiques à l'existant ...
      case "progress":
      case "error":
      case "report":
      case "report_final":
      case "structured_output":
      case "set_state":
      case "add_memory":
        // Code existant inchangé
        break;
    }
  }
} else {
  // ── Classic mode (existing code, unchanged) ──
  for await (const msg of adapter.execute(...)) { ... }
}
```

### 4.2 Extension de `ExecutionMessage`

Fichier : `services/adapters/types.ts`

```typescript
export interface ExecutionMessage {
  type:
    | "progress"
    | "usage"
    | "error"
    | "report"
    | "report_final"
    | "structured_output"
    | "set_state"
    | "add_memory"
    | "step_start"      // ← NOUVEAU
    | "step_complete";  // ← NOUVEAU
  message?: string;
  data?: Record<string, unknown>;
  usage?: TokenUsage;
  cost?: number;
  level?: "debug" | "info" | "warn" | "error";
  content?: string;
}
```

---

## 5. Gestion des timeouts

### 5.1 Stratégie de timeout par step

Chaque step a son propre timeout. Si non spécifié, le timeout est calculé :

```typescript
const stepTimeout = step.timeout
  ?? Math.floor((flow.manifest.timeout ?? 300) / steps.length);
```

### 5.2 Timeout global

Le timeout global du flow reste en vigueur. Un `setTimeout` global dans `executeSteppedFlow` stoppe tout le pipeline si la somme des durées dépasse le timeout global.

```typescript
const globalTimeoutMs = (flow.manifest.timeout ?? 300) * 1000;
const globalTimer = setTimeout(() => {
  // Signal abort pour arrêter le step en cours
  // Le caller (executeFlowInBackground) gère le TimeoutError
}, globalTimeoutMs);

try {
  // ... boucle des steps ...
} finally {
  clearTimeout(globalTimer);
}
```

---

## 6. Validation de readiness par step

### 6.1 Extension de `validateFlowReadiness`

Fichier : `services/flow-readiness.ts`

Pour un flow avec steps, la validation doit vérifier que **chaque step** a ses providers/skills/tools installés et connectés :

```typescript
export async function validateFlowReadiness(params: { ... }): Promise<void> {
  const { flow, providerProfiles, orgId, config } = params;

  // Existing validations (1-5) remain unchanged...

  // 6. Steps validation (if stepped flow)
  if (flow.steps && flow.steps.length > 0) {
    for (const step of flow.steps) {
      // Validate each step prompt is not empty
      if (isPromptEmpty(step.prompt)) {
        throw new ApiError({
          status: 400,
          code: "empty_step_prompt",
          title: "Empty Step Prompt",
          detail: `Step '${step.id}' prompt is empty`,
        });
      }
    }
  }
}
```

> Note : La validation des providers connectés est déjà assurée au niveau global (les providers du step sont un sous-ensemble des providers globaux, qui sont tous validés).

---

## 7. Tests

### 7.1 Tests unitaires

Fichier : `apps/api/test/unit/step-executor.test.ts`

```typescript
import { describe, it, expect } from "bun:test";
import { buildStepPromptContext } from "../../src/services/step-prompt-builder.ts";

describe("buildStepPromptContext", () => {
  it("filters providers to step's subset", () => { ... });
  it("filters skills to step's subset", () => { ... });
  it("filters tools to step's subset", () => { ... });
  it("includes global input", () => { ... });
  it("uses step prompt instead of flow prompt", () => { ... });
  it("uses step output schema", () => { ... });
  it("includes files only on first step", () => { ... });
});
```

Fichier : `apps/api/test/unit/step-prompt-builder.test.ts`

```typescript
describe("buildEnrichedPrompt with stepContext", () => {
  it("adds pipeline context section", () => { ... });
  it("adds previous step outputs section", () => { ... });
  it("omits previous outputs on first step", () => { ... });
});
```

### 7.2 Tests d'intégration

Fichier : `apps/api/test/integration/services/step-execution.test.ts`

Ces tests nécessitent Docker et vérifient le cycle complet :
- Création d'un flow avec steps en DB
- Appel à `executeFlowInBackground` (ou via route `/run`)
- Vérification des logs `step_start` / `step_complete` en DB
- Vérification du résultat agrégé

> Note : Les tests d'intégration avec Docker sont lourds. En V1, prioriser les tests unitaires sur le prompt builder et le step context builder. Les tests d'intégration réels peuvent se faire en test manuel.

---

## 8. Cas limites

| Cas | Comportement |
|-----|-------------|
| Step échoue | Pipeline s'arrête, execution status = `failed`, error indique le step |
| Step timeout | Pipeline s'arrête, execution status = `timeout` |
| Annulation pendant un step | `signal.aborted` détecté, cleanup normal |
| Step sans output schema | Output non validé, mais toujours collecté si `structured_output` émis |
| Step sans structured_output | stepOutputs[id] = {} (objet vide, n'empêche pas la suite) |
| Flow avec steps + schedulé | Fonctionne identiquement (même `executeFlowInBackground`) |
| Flow avec steps + share link | Fonctionne identiquement (même path) |

---

## 9. Checklist de livraison

- [ ] `StepPrompt` type dans `types/index.ts`
- [ ] `stepContext` optionnel dans `PromptContext`
- [ ] `buildStepPromptContext()` dans `services/step-prompt-builder.ts`
- [ ] Extension `buildEnrichedPrompt()` pour le pipeline context
- [ ] `executeSteppedFlow()` dans `services/step-executor.ts`
- [ ] Branchement dans `executeFlowInBackground()` (stepped vs classic)
- [ ] `step_start` / `step_complete` dans `ExecutionMessage.type`
- [ ] Extension `validateFlowReadiness()` pour steps
- [ ] Tests unitaires : `buildStepPromptContext`, `buildEnrichedPrompt` avec step
- [ ] Tests unitaires : `executeSteppedFlow` (avec mock adapter)
- [ ] `bun run check` passe
