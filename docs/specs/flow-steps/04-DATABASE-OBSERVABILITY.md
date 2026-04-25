# Phase 4 — Database, Observabilité & SSE

**Effort estimé** : ~2 jours
**Dépendances** : Phase 1 (manifest), Phase 2 (step executor)
**Fichiers impactés** : `packages/db/src/schema/`, `services/state/executions.ts`, `services/realtime.ts`, `routes/executions.ts`, OpenAPI spec

---

## 1. Nouvelle table `execution_steps`

### 1.1 Objectif

Persister l'état de chaque step individuellement pour :
- Visualisation granulaire du pipeline dans l'UI
- Debug post-mortem (quel step a échoué, avec quel output ?)
- Agrégation de coûts par step
- Replay partiel (future : relancer à partir d'un step)

### 1.2 Schema Drizzle

Fichier : `packages/db/src/schema/executions.ts` (ajout dans le fichier existant)

```typescript
export const executionSteps = pgTable(
  "execution_steps",
  {
    id: serial("id").primaryKey(),
    executionId: text("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    orgId: uuid("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    stepId: text("step_id").notNull(),         // "enrich", "qualify", etc.
    stepIndex: integer("step_index").notNull(), // ordre effectif d'exécution
    displayName: text("display_name").notNull(),
    status: text("status").notNull().default("pending"),
    // pending | running | success | failed | timeout | skipped | stopped
    input: jsonb("input"),              // input reçu par le step (previous outputs)
    output: jsonb("output"),            // structured_output du step
    report: text("report"),             // report Markdown du step
    error: text("error"),
    tokensUsed: integer("tokens_used"),
    tokenUsage: jsonb("token_usage"),
    cost: doublePrecision("cost"),
    modelLabel: text("model_label"),      // label du modèle utilisé (peut différer du flow)
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    duration: integer("duration"),       // ms
    routingDecision: text("routing_decision"),  // "next" | "goto:stepId" | "stop" | null
  },
  (table) => [
    index("idx_exec_steps_execution_id").on(table.executionId),
    index("idx_exec_steps_org_id").on(table.orgId),
  ],
);
```

### 1.3 Migration

Generée via `bun run db:generate` après modification du schema. Le SQL produit sera :

```sql
CREATE TABLE "execution_steps" (
  "id" SERIAL PRIMARY KEY,
  "execution_id" TEXT NOT NULL REFERENCES "executions"("id") ON DELETE CASCADE,
  "org_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "step_id" TEXT NOT NULL,
  "step_index" INTEGER NOT NULL,
  "display_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "input" JSONB,
  "output" JSONB,
  "report" TEXT,
  "error" TEXT,
  "tokens_used" INTEGER,
  "token_usage" JSONB,
  "cost" DOUBLE PRECISION,
  "model_label" TEXT,
  "started_at" TIMESTAMP,
  "completed_at" TIMESTAMP,
  "duration" INTEGER,
  "routing_decision" TEXT
);
CREATE INDEX "idx_exec_steps_execution_id" ON "execution_steps" ("execution_id");
CREATE INDEX "idx_exec_steps_org_id" ON "execution_steps" ("org_id");
```

### 1.4 Export dans le barrel

Ajouter dans `packages/db/src/schema/executions.ts` (déjà le bon fichier).
Re-exporté automatiquement via `schema/index.ts`.

---

## 2. Fonctions d'état (state layer)

### 2.1 Nouveau fichier ou extension

**Recommandation** : Ajouter dans `services/state/executions.ts` (fichier existant) car c'est le même domaine.

### 2.2 Fonctions CRUD

```typescript
// --- Execution Steps ---

export async function createExecutionStep(
  executionId: string,
  orgId: string,
  stepId: string,
  stepIndex: number,
  displayName: string,
): Promise<number> {
  const [row] = await db
    .insert(executionSteps)
    .values({
      executionId,
      orgId,
      stepId,
      stepIndex,
      displayName,
      status: "running",
      startedAt: new Date(),
    })
    .returning({ id: executionSteps.id });
  return row!.id;
}

export async function updateExecutionStep(
  id: number,
  updates: {
    status?: string;
    output?: Record<string, unknown>;
    report?: string;
    error?: string;
    tokensUsed?: number;
    tokenUsage?: Record<string, unknown>;
    cost?: number;
    completedAt?: string;
    duration?: number;
    routingDecision?: string;
  },
): Promise<void> {
  const set: Record<string, unknown> = {};
  if (updates.status !== undefined) set.status = updates.status;
  if (updates.output !== undefined) set.output = updates.output;
  if (updates.report !== undefined) set.report = updates.report;
  if (updates.error !== undefined) set.error = updates.error;
  if (updates.tokensUsed !== undefined) set.tokensUsed = updates.tokensUsed;
  if (updates.tokenUsage !== undefined) set.tokenUsage = updates.tokenUsage;
  if (updates.cost !== undefined) set.cost = updates.cost;
  if (updates.completedAt !== undefined) set.completedAt = new Date(updates.completedAt);
  if (updates.duration !== undefined) set.duration = updates.duration;
  if (updates.routingDecision !== undefined) set.routingDecision = updates.routingDecision;

  await db.update(executionSteps).set(set).where(eq(executionSteps.id, id));
}

export async function listExecutionSteps(
  executionId: string,
  orgId: string,
) {
  return db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.executionId, executionId),
        eq(executionSteps.orgId, orgId),
      ),
    )
    .orderBy(executionSteps.stepIndex);
}
```

---

## 3. Intégration dans `step-executor.ts`

### 3.1 Persister les steps pendant l'exécution

Modifier `executeSteppedFlow()` pour écrire en DB à chaque transition :

```typescript
// Avant l'exécution du step
const stepRowId = await createExecutionStep(
  executionId, orgId, step.id, currentIndex, step.displayName,
);
const stepStartTime = Date.now();

// ... exécution du step ...

// Après l'exécution du step (succès)
const stepDuration = Date.now() - stepStartTime;
await updateExecutionStep(stepRowId, {
  status: "success",
  output: stepOutputs[step.id],
  report: stepReport || undefined,
  tokensUsed: stepTokens > 0 ? stepTokens : undefined,
  cost: stepCost > 0 ? stepCost : undefined,
  completedAt: new Date().toISOString(),
  duration: stepDuration,
  routingDecision: routingDecisionStr,
});

// En cas d'erreur
await updateExecutionStep(stepRowId, {
  status: err instanceof TimeoutError ? "timeout" : "failed",
  error: err instanceof Error ? err.message : String(err),
  completedAt: new Date().toISOString(),
  duration: Date.now() - stepStartTime,
});

// En cas de skip (condition)
await createExecutionStep(executionId, orgId, step.id, currentIndex, step.displayName);
await updateExecutionStep(stepRowId, { status: "skipped" });

// En cas de stop (routing)
// Les steps restants ne sont PAS créés en DB (on ne crée que les steps visités)
```

---

## 4. Logs groupés par step

### 4.1 Enrichissement des `execution_logs`

Les logs existants (`execution_logs`) n'ont pas de colonne `step_id`. Deux options :

**Option A** — Ajouter une colonne `step_id TEXT` à `execution_logs`.
**Option B** — Stocker le `stepId` dans le champ `data` (JSONB) existant.

**Recommandation : Option B** — Pas de migration supplémentaire. Le champ `data` contient déjà des métadonnées. Le `stepId` y est naturellement sa place. Le filtrage côté frontend se fait en mémoire (les logs d'une execution sont toujours chargés en entier).

Les logs émis par le step executor incluent déjà `stepId` dans `data` (Phase 2) :

```typescript
await appendExecutionLog(
  executionId, orgId, "progress", "progress",
  msg.message ?? null,
  { ...msg.data, stepId: step.id, stepIndex: i },  // ← stepId dans data
  msg.level ?? "debug",
);
```

### 4.2 Filtrage côté API (optionnel)

Ajouter un query param optionnel à `GET /api/executions/:id/logs` :

```typescript
// routes/executions.ts — GET /api/executions/:id/logs
const stepFilter = c.req.query("stepId");

let logs = await listExecutionLogs(execId, orgId);
if (stepFilter) {
  logs = logs.filter((l) => {
    const data = l.data as Record<string, unknown> | null;
    return data?.stepId === stepFilter;
  });
}
```

---

## 5. Nouveau endpoint : `GET /api/executions/:id/steps`

### 5.1 Route

Fichier : `routes/executions.ts`

```typescript
// GET /api/executions/:id/steps — get step-level details for a pipeline execution
router.get("/executions/:id/steps", async (c) => {
  const execId = c.req.param("id");
  const orgId = c.get("orgId");
  const exec = await getExecution(execId);
  if (!exec || exec.orgId !== orgId) {
    throw notFound("Execution not found");
  }
  // End-user scoping
  const endUser = c.get("endUser");
  if (endUser && exec.endUserId !== endUser.id) {
    throw notFound("Execution not found");
  }
  const steps = await listExecutionSteps(execId, orgId);
  return c.json(steps);
});
```

### 5.2 OpenAPI spec

Fichier : `apps/api/src/openapi/paths/executions.ts`

```typescript
"/api/executions/{id}/steps": {
  get: {
    operationId: "getExecutionSteps",
    tags: ["Executions"],
    summary: "Get execution pipeline steps",
    description: "Get step-level details for a pipeline execution. Returns empty array for non-pipeline executions.",
    parameters: [
      { $ref: "#/components/parameters/XOrgId" },
      { name: "id", in: "path", required: true, schema: { type: "string" } },
    ],
    responses: {
      "200": {
        description: "Step details",
        headers: {
          "Request-Id": { $ref: "#/components/headers/RequestId" },
          "Appstrate-Version": { $ref: "#/components/headers/AppstrateVersion" },
        },
        content: {
          "application/json": {
            schema: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  stepId: { type: "string" },
                  stepIndex: { type: "integer" },
                  displayName: { type: "string" },
                  status: {
                    type: "string",
                    enum: ["pending", "running", "success", "failed", "timeout", "skipped", "stopped"],
                  },
                  output: { type: "object" },
                  report: { type: "string" },
                  error: { type: "string" },
                  tokensUsed: { type: "integer" },
                  cost: { type: "number" },
                  modelLabel: { type: "string", description: "Model used for this step" },
                  startedAt: { type: "string", format: "date-time" },
                  completedAt: { type: "string", format: "date-time" },
                  duration: { type: "integer" },
                  routingDecision: { type: "string" },
                },
              },
            },
          },
        },
      },
      "401": { $ref: "#/components/responses/Unauthorized" },
      "404": { $ref: "#/components/responses/NotFound" },
    },
  },
},
```

---

## 6. SSE Realtime pour les steps

### 6.1 PG NOTIFY trigger

Ajouter un trigger NOTIFY sur `execution_steps` pour pousser les changements en temps réel :

```sql
-- Dans la migration
CREATE OR REPLACE FUNCTION notify_execution_step_change() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('execution_step_update', json_build_object(
    'id', NEW.id,
    'execution_id', NEW.execution_id,
    'org_id', NEW.org_id,
    'step_id', NEW.step_id,
    'step_index', NEW.step_index,
    'display_name', NEW.display_name,
    'status', NEW.status,
    'duration', NEW.duration,
    'routing_decision', NEW.routing_decision
  )::text);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER execution_step_notify
  AFTER INSERT OR UPDATE ON execution_steps
  FOR EACH ROW EXECUTE FUNCTION notify_execution_step_change();
```

### 6.2 LISTEN dans `realtime.ts`

Ajouter un nouveau channel dans `initRealtime()` :

```typescript
await listenClient.listen("execution_step_update", (payload) => {
  try {
    const raw = JSON.parse(payload) as Record<string, unknown>;
    const data = snakeToCamel(raw);
    for (const sub of subscribers.values()) {
      if (sub.filter.orgId !== raw.org_id) continue;
      if (sub.filter.executionId && sub.filter.executionId !== raw.execution_id) continue;
      sub.send({ event: "execution_step_update", data });
    }
  } catch (err) {
    logger.error("Failed to parse execution_step_update", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
```

### 6.3 Frontend SSE handling

Le frontend (`useExecutionRealtime`) recevra les events `execution_step_update` et pourra patcher le cache React Query pour mettre à jour la vue pipeline en temps réel. Détaillé en Phase 5.

---

## 7. Enrichissement de la réponse `GET /api/executions/:id`

### 7.1 Champ `steps` dans l'execution detail

Ajouter les steps au retour de `getExecutionFull()` pour que le frontend ait tout en un seul call :

```typescript
export async function getExecutionFull(id: string) {
  const [row] = await db
    .select({
      execution: executions,
      packageVersion: packageVersions.version,
    })
    .from(executions)
    .leftJoin(packageVersions, eq(executions.packageVersionId, packageVersions.id))
    .where(eq(executions.id, id))
    .limit(1);
  if (!row) return null;

  // Fetch steps (empty array for non-pipeline executions)
  const steps = await db
    .select()
    .from(executionSteps)
    .where(eq(executionSteps.executionId, id))
    .orderBy(executionSteps.stepIndex);

  return {
    ...row.execution,
    packageVersion: row.packageVersion,
    steps,   // ← NOUVEAU
  };
}
```

### 7.2 Type partagé

Fichier : `packages/shared-types/src/index.ts`

```typescript
export interface ExecutionStepInfo {
  id: number;
  stepId: string;
  stepIndex: number;
  displayName: string;
  status: "pending" | "running" | "success" | "failed" | "timeout" | "skipped" | "stopped";
  output?: Record<string, unknown>;
  report?: string;
  error?: string;
  tokensUsed?: number;
  cost?: number;
  modelLabel?: string;       // modèle utilisé pour ce step (si différent du flow)
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  routingDecision?: string;
}

// Étendre le type Execution existant
export type Execution = _Execution & {
  packageVersion?: string | null;
  steps?: ExecutionStepInfo[];
};
```

---

## 8. Test helpers

### 8.1 Seed factory

Fichier : `apps/api/test/helpers/seed.ts`

```typescript
// ─── Execution Steps ──────────────────────────────────────

type ExecutionStepInsert = Partial<InferInsertModel<typeof executionSteps>> & {
  executionId: string;
  orgId: string;
  stepId: string;
};

export async function seedExecutionStep(
  overrides: ExecutionStepInsert,
): Promise<InferSelectModel<typeof executionSteps>> {
  const [step] = await db
    .insert(executionSteps)
    .values({
      stepIndex: 0,
      displayName: overrides.stepId,
      status: "success",
      ...overrides,
    })
    .returning();
  return step!;
}
```

### 8.2 Cleanup

Ajouter `"execution_steps"` dans `ALL_TABLES` dans `test/helpers/db.ts`, **avant** `"executions"` (FK order).

---

## 9. Tests

### 9.1 Tests d'intégration — endpoint

Fichier : `apps/api/test/integration/routes/execution-steps.test.ts`

```typescript
describe("GET /api/executions/:id/steps", () => {
  it("returns 200 with steps for a pipeline execution", () => { ... });
  it("returns 200 with empty array for non-pipeline execution", () => { ... });
  it("returns 404 for unknown execution", () => { ... });
  it("returns 401 without auth", () => { ... });
  it("scopes by org", () => { ... });
  it("scopes by end-user", () => { ... });
});
```

### 9.2 Tests — state functions

Fichier : `apps/api/test/integration/services/execution-steps-state.test.ts`

```typescript
describe("execution steps state", () => {
  it("creates a step record", () => { ... });
  it("updates step status and output", () => { ... });
  it("lists steps in order", () => { ... });
});
```

---

## 10. Checklist de livraison

- [ ] Table `execution_steps` dans Drizzle schema
- [ ] Migration DB (`bun run db:generate` + `bun run db:migrate`)
- [ ] CRUD functions dans `services/state/executions.ts`
- [ ] PG NOTIFY trigger pour `execution_steps`
- [ ] `LISTEN` channel dans `realtime.ts`
- [ ] `GET /api/executions/:id/steps` endpoint
- [ ] OpenAPI path pour le nouvel endpoint
- [ ] Steps inclus dans `getExecutionFull()` response
- [ ] `ExecutionStepInfo` type dans `@appstrate/shared-types`
- [ ] `seedExecutionStep()` test helper
- [ ] `execution_steps` dans `truncateAll()` (FK-safe order)
- [ ] `stepId` query filter sur `GET /api/executions/:id/logs`
- [ ] Tests endpoint (6+ cases)
- [ ] Tests state functions (3+ cases)
- [ ] `bun run check` + `bun run verify:openapi` passent
