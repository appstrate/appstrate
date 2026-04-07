# Phase 3 — Routing Engine (branchement conditionnel)

**Effort estimé** : ~2 jours
**Dépendances** : Phase 2 (step executor fonctionnel)
**Fichiers impactés** : `services/step-executor.ts`, `services/routing-engine.ts` (nouveau)

---

## 1. Rappel du format `routing`

Défini dans le manifest (Phase 1), le routing est un tableau de règles évaluées entre chaque step :

```jsonc
"routing": [
  {
    "after": "enrich",
    "rules": [
      { "when": "output.company_size == 'small'", "goto": "notify" },
      { "when": "output.company_size == 'enterprise'", "goto": "qualify" }
    ],
    "default": "qualify"
  },
  {
    "after": "qualify",
    "rules": [
      { "when": "output.qualified == false", "stop": true, "reason": "Lead not qualified" }
    ]
  }
]
```

---

## 2. Langage d'expressions

### 2.1 Choix technique

**Pas de `eval()`**, pas de `new Function()`, pas de bibliothèque lourde. Un évaluateur minimaliste et sécurisé qui couvre 95% des besoins :

```
<expression> := <path> <operator> <literal>
<path>       := identifier ("." identifier)*
<operator>   := "==" | "!=" | ">" | "<" | ">=" | "<="
<literal>    := string | number | boolean | null
```

### 2.2 Exemples supportés

```
output.qualified == true
output.score > 80
output.company_size == 'enterprise'
output.status != 'cancelled'
output.count >= 10
output.data == null
```

### 2.3 Exemples **non** supportés (V1)

```
output.score > 80 && output.qualified == true    # pas de AND/OR
output.tags.length > 0                            # pas de propriétés built-in
output.name.startsWith('A')                       # pas d'appels de méthode
```

> **Extension future** : Si le besoin d'expressions complexes se confirme, migrer vers `jsonata` ou JSON Logic. Le routing engine expose une interface abstraite pour faciliter ce swap.

---

## 3. Implémentation : `services/routing-engine.ts`

### 3.1 Types

```typescript
export interface RoutingRule {
  when: string;
  goto?: string;
  stop?: boolean;
  reason?: string;
}

export interface RoutingBlock {
  after: string;
  rules: RoutingRule[];
  default?: string;    // step ID to go to if no rule matches (null = next step)
}

export type RoutingDecision =
  | { action: "next" }                          // continuer au step suivant
  | { action: "goto"; target: string; reason?: string }  // sauter à un step
  | { action: "stop"; reason?: string };        // arrêter le pipeline
```

### 3.2 Évaluateur d'expressions

```typescript
/**
 * Evaluate a simple expression against a context object.
 * Supports: dot-path access, comparison operators, string/number/boolean/null literals.
 * Returns false on any parse error (fail-safe).
 */
export function evaluateExpression(
  expr: string,
  context: Record<string, unknown>,
): boolean {
  // Parse expression: "<path> <op> <literal>"
  const match = expr.match(
    /^([\w.]+)\s*(==|!=|>=?|<=?)\s*(.+)$/
  );
  if (!match) return false;

  const [, path, op, rawLiteral] = match;
  if (!path || !op || !rawLiteral) return false;

  // Resolve dot-path
  const value = resolvePath(context, path);

  // Parse literal
  const literal = parseLiteral(rawLiteral.trim());

  // Compare
  return compare(value, op, literal);
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  let current: unknown = obj;
  for (const segment of path.split(".")) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function parseLiteral(raw: string): unknown {
  // String (single or double quotes)
  if ((raw.startsWith("'") && raw.endsWith("'")) ||
      (raw.startsWith('"') && raw.endsWith('"'))) {
    return raw.slice(1, -1);
  }
  // Boolean
  if (raw === "true") return true;
  if (raw === "false") return false;
  // Null
  if (raw === "null") return null;
  // Number
  const num = Number(raw);
  if (!isNaN(num)) return num;
  // Fallback: treat as string
  return raw;
}

function compare(value: unknown, op: string, literal: unknown): boolean {
  switch (op) {
    case "==": return value === literal;
    case "!=": return value !== literal;
    case ">":  return typeof value === "number" && typeof literal === "number" && value > literal;
    case "<":  return typeof value === "number" && typeof literal === "number" && value < literal;
    case ">=": return typeof value === "number" && typeof literal === "number" && value >= literal;
    case "<=": return typeof value === "number" && typeof literal === "number" && value <= literal;
    default:   return false;
  }
}
```

### 3.3 Résolution du routing

