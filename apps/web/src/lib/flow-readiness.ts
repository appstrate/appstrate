// Re-export shared utilities from @appstrate/shared-types
export { isPromptEmpty, findMissingDependencies } from "@appstrate/shared-types";

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
