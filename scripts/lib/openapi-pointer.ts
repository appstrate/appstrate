// SPDX-License-Identifier: Apache-2.0

/** The operation keys of an OpenAPI 3 Path Item. */
export const OPERATION_VERBS = [
  "get",
  "put",
  "post",
  "delete",
  "options",
  "head",
  "patch",
  "trace",
] as const;

/** Resolve a local `$ref` (`#/components/…`) to the object it names. */
export function resolveRef(spec: unknown, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = spec;
  for (const part of ref.slice(2).split("/")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== null && typeof current === "object"
    ? (current as Record<string, unknown>)
    : undefined;
}
