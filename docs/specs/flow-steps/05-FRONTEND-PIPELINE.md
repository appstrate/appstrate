# Phase 5 — Frontend Pipeline View

**Effort estimé** : ~3 jours
**Dépendances** : Phase 4 (DB + SSE + endpoint steps)
**Fichiers impactés** : `apps/web/src/components/`, `apps/web/src/hooks/`, `apps/web/src/locales/`

---

## 1. Architecture frontend

### 1.1 Composants à créer

```
apps/web/src/components/
├── pipeline-view/
│   ├── pipeline-timeline.tsx     # Composant principal : timeline verticale des steps
│   ├── step-card.tsx             # Card individuelle par step (status, duration, output)
│   ├── step-logs.tsx             # Logs filtrés par step (réutilise ExecutionTimeline)
│   ├── step-output-viewer.tsx    # Output structuré d'un step (réutilise ResultRenderer)
│   └── routing-badge.tsx         # Badge routing (→ goto, ⏹ stop, ⏭ skipped)
```

### 1.2 Composants existants réutilisés

| Composant | Usage |
|-----------|-------|
| `ExecutionTimeline` (`log-viewer.tsx`) | Logs d'un step individuel |
| `ResultRenderer` | Output structuré d'un step |
| `Spinner` | Step en cours |
| `cn()` (tailwind-merge) | Utility classes |
| `Badge` (shadcn) | Status badges |

---

## 2. Data flow

### 2.1 Hook : `useExecutionSteps`

