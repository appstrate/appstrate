// SPDX-License-Identifier: Apache-2.0

/**
 * Inline-manifest validation — applied BEFORE inserting a shadow package row.
 *
 * Layers:
 *   1. Cheap UTF-8 byte caps on the raw payload (manifest JSON + prompt).
 *   2. `validateManifest()` from `@appstrate/core/validation` — full AFPS
 *      structural validation, dispatched by `type` field.
 *   3. Inline-specific caps: deps.skills/tools/providers count + per-provider
 *      authorizedUris caps for manifests that embed provider definitions
 *      (e.g. a future inline `type: "provider"` flow). For agent manifests
 *      providers are ID references and the per-URI cap is enforced
 *      transitively via the provider package itself.
 *   4. Wildcard rejection: explicit `"*"` entry in `authorizedUris` or
 *      `allowAllUris: true` is denied when `wildcard_uri_allowed = false`.
 *
 * Pure function — no DB, no env lookup. Caller passes the limits.
 *
 * See docs/specs/INLINE_RUNS.md §6.
 */

import { validateManifest } from "@appstrate/core/validation";
import type { Manifest } from "@appstrate/core/validation";
import { asRecord } from "@appstrate/core/safe-json";
import { extractDepsFromManifest } from "./../lib/manifest-utils.ts";
import type { InlineRunLimits } from "./run-limits.ts";

export interface InlineManifestValidationResult {
  valid: boolean;
  errors: string[];
  manifest?: Manifest;
  /** Canonical JSON of the accepted manifest (used for byte-accurate hashing). */
  canonicalManifestJson?: string;
}

export interface InlineManifestValidationInput {
  manifest: unknown;
  prompt: unknown;
  limits: InlineRunLimits;
}

/** Validate an inline manifest + prompt against the configured caps. */
export function validateInlineManifest(
  input: InlineManifestValidationInput,
): InlineManifestValidationResult {
  const { limits } = input;
  const errors: string[] = [];

  // --- 1. Prompt type + size (UTF-8 bytes, matches manifest_bytes) ---
  if (typeof input.prompt !== "string") {
    errors.push("prompt: must be a string");
  } else {
    const promptByteLength = Buffer.byteLength(input.prompt, "utf8");
    if (promptByteLength > limits.prompt_bytes) {
      errors.push(`prompt: exceeds max size (${promptByteLength} > ${limits.prompt_bytes} bytes)`);
    }
  }

  // --- 2. Manifest must be a plain object ---
  if (!input.manifest || typeof input.manifest !== "object" || Array.isArray(input.manifest)) {
    errors.push("manifest: must be a JSON object");
    return { valid: false, errors };
  }

  // --- 3. Byte cap on the raw manifest ---
  const canonical = JSON.stringify(input.manifest);
  const byteLength = Buffer.byteLength(canonical, "utf8");
  if (byteLength > limits.manifest_bytes) {
    errors.push(`manifest: exceeds max size (${byteLength} > ${limits.manifest_bytes} bytes)`);
  }

  // --- 4. Structural AFPS validation (dispatches by `type` field) ---
  // On failure we record the errors but continue — dep-count and URI caps
  // read the raw manifest shape and don't need the parsed result, so surfacing
  // them alongside structural errors gives callers a single-round-trip view.
  const structural = validateManifest(input.manifest);
  if (!structural.valid) {
    for (const e of structural.errors) errors.push(`manifest.${e}`);
  }

  const manifest = structural.valid ? (structural.manifest as Manifest) : undefined;

  // --- 5. Dependency count caps ---
  // `extractDepsFromManifest` is defensive (it routes every read through
  // `asRecord`) so this call should never throw on malformed input. The
  // try/catch is belt-and-suspenders: if a future refactor relaxes the
  // helper's tolerance, a malformed `dependencies` payload still surfaces a
  // structured error instead of bubbling a TypeError to the request handler.
  let skillIds: string[] = [];
  let toolIds: string[] = [];
  let providerIds: string[] = [];
  try {
    const deps = extractDepsFromManifest((manifest ?? input.manifest) as Partial<Manifest>);
    skillIds = deps.skillIds;
    toolIds = deps.toolIds;
    providerIds = deps.providerIds;
  } catch {
    errors.push("manifest.dependencies: malformed shape");
  }
  if (skillIds.length > limits.max_skills) {
    errors.push(
      `manifest.dependencies.skills: too many (${skillIds.length} > ${limits.max_skills})`,
    );
  }
  if (toolIds.length > limits.max_tools) {
    errors.push(`manifest.dependencies.tools: too many (${toolIds.length} > ${limits.max_tools})`);
  }

  // --- 6. Wildcard + URI caps on embedded provider definitions ---
  // Agent manifests never embed provider definitions — `definition` is a
  // provider-manifest field. This branch is defensive for future inline
  // provider manifests and for agents that misuse the field.
  const def = asRecord((input.manifest as Record<string, unknown>).definition);
  if (Object.keys(def).length > 0) {
    const allowAll = def.allowAllUris === true;
    const uris = Array.isArray(def.authorizedUris) ? (def.authorizedUris as string[]) : [];
    if (!limits.wildcard_uri_allowed) {
      if (allowAll) {
        errors.push(
          "manifest.definition.allowAllUris: wildcard access is not allowed for inline runs",
        );
      }
      if (uris.includes("*")) {
        errors.push(
          'manifest.definition.authorizedUris: wildcard "*" entry is not allowed for inline runs',
        );
      }
    }
    if (uris.length > limits.max_authorized_uris) {
      errors.push(
        `manifest.definition.authorizedUris: too many (${uris.length} > ${limits.max_authorized_uris})`,
      );
    }
  }

  // --- 7. Cap the provider-dependency count too — even though providers
  //       are ID references, each pulls authorized URIs into the sidecar
  //       allowlist. Use `max_authorized_uris` as the bound: one provider
  //       ≈ N URIs, so this is conservative.
  if (providerIds.length > limits.max_authorized_uris) {
    errors.push(
      `manifest.dependencies.providers: too many (${providerIds.length} > ${limits.max_authorized_uris})`,
    );
  }

  if (errors.length > 0 || !manifest) {
    return { valid: false, errors };
  }

  return { valid: true, errors: [], manifest, canonicalManifestJson: canonical };
}
