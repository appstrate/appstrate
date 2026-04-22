// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

import { agentManifestSchema } from "@afps-spec/schema";
import type { LoadedBundle } from "./loader.ts";
import { validateTemplate } from "../template/mustache.ts";

export interface AfpsManifestValidationIssue {
  /**
   * Stable machine-readable code. Consumers may switch on this to
   * render locale-aware UI messages or translate to error types.
   */
  code:
    | "MANIFEST_SCHEMA"
    | "UNSUPPORTED_TYPE"
    | "TEMPLATE_SYNTAX"
    | "SCHEMA_VERSION_MISSING"
    | "SCHEMA_VERSION_UNSUPPORTED";
  /**
   * Dot-path to the offending field when relevant
   * (e.g. `"manifest.schemaVersion"`, `"prompt"`). Empty for
   * bundle-level issues.
   */
  path: string;
  /** Human-readable message. Not stable — for logs and UI only. */
  message: string;
}

export interface AfpsManifestValidationResult {
  /** `true` iff every issue is non-fatal (currently empty list). */
  valid: boolean;
  issues: readonly AfpsManifestValidationIssue[];
}

export interface ValidateAfpsManifestOptions {
  /**
   * Accept only these schemaVersion majors. Default: `[1]` (AFPS v1 —
   * the only released major). An entry of `1` accepts any `1.x`.
   */
  supportedMajors?: readonly number[];
  /**
   * If `true`, treat `type: "agent"` as the only valid bundle type —
   * skills, tools, and providers are rejected with
   * `UNSUPPORTED_TYPE`. Default: `true`. The AFPS runtime exists to
   * run agents; non-agent bundles should not flow through it.
   */
  agentOnly?: boolean;
}

/**
 * Validate a previously loaded bundle against the AFPS spec.
 *
 * Checks, in order:
 *
 * 1. Manifest parses as an `agent` under `@afps-spec/schema`. Rejecting
 *    unknown / missing fields is deferred to the spec — we just surface
 *    its issues.
 * 2. Manifest declares a `schemaVersion` within `supportedMajors`.
 * 3. `prompt.md` is syntactically valid Mustache (unclosed sections
 *    fail here rather than at render time, so UI tooling can surface
 *    the problem at ingest).
 *
 * Does NOT attempt to run the prompt template — sample rendering with a
 * synthetic view is available via
 * {@link import("./prompt-renderer.ts").buildPromptView} if needed.
 */
/**
 * Validates the manifest + prompt of a single AFPS package (the flat
 * LoadedBundle surface). For validating a multi-package Bundle contract,
 * use {@link import("./validate-bundle.ts").validateBundle} instead.
 */
export function validateAfpsManifest(
  bundle: LoadedBundle,
  opts: ValidateAfpsManifestOptions = {},
): AfpsManifestValidationResult {
  const supportedMajors = opts.supportedMajors ?? [1];
  const agentOnly = opts.agentOnly ?? true;
  const issues: AfpsManifestValidationIssue[] = [];

  const rawType = bundle.manifest["type"];
  if (agentOnly && rawType !== "agent") {
    issues.push({
      code: "UNSUPPORTED_TYPE",
      path: "manifest.type",
      message: `runtime only accepts type: "agent" bundles (got ${JSON.stringify(rawType)})`,
    });
  }

  const parseResult = agentManifestSchema.safeParse(bundle.manifest);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      issues.push({
        code: "MANIFEST_SCHEMA",
        path: `manifest.${issue.path.join(".") || "<root>"}`,
        message: issue.message,
      });
    }
  } else {
    const declared = parseResult.data.schemaVersion;
    if (!declared) {
      issues.push({
        code: "SCHEMA_VERSION_MISSING",
        path: "manifest.schemaVersion",
        message: 'bundle must declare a schemaVersion (e.g. "1.1")',
      });
    } else {
      const major = Number(declared.split(".")[0]);
      if (!supportedMajors.includes(major)) {
        issues.push({
          code: "SCHEMA_VERSION_UNSUPPORTED",
          path: "manifest.schemaVersion",
          message: `schemaVersion ${declared} is not supported (runtime accepts majors: ${supportedMajors.join(", ")})`,
        });
      }
    }
  }

  const templateCheck = validateTemplate(bundle.prompt);
  if (!templateCheck.ok) {
    issues.push({
      code: "TEMPLATE_SYNTAX",
      path: "prompt",
      message: `prompt.md is not a valid Mustache template: ${templateCheck.error}`,
    });
  }

  return { valid: issues.length === 0, issues };
}
