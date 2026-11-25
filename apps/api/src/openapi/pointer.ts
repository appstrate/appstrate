// SPDX-License-Identifier: Apache-2.0

/** Resolve a local `$ref` (`#/components/…`) to the object it names. */
export function resolveRef(spec: unknown, ref: string): Record<string, unknown> | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = spec;
  for (const token of ref.slice(2).split("/")) {
    const part = token.replaceAll("~1", "/").replaceAll("~0", "~");
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, part))
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current !== null && typeof current === "object"
    ? (current as Record<string, unknown>)
    : undefined;
}
