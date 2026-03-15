/** Check if a prompt is empty or whitespace-only. */
export function isPromptEmpty(prompt: string): boolean {
  return prompt.trim().length === 0;
}

/**
 * Find IDs declared in `required` but missing from `installed`.
 * Works for both skills and tools.
 */
export function findMissingDependencies(
  required: Record<string, string>,
  installedIds: string[],
): string[] {
  const installed = new Set(installedIds);
  return Object.keys(required).filter((id) => !installed.has(id));
}

/**
 * Check config completeness: all required fields must be present and non-empty.
 * Treats undefined, null, and "" as missing.
 */
export function checkRequiredConfig(
  config: Record<string, unknown>,
  requiredFields: string[],
): { valid: boolean; missingField?: string } {
  for (const key of requiredFields) {
    const val = config[key];
    if (val === undefined || val === null || val === "") {
      return { valid: false, missingField: key };
    }
  }
  return { valid: true };
}

/**
 * Strip empty/null values from required fields before AJV validation.
 * AJV with coerceTypes coerces null → "" for strings, which incorrectly passes.
 * Deleting them ensures AJV sees them as missing.
 */
export function normalizeConfigForValidation(
  config: Record<string, unknown>,
  requiredFields: string[],
): Record<string, unknown> {
  const cleaned = { ...config };
  for (const key of requiredFields) {
    if (cleaned[key] === "" || cleaned[key] === null) {
      delete cleaned[key];
    }
  }
  return cleaned;
}