```typescript
/**
 * Evaluate routing rules after a step completes.
 * Returns the routing decision.
 */
export function resolveRouting(
  routing: RoutingBlock[],
  completedStepId: string,
  stepOutput: Record<string, unknown>,
): RoutingDecision {
  // Find the routing block for this step
  const block = routing.find((r) => r.after === completedStepId);
  if (!block) return { action: "next" };

  // Build context: { output: stepOutput }
  const context = { output: stepOutput };

  // Evaluate rules in order (first match wins)
  for (const rule of block.rules) {
    if (evaluateExpression(rule.when, context)) {
      if (rule.stop) {
        return { action: "stop", reason: rule.reason };
      }
      if (rule.goto) {
        return { action: "goto", target: rule.goto, reason: rule.reason };
      }
    }
  }

  // No rule matched — use default or next
  if (block.default) {
    return { action: "goto", target: block.default };
  }
  return { action: "next" };
}
```

### 3.4 Validation du routing au manifest

Ajouter dans `validateSteps()` (Phase 1) ou nouveau `validateRouting()` :

```typescript
export function validateRouting(
  routing: RoutingBlock[],
  stepIds: Set<string>,
): StepValidationResult {
  const errors: string[] = [];

  for (const block of routing) {
    // "after" must reference an existing step
    if (!stepIds.has(block.after)) {
      errors.push(`routing.after '${block.after}' references unknown step`);
    }

    for (const rule of block.rules) {
      // "when" must be parseable
      if (!rule.when?.trim()) {
        errors.push(`routing rule for '${block.after}' has empty 'when'`);
      }

      // "goto" must reference an existing step
      if (rule.goto && !stepIds.has(rule.goto)) {
        errors.push(`routing rule goto '${rule.goto}' references unknown step`);
      }

      // Must have either goto or stop
      if (!rule.goto && !rule.stop) {
        errors.push(`routing rule for '${block.after}' must have either 'goto' or 'stop'`);
      }

      // Cannot have both goto and stop
      if (rule.goto && rule.stop) {
        errors.push(`routing rule for '${block.after}' cannot have both 'goto' and 'stop'`);
      }
    }

    // "default" must reference an existing step (if set)
    if (block.default && !stepIds.has(block.default)) {
      errors.push(`routing default '${block.default}' references unknown step`);
    }

    // Detect backward jumps (goto to a step before the current one)
    // Allow for now (loops) but warn — can be restricted later
  }

  return { valid: errors.length === 0, errors };
}
```

---

## 4. Intégration dans `step-executor.ts`

### 4.1 Modification de la boucle

Le step executor (Phase 2) utilisait une simple boucle `for`. On la remplace par une boucle pilotée par le routing :

```typescript
// Remplacement de la boucle for simple
let currentIndex = 0;
const visited = new Set<number>();   // Protection anti-boucle infinie
const MAX_ITERATIONS = steps.length * 2;  // Sécurité
let iterations = 0;

while (currentIndex < steps.length) {
  if (iterations++ > MAX_ITERATIONS) {
    yield {
      type: "error",
      message: "Pipeline stopped: maximum iterations exceeded (possible infinite loop)",
    };
    break;
  }

  const step = steps[currentIndex];

  // ── Évaluer la condition inline du step (si définie) ──
  if (step.condition) {
    // Contexte : tous les outputs précédents, préfixés par "steps."
    const conditionContext: Record<string, unknown> = {};
    for (const [id, output] of Object.entries(stepOutputs)) {
      conditionContext[`steps.${id}.output`] = output;
      // Flatten for simpler access
      for (const [key, val] of Object.entries(output)) {
        conditionContext[`steps.${id}.${key}`] = val;
      }
    }

    if (!evaluateExpression(step.condition, conditionContext)) {
      yield {
        type: "step_complete" as ExecutionMessage["type"],
        message: `Step "${step.displayName}" skipped (condition not met)`,
        data: { stepId: step.id, stepIndex: currentIndex, status: "skipped" },
      };
      currentIndex++;
      continue;
    }
  }

  // ── Exécuter le step (code existant Phase 2) ──
  // ... yield step_start, adapter.execute, yield step_complete ...

  // ── Évaluer le routing après le step ──
  const routing = (flow.manifest as Record<string, unknown>).routing as RoutingBlock[] | undefined;
  if (routing && routing.length > 0) {
    const decision = resolveRouting(routing, step.id, stepOutputs[step.id] ?? {});

    switch (decision.action) {
      case "stop":
        yield {
          type: "progress",
          message: `Pipeline stopped after "${step.displayName}"${decision.reason ? `: ${decision.reason}` : ""}`,
          data: { stepId: step.id, routing: "stop", reason: decision.reason },
          level: "info",
        };
        // Sortie propre — pas une erreur, le flow "réussit" avec les résultats partiels
        goto_end = true;
        break;

      case "goto": {
        const targetIndex = steps.findIndex((s) => s.id === decision.target);
        if (targetIndex === -1) {
          yield {
            type: "error",
            message: `Routing target '${decision.target}' not found`,
          };
          goto_end = true;
          break;
        }
        yield {
          type: "progress",
          message: `Routing: jumping to "${steps[targetIndex].displayName}"${decision.reason ? ` (${decision.reason})` : ""}`,
          data: { stepId: step.id, routing: "goto", target: decision.target },
          level: "info",
        };
        currentIndex = targetIndex;
        continue;   // Ne pas incrémenter
      }

      case "next":
        currentIndex++;
        continue;
    }

    if (goto_end) break;
  } else {
    currentIndex++;
  }
}
```

