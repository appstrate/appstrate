export interface ExtensionValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Strip single-line comments (`// ...`) from source code. */
function stripLineComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "");
}

/**
 * Count parameters in a function signature string, respecting nested angle brackets
 * (e.g. `Record<string, unknown>` counts as one parameter).
 */
function countParams(paramStr: string): number {
  const trimmed = paramStr.trim();
  if (trimmed === "") return 0;

  let depth = 0;
  let count = 1;
  for (const ch of trimmed) {
    if (ch === "<" || ch === "(") depth++;
    else if (ch === ">" || ch === ")") depth--;
    else if (ch === "," && depth === 0) count++;
  }
  return count;
}

/**
 * Validate TypeScript source code for a Pi SDK extension.
 *
 * Uses regex-based heuristics (no AST parsing) to catch common mistakes:
 * - Missing `export default`
 * - Wrong `execute` signature (1 param instead of 2-3)
 * - Missing `registerTool` call
 * - Unbalanced braces (syntax errors)
 */
export function validateExtensionSource(source: string): ExtensionValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // 1. Non-empty content
  if (source.trim().length === 0) {
    return { valid: false, errors: ["Le contenu de l'extension est vide"], warnings };
  }

  // 2. Must have export default
  if (!/export\s+default\b/.test(source)) {
    errors.push(
      "L'extension doit avoir un `export default function`. " +
        "Exemple : export default function(pi: ExtensionAPI) { ... }",
    );
  }

  // 3. Should call registerTool (warning only)
  if (!/\.registerTool\s*\(/.test(source)) {
    warnings.push(
      "L'extension n'appelle pas `pi.registerTool()`. " +
        "Assurez-vous d'enregistrer au moins un outil.",
    );
  }

  // 4. Check execute signature — must have 2+ params, not 1
  const cleaned = stripLineComments(source);
  const executeMatches = [...cleaned.matchAll(/execute\s*\(([^)]*)\)/g)];
  for (const match of executeMatches) {
    const paramStr = match[1]!;
    const paramCount = countParams(paramStr);
    if (paramCount === 1) {
      errors.push(
        "La signature `execute` n'a qu'un seul parametre. " +
          "Le Pi SDK appelle execute(toolCallId, params, signal) — avec un seul parametre, " +
          "votre fonction recevra le toolCallId (string) au lieu des params. " +
          "Corrigez : execute(_toolCallId, params, signal) { ... }",
      );
      break; // one error is enough
    }
  }

  // 5. Return format check (warning only)
  if (executeMatches.length > 0 && !/content\s*:/.test(cleaned)) {
    warnings.push(
      "La fonction `execute` ne semble pas retourner `{ content: [...] }`. " +
        'Le format attendu est : { content: [{ type: "text", text: "..." }] }',
    );
  }

  // 6. Balanced braces check
  let braceCount = 0;
  for (const ch of cleaned) {
    if (ch === "{") braceCount++;
    else if (ch === "}") braceCount--;
  }
  if (braceCount !== 0) {
    errors.push(
      `Erreur de syntaxe probable : les accolades ne sont pas equilibrees (difference: ${braceCount})`,
    );
  }

  return { valid: errors.length === 0, errors, warnings };
}
