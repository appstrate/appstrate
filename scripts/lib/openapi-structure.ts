// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helper: structural OpenAPI validation (§2 of `scripts/verify-openapi.ts`).
 *
 * Lives here rather than inline in the gate so the failure path is reachable from a
 * test: the gate builds its document from the real source tree and has no seam for a
 * deliberately malformed one.
 *
 * `@readme/openapi-parser`'s `validate()` RESOLVES with `{ valid: false, errors }` for a
 * document that violates the OpenAPI schema, and throws only for I/O and $ref resolution
 * failures. Both outcomes are folded into one return value here so there is no way to
 * consume the valid half without the invalid one.
 */
import { validate, compileErrors, type ParserOptions } from "@readme/openapi-parser";

const OPTIONS = {
  // Skip external $ref resolution (AFPS schema URLs) — validated separately by afps-spec repo
  resolve: { external: false },
} satisfies ParserOptions;

/**
 * @returns `null` when the document conforms, otherwise the human-readable error report.
 */
export async function validateOpenApiStructure(spec: unknown): Promise<string | null> {
  try {
    // Deep-clone to avoid mutation by the parser (it dereferences $refs in-place)
    const specCopy = JSON.parse(JSON.stringify(spec));
    const result = await validate(specCopy, OPTIONS);
    return result.valid ? null : compileErrors(result);
  } catch (err: unknown) {
    // Reached when the document cannot even be cloned or read, never for a schema violation.
    return err instanceof Error ? err.message : String(err);
  }
}
