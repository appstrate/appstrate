import type { FlowInputField } from "@openflows/shared-types";

/**
 * Validates required input fields against a flow's input schema.
 * Returns an error object if validation fails, null if valid.
 */
export function validateRequiredInput(
  input: Record<string, unknown> | undefined,
  schema: Record<string, FlowInputField>,
): { field: string; message: string } | null {
  for (const [key, field] of Object.entries(schema)) {
    if (
      field.required &&
      (!input || input[key] === undefined || input[key] === null || input[key] === "")
    ) {
      return { field: key, message: `Le champ d'entree '${key}' est requis` };
    }
  }
  return null;
}