Fichier : `apps/web/src/hooks/use-executions.ts` (ajout dans l'existant)

```typescript
export function useExecutionSteps(executionId: string | undefined) {
  const { orgId } = useOrgStore();
  return useQuery({
    queryKey: ["execution-steps", orgId, executionId],
    queryFn: () => api<ExecutionStepInfo[]>(`/executions/${executionId}/steps`),
    enabled: !!executionId && !!orgId,
  });
}
```

### 2.2 Realtime : SSE patch pour les steps

Fichier : `apps/web/src/hooks/use-realtime.ts` ou `use-global-execution-sync.ts`

Quand un event SSE `execution_step_update` arrive :

```typescript
// Dans le handler SSE
case "execution_step_update": {
  const stepData = event.data as ExecutionStepInfo;
  const execId = stepData.executionId;

  // Patch le cache React Query
  queryClient.setQueryData(
    ["execution-steps", orgId, execId],
    (old: ExecutionStepInfo[] | undefined) => {
      if (!old) return [stepData];
      const idx = old.findIndex((s) => s.stepId === stepData.stepId);
      if (idx === -1) return [...old, stepData];
      const updated = [...old];
      updated[idx] = { ...updated[idx], ...stepData };
      return updated;
    },
  );
  break;
}
```

### 2.3 React Query keys

```typescript
// Nouveau
["execution-steps", orgId, executionId]
```

Conforme à la convention existante `[entity, orgId, id?]`.

---

## 3. Composant `PipelineTimeline`

### 3.1 Design

Timeline verticale inspirée des CI/CD pipelines (GitHub Actions, GitLab CI) :

```
┌─────────────────────────────────┐
│ ● Enrichir le lead      ✅ 12s  │  ← step-card
│   ├─ Fetched HubSpot data       │  ← log preview (2-3 derniers)
│   └─ Output: { company_size: …} │  ← output summary
│              │                    │
│              ▼                    │
│ ● Qualifier le lead     ✅  8s   │
│   ├─ Score: 85                   │
│   └─ → goto: notify             │  ← routing badge
│              │                    │
│              ▼                    │
│ ● Notifier le commercial ⏳      │  ← step en cours (spinner)
│   └─ Sending Slack message...    │
└─────────────────────────────────┘
```

### 3.2 Implémentation

Fichier : `apps/web/src/components/pipeline-view/pipeline-timeline.tsx`

```tsx
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ExecutionStepInfo } from "@appstrate/shared-types";
import type { LogEntry } from "../log-utils";
import { StepCard } from "./step-card";

interface PipelineTimelineProps {
  steps: ExecutionStepInfo[];
  logEntries?: LogEntry[];
  isRunning?: boolean;
  onStepSelect?: (stepId: string) => void;
  selectedStepId?: string;
}

export function PipelineTimeline({
  steps,
  logEntries = [],
  isRunning,
  onStepSelect,
  selectedStepId,
}: PipelineTimelineProps) {
  const { t } = useTranslation(["flows"]);

  if (steps.length === 0) return null;

  return (
    <div className="space-y-0">
      <h3 className="text-sm font-medium text-muted-foreground mb-3">
        {t("pipeline.title")}
      </h3>
      <div className="relative">
        {/* Ligne verticale de connexion */}
        <div className="absolute left-4 top-6 bottom-6 w-px bg-border" />

        {steps.map((step, i) => {
          // Filtrer les logs par stepId
          const stepLogs = logEntries.filter(
            (l) => (l.data as Record<string, unknown>)?.stepId === step.stepId,
          );

          return (
            <StepCard
              key={step.stepId}
              step={step}
              logs={stepLogs}
              isLast={i === steps.length - 1}
              isSelected={selectedStepId === step.stepId}
              onClick={() => onStepSelect?.(step.stepId)}
            />
          );
        })}
      </div>
    </div>
  );
}
```

### 3.3 `StepCard`

Fichier : `apps/web/src/components/pipeline-view/step-card.tsx`

```tsx
import { cn } from "@/lib/utils";
import { Spinner } from "../spinner";
import { RoutingBadge } from "./routing-badge";
import type { ExecutionStepInfo } from "@appstrate/shared-types";
import type { LogEntry } from "../log-utils";

interface StepCardProps {
  step: ExecutionStepInfo;
  logs: LogEntry[];
  isLast: boolean;
  isSelected: boolean;
  onClick?: () => void;
}

const STATUS_ICONS: Record<string, { icon: string; color: string }> = {
  pending:  { icon: "○", color: "text-muted-foreground" },
  running:  { icon: "",  color: "text-primary" },  // spinner
  success:  { icon: "✓", color: "text-success" },
  failed:   { icon: "✗", color: "text-destructive" },
  timeout:  { icon: "⏱", color: "text-warning" },
  skipped:  { icon: "⏭", color: "text-muted-foreground" },
  stopped:  { icon: "⏹", color: "text-muted-foreground" },
};

export function StepCard({ step, logs, isLast, isSelected, onClick }: StepCardProps) {
  const status = STATUS_ICONS[step.status] ?? STATUS_ICONS.pending;
  const durationStr = step.duration
    ? step.duration < 1000
      ? `${step.duration}ms`
      : `${(step.duration / 1000).toFixed(1)}s`
    : "";

  return (
    <div
      className={cn(
        "relative pl-10 pb-4 cursor-pointer group",
        isSelected && "bg-muted/50 rounded-md",
      )}
      onClick={onClick}
    >
      {/* Status indicator */}
      <div className="absolute left-2 top-1 z-10">
        {step.status === "running" ? (
          <Spinner className="h-4 w-4" />
        ) : (
          <span className={cn("text-sm font-bold", status.color)}>
            {status.icon}
          </span>
        )}
      </div>

      {/* Content */}
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{step.displayName}</span>
        <div className="flex items-center gap-2">
          {step.modelLabel && (
            <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {step.modelLabel}
            </span>
          )}
          {step.routingDecision && (
            <RoutingBadge decision={step.routingDecision} />
          )}
          {durationStr && (
            <span className="text-xs text-muted-foreground">{durationStr}</span>
          )}
        </div>
      </div>

      {/* Log preview (last 2 entries) */}
      {logs.length > 0 && (
        <div className="mt-1 space-y-0.5">
          {logs.slice(-2).map((log, i) => (
            <p key={i} className="text-xs text-muted-foreground truncate">
              {log.message}
            </p>
          ))}
        </div>
      )}

      {/* Error message */}
      {step.error && (
        <p className="mt-1 text-xs text-destructive">{step.error}</p>
      )}
    </div>
  );
}
```

### 3.4 `RoutingBadge`

```tsx
import { Badge } from "@/components/ui/badge";

export function RoutingBadge({ decision }: { decision: string }) {
  if (decision === "next") return null;

  if (decision === "stop") {
    return (
      <Badge variant="outline" className="text-xs">
        ⏹ stopped
      </Badge>
    );
  }

  if (decision.startsWith("goto:")) {
    const target = decision.replace("goto:", "");
    return (
      <Badge variant="outline" className="text-xs">
        → {target}
      </Badge>
    );
  }

  return null;
}
```

---

## 4. Intégration dans la page de détail du flow

### 4.1 Point d'intégration

La page de détail d'un flow montre les exécutions récentes. Quand une exécution est sélectionnée et qu'elle a des steps, afficher le `PipelineTimeline` **au-dessus** du `ExecutionTimeline` classique.

Fichier principal : `apps/web/src/pages/` (la page de détail flow / execution detail)

```tsx
// Dans le composant d'affichage d'une exécution
const { data: steps } = useExecutionSteps(
  execution?.steps?.length ? execution.id : undefined,
);

return (
  <div className="space-y-4">
    {/* Pipeline view (si flow avec steps) */}
    {steps && steps.length > 0 && (
      <PipelineTimeline
        steps={steps}
        logEntries={logEntries}
        isRunning={execution.status === "running"}
        onStepSelect={setSelectedStepId}
        selectedStepId={selectedStepId}
      />
    )}

    {/* Logs détaillés du step sélectionné */}
    {selectedStepId && (
      <div>
        <h4 className="text-sm font-medium mb-2">
          {t("pipeline.stepLogs", { step: selectedStep?.displayName })}
        </h4>
        <ExecutionTimeline
          entries={filteredLogs}
          isRunning={selectedStep?.status === "running"}
        />
        {selectedStep?.output && (
          <StepOutputViewer output={selectedStep.output} />
        )}
      </div>
    )}

    {/* Résultat global (report + structured output) */}
    {!selectedStepId && execution.result && (
      <ResultRenderer
        report={execution.result.report}
        data={execution.result.data}
      />
    )}
  </div>
);
```

### 4.2 Détection flow avec steps

Le frontend détecte un flow avec steps via le manifest :

```typescript
const hasPipeline = (flow.manifest as Record<string, unknown>)?.steps != null;
```

Ou via la présence de `steps` dans la réponse execution detail (Phase 4).

---

## 5. `FlowRunCard` — adaptation pour les share links

Le composant `FlowRunCard` (utilisé pour les share links / public run page) doit aussi supporter la vue pipeline.

Modification minimale : si `logEntries` contiennent des `stepId` dans `data`, afficher un mini-pipeline au lieu du simple `ExecutionTimeline` :

```tsx
// Dans FlowRunCard, section "running"
{status === "running" && (
  steps.length > 0
    ? <PipelineTimeline steps={steps} logEntries={logEntries} isRunning />
    : <ExecutionTimeline entries={logEntries} isRunning />
)}
```

---

## 6. Localisation i18n

### 6.1 Français (`locales/fr/flows.json`)

```json
{
  "pipeline.title": "Pipeline",
  "pipeline.stepLogs": "Logs — {{step}}",
  "pipeline.stepOutput": "Output — {{step}}",
  "pipeline.status.pending": "En attente",
  "pipeline.status.running": "En cours",
  "pipeline.status.success": "Terminé",
  "pipeline.status.failed": "Échoué",
  "pipeline.status.timeout": "Timeout",
  "pipeline.status.skipped": "Ignoré",
  "pipeline.status.stopped": "Arrêté",
  "pipeline.routing.stop": "Pipeline arrêté",
  "pipeline.routing.goto": "Saut vers {{target}}",
  "pipeline.steps": "{{current}} / {{total}} étapes"
}
```

### 6.2 Anglais (`locales/en/flows.json`)

```json
{
  "pipeline.title": "Pipeline",
  "pipeline.stepLogs": "Logs — {{step}}",
  "pipeline.stepOutput": "Output — {{step}}",
  "pipeline.status.pending": "Pending",
  "pipeline.status.running": "Running",
  "pipeline.status.success": "Completed",
  "pipeline.status.failed": "Failed",
  "pipeline.status.timeout": "Timed out",
  "pipeline.status.skipped": "Skipped",
  "pipeline.status.stopped": "Stopped",
  "pipeline.routing.stop": "Pipeline stopped",
  "pipeline.routing.goto": "Jump to {{target}}",
  "pipeline.steps": "{{current}} / {{total}} steps"
}
```

---

## 7. Tests frontend

### 7.1 Tests unitaires

Fichier : `apps/web/src/components/pipeline-view/test/pipeline-timeline.test.tsx`

Suivant le pattern existant dans `apps/web/src/components/flow-editor/test/` :

```typescript
import { describe, it, expect } from "bun:test";
import type { ExecutionStepInfo } from "@appstrate/shared-types";

// Test data helpers
const makeStep = (overrides: Partial<ExecutionStepInfo>): ExecutionStepInfo => ({
  id: 1,
  stepId: "step-1",
  stepIndex: 0,
  displayName: "Test Step",
  status: "success",
  ...overrides,
});

describe("PipelineTimeline", () => {
  it("renders nothing when steps is empty", () => { ... });
  it("renders all steps in order", () => { ... });
  it("shows spinner for running step", () => { ... });
  it("shows error for failed step", () => { ... });
  it("shows routing badge for goto/stop", () => { ... });
  it("filters logs by stepId", () => { ... });
});
```

---

## 8. Checklist de livraison

- [ ] `useExecutionSteps()` hook dans `use-executions.ts`
- [ ] SSE handler pour `execution_step_update` events
- [ ] `PipelineTimeline` composant
- [ ] `StepCard` composant
- [ ] `RoutingBadge` composant
- [ ] `StepOutputViewer` composant (wrapper de `ResultRenderer`)
- [ ] Intégration dans la page d'exécution detail
- [ ] Adaptation de `FlowRunCard` pour le pipeline
- [ ] Clés i18n fr/en pour `pipeline.*`
- [ ] Tests unitaires composants pipeline
- [ ] `bun run check` passe (TypeScript frontend)