### 4.2 Gestion du `stop` anticipé

Quand un routing émet `stop`, le pipeline se termine **proprement** :
- Status de l'execution = `success` (pas `failed`)
- Le report et les outputs accumulés jusque-là sont retournés
- Un log `step_complete` avec `status: "stopped"` est émis
- Le state final contient les outputs de tous les steps exécutés

---

## 5. Protection anti-boucle

Le routing permet des sauts en avant (`goto` vers un step plus loin) mais aussi potentiellement des **boucles** (goto vers un step déjà passé).

### 5.1 V1 : Pas de boucle

En V1, interdire les sauts en arrière dans `validateRouting()` :

```typescript
// Dans validateRouting()
if (rule.goto) {
  const gotoIdx = stepsArray.findIndex(s => s.id === rule.goto);
  const afterIdx = stepsArray.findIndex(s => s.id === block.after);
  if (gotoIdx <= afterIdx) {
    errors.push(
      `routing rule for '${block.after}' has backward goto '${rule.goto}' (loops not supported)`
    );
  }
}
```

### 5.2 V2 (future) : Boucles contrôlées

Si les boucles sont souhaitées (retry logic, itérations) :
- Ajouter `maxIterations` sur le routing block
- Compter le nombre de passages par step
- Stopper après `maxIterations`

---

## 6. Tests

### 6.1 Tests unitaires — expression evaluator

Fichier : `apps/api/test/unit/routing-engine.test.ts`

```typescript
import { describe, it, expect } from "bun:test";
import { evaluateExpression, resolveRouting } from "../../src/services/routing-engine.ts";

describe("evaluateExpression", () => {
  it("evaluates equality with string", () => {
    expect(evaluateExpression("output.size == 'small'", { output: { size: "small" } })).toBe(true);
  });
  it("evaluates inequality", () => {
    expect(evaluateExpression("output.size != 'small'", { output: { size: "large" } })).toBe(true);
  });
  it("evaluates numeric comparison", () => {
    expect(evaluateExpression("output.score > 80", { output: { score: 85 } })).toBe(true);
    expect(evaluateExpression("output.score > 80", { output: { score: 50 } })).toBe(false);
  });
  it("evaluates boolean", () => {
    expect(evaluateExpression("output.ok == true", { output: { ok: true } })).toBe(true);
  });
  it("evaluates null", () => {
    expect(evaluateExpression("output.data == null", { output: { data: null } })).toBe(true);
  });
  it("resolves nested path", () => {
    expect(evaluateExpression("output.deep.value == 42", { output: { deep: { value: 42 } } })).toBe(true);
  });
  it("returns false on missing path", () => {
    expect(evaluateExpression("output.missing == 'x'", { output: {} })).toBe(false);
  });
  it("returns false on invalid expression", () => {
    expect(evaluateExpression("garbage", {})).toBe(false);
  });
  it("handles >= and <=", () => {
    expect(evaluateExpression("output.n >= 10", { output: { n: 10 } })).toBe(true);
    expect(evaluateExpression("output.n <= 5", { output: { n: 3 } })).toBe(true);
  });
});

describe("resolveRouting", () => {
  it("returns 'next' when no routing block exists", () => { ... });
  it("returns 'stop' when stop rule matches", () => { ... });
  it("returns 'goto' when goto rule matches", () => { ... });
  it("uses default when no rule matches", () => { ... });
  it("first matching rule wins", () => { ... });
  it("returns 'next' when no rules and no default", () => { ... });
});
```

### 6.2 Tests unitaires — routing validation

Fichier : `apps/api/test/unit/routing-validation.test.ts`

```typescript
describe("validateRouting", () => {
  it("accepts valid routing", () => { ... });
  it("rejects unknown 'after' step", () => { ... });
  it("rejects unknown 'goto' target", () => { ... });
  it("rejects rule with neither goto nor stop", () => { ... });
  it("rejects rule with both goto and stop", () => { ... });
  it("rejects backward goto (V1)", () => { ... });
  it("rejects empty 'when' expression", () => { ... });
});
```

---

## 7. Checklist de livraison

- [ ] `evaluateExpression()` dans `services/routing-engine.ts`
- [ ] `resolveRouting()` dans `services/routing-engine.ts`
- [ ] `validateRouting()` dans `services/routing-engine.ts`
- [ ] Intégration routing dans la boucle `step-executor.ts`
- [ ] Support `step.condition` (condition inline)
- [ ] Support `stop` (arrêt anticipé propre, status = `success`)
- [ ] Protection anti-boucle (V1 : pas de backward goto)
- [ ] Tests expression evaluator (10+ cases)
- [ ] Tests resolveRouting (6+ cases)
- [ ] Tests validateRouting (7+ cases)
- [ ] `bun run check` passe
