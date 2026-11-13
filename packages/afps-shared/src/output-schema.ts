// SPDX-License-Identifier: Apache-2.0

/**
 * The output schema an agent manifest declares: `output.schema` when it is a
 * non-empty JSON object, `undefined` otherwise.
 *
 * It is the single reading of "this agent declares an output schema": the
 * runner gives the run the `output` tool from it, the platform prompt renders
 * its `## Output Format` section from it, and the platform validates the
 * run's output against it at finalize.
 */
export function readDeclaredOutputSchema(manifest: unknown): Record<string, unknown> | undefined {
  if (!isPlainRecord(manifest) || !isPlainRecord(manifest.output)) return undefined;
  const schema = manifest.output.schema;
  return isPlainRecord(schema) && Object.keys(schema).length > 0 ? schema : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
