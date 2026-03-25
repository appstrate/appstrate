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
