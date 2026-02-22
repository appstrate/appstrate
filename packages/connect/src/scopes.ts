import type { ScopeValidationResult } from "./types.ts";

/**
 * Validate that granted scopes satisfy required scopes.
 * Returns a result object with missing scopes if insufficient.
 */
export function validateScopes(
  granted: string[],
  required: string[],
): ScopeValidationResult {
  const grantedSet = new Set(granted);
  const missing = required.filter((s) => !grantedSet.has(s));
  return {
    sufficient: missing.length === 0,
    granted,
    required,
    missing,
  };
}
