// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Validate a multi-package {@link Bundle} against the AFPS spec.
 *
 * Runs:
 *   - AFPS manifest schema check per package (via `@afps-spec/schema`),
 *     dispatched across the three package types `agent | skill | integration`
 *     via the root-level `type` discriminator.
 *   - `schema_version` MAJOR policy check on the types that carry one
 *     (`agent` requires it; `skill`/`integration` declare it at the root).
 *   - `type = "agent"` for the root when `agentOnlyRoot` is on
 *   - Prompt template syntax check on the root's `prompt.md` if present
 *   - Cycle + divergent-version detection (non-fatal warnings)
 */

import {
  agentManifestSchema,
  skillManifestSchema,
  integrationManifestSchema,
} from "@afps-spec/schema";
import type { z } from "zod";
import { validateTemplate } from "../template/mustache.ts";
import { checkCompanionFiles } from "./companion-files.ts";
import type { Bundle, BundlePackage, PackageIdentity } from "./types.ts";
import { parsePackageIdentity } from "./types.ts";

export interface BundleValidationIssue {
  /**
   * Stable, machine-readable. New `CYCLE_DETECTED` / `VERSION_DIVERGENCE`
   * codes are non-fatal warnings (SHOULD-level per spec §8).
   */
  code:
    | "MANIFEST_SCHEMA"
    | "UNSUPPORTED_TYPE"
    | "TEMPLATE_SYNTAX"
    | "SCHEMA_VERSION_MISSING"
    | "SCHEMA_VERSION_UNSUPPORTED"
    | "CYCLE_DETECTED"
    | "VERSION_DIVERGENCE"
    | "COMPANION_FILE_MISSING";
  /** Which package raised this issue — `null` for bundle-level. */
  identity: PackageIdentity | null;
  /** Dot-path inside the package's manifest when relevant. */
  path: string;
  message: string;
  severity: "error" | "warning";
}

export interface BundleValidationResult {
  /** `true` iff no `error`-severity issues. Warnings are allowed. */
  valid: boolean;
  issues: readonly BundleValidationIssue[];
}

export interface ValidateBundleOptions {
  /** Accepted `schema_version` MAJORs. Default: `[0]` (AFPS 0.1 draft). */
  supportedMajors?: readonly number[];
  /**
   * Require the root package's `type` to be `"agent"`. Default: `true`.
   * The runtime executes agents; a bundle whose root is a skill /
   * integration won't run end-to-end.
   */
  agentOnlyRoot?: boolean;
}

export function validateBundle(
  bundle: Bundle,
  opts: ValidateBundleOptions = {},
): BundleValidationResult {
  const supportedMajors = opts.supportedMajors ?? [0];
  const agentOnlyRoot = opts.agentOnlyRoot ?? true;
  const issues: BundleValidationIssue[] = [];

  // Per-package checks
  for (const [identity, pkg] of bundle.packages) {
    validatePackage(pkg, identity, identity === bundle.root, {
      supportedMajors,
      agentOnlyRoot,
      issues,
    });
  }

  // Cycle detection (non-fatal warning)
  const cycles = detectCycles(bundle);
  for (const cycle of cycles) {
    issues.push({
      code: "CYCLE_DETECTED",
      identity: null,
      path: "",
      message: `dependency cycle: ${cycle.join(" -> ")}`,
      severity: "warning",
    });
  }

  // Divergent-version detection (non-fatal warning)
  const divergent = detectDivergentVersions(bundle);
  for (const { packageId, versions } of divergent) {
    issues.push({
      code: "VERSION_DIVERGENCE",
      identity: null,
      path: "",
      message: `multiple versions of ${packageId}: ${versions.join(", ")}`,
      severity: "warning",
    });
  }

  const valid = issues.every((i) => i.severity !== "error");
  return { valid, issues };
}

function validatePackage(
  pkg: BundlePackage,
  identity: PackageIdentity,
  isRoot: boolean,
  ctx: {
    supportedMajors: readonly number[];
    agentOnlyRoot: boolean;
    issues: BundleValidationIssue[];
  },
): void {
  const manifest = pkg.manifest as Record<string, unknown>;
  // The root `type` discriminator is authoritative for every package type.
  const effectiveType: unknown = manifest["type"];

  if (isRoot && ctx.agentOnlyRoot && effectiveType !== "agent") {
    ctx.issues.push({
      code: "UNSUPPORTED_TYPE",
      identity,
      path: "manifest.type",
      message: `root package must be type: "agent" (got ${JSON.stringify(effectiveType)})`,
      severity: "error",
    });
  }

  const schema = schemaForType(effectiveType);
  if (!schema) {
    if (!isRoot) {
      ctx.issues.push({
        code: "UNSUPPORTED_TYPE",
        identity,
        path: "manifest.type",
        message: `unknown package type ${JSON.stringify(effectiveType)}`,
        severity: "error",
      });
    }
    return;
  }

  const parseResult = schema.safeParse(manifest);
  if (!parseResult.success) {
    for (const issue of parseResult.error.issues) {
      ctx.issues.push({
        code: "MANIFEST_SCHEMA",
        identity,
        path: `manifest.${issue.path.join(".") || "<root>"}`,
        message: issue.message,
        severity: "error",
      });
    }
  } else {
    checkSchemaVersion(effectiveType, parseResult.data, identity, ctx);
  }

  // Root agents must have a parseable prompt template if one exists.
  if (isRoot) {
    const promptBytes = pkg.files.get("prompt.md");
    if (promptBytes) {
      const text = new TextDecoder().decode(promptBytes);
      const check = validateTemplate(text);
      if (!check.ok) {
        ctx.issues.push({
          code: "TEMPLATE_SYNTAX",
          identity,
          path: "files.prompt.md",
          message: `prompt.md is not a valid Mustache template: ${check.error}`,
          severity: "error",
        });
      }
    }
  }

  // §3.3 / §3.4 companion-file enforcement — single source of truth shared
  // with the platform's ZIP-import path. Flags missing prompt.md (agent),
  // missing SKILL.md / frontmatter name (skill), and a missing
  // source.server.entry_point payload (local integration) as bundle-level errors.
  const violation = checkCompanionFiles(
    manifest as { type?: unknown; source?: unknown } & Record<string, unknown>,
    pkg.files,
  );
  if (violation) {
    ctx.issues.push({
      code: "COMPANION_FILE_MISSING",
      identity,
      path: violation.path ? `files.${violation.path}` : "files",
      message: violation.message,
      severity: "error",
    });
  }
}

/** The three AFPS package-type schemas (§2.1). */
type TypeSchema =
  typeof agentManifestSchema | typeof skillManifestSchema | typeof integrationManifestSchema;

function schemaForType(type: unknown): TypeSchema | null {
  switch (type) {
    case "agent":
      return agentManifestSchema;
    case "skill":
      return skillManifestSchema;
    case "integration":
      return integrationManifestSchema;
    default:
      return null;
  }
}

/**
 * Enforce the `schema_version` MAJOR policy per package type (AFPS,
 * snake_case `schema_version`).
 *
 *   - `agent`       — `schema_version` is REQUIRED by the AFPS schema, so a
 *     missing/invalid one already surfaces as a MANIFEST_SCHEMA error above.
 *     Here we additionally enforce the runtime's supported-MAJOR policy.
 *   - `skill` / `integration` — `schema_version` is OPTIONAL at the schema
 *     level. When present we enforce the MAJOR policy; when absent we accept
 *     it.
 */
function checkSchemaVersion(
  type: unknown,
  data: z.infer<TypeSchema>,
  identity: PackageIdentity,
  ctx: { supportedMajors: readonly number[]; issues: BundleValidationIssue[] },
): void {
  const schemaVersion = (data as { schema_version?: unknown }).schema_version;

  if (typeof schemaVersion !== "string" || schemaVersion.length === 0) {
    // agent REQUIRES schema_version (already flagged by MANIFEST_SCHEMA);
    // skill/integration may omit it — accept silently.
    if (type === "agent") {
      ctx.issues.push({
        code: "SCHEMA_VERSION_MISSING",
        identity,
        path: "manifest.schema_version",
        message: "agent manifest must declare a schema_version",
        severity: "error",
      });
    }
    return;
  }

  const major = Number(schemaVersion.split(".")[0]);
  if (!ctx.supportedMajors.includes(major)) {
    ctx.issues.push({
      code: "SCHEMA_VERSION_UNSUPPORTED",
      identity,
      path: "manifest.schema_version",
      message: `schema_version ${schemaVersion} is not supported (majors: ${ctx.supportedMajors.join(", ")})`,
      severity: "error",
    });
  }
}

function detectCycles(bundle: Bundle): PackageIdentity[][] {
  const cycles: PackageIdentity[][] = [];
  const visited = new Set<PackageIdentity>();
  const stack = new Set<PackageIdentity>();
  const path: PackageIdentity[] = [];

  function dfs(id: PackageIdentity) {
    if (stack.has(id)) {
      const idx = path.indexOf(id);
      cycles.push(path.slice(idx).concat(id));
      return;
    }
    if (visited.has(id)) return;
    stack.add(id);
    path.push(id);
    const pkg = bundle.packages.get(id);
    if (pkg) {
      for (const depId of depIdentities(pkg, bundle)) {
        dfs(depId);
      }
    }
    stack.delete(id);
    path.pop();
    visited.add(id);
  }

  dfs(bundle.root);
  return cycles;
}

function depIdentities(pkg: BundlePackage, bundle: Bundle): PackageIdentity[] {
  const deps = (pkg.manifest as { dependencies?: unknown }).dependencies;
  if (!deps || typeof deps !== "object") return [];
  const names = new Set<string>();
  for (const section of ["skills", "integrations"] as const) {
    const s = (deps as Record<string, unknown>)[section];
    if (s && typeof s === "object" && !Array.isArray(s)) {
      for (const n of Object.keys(s as Record<string, unknown>)) names.add(n);
    }
  }
  // Map declared names to identities currently in the bundle. We match
  // by packageId (scope/name) since the bundle already pinned exact
  // versions during assembly.
  const out: PackageIdentity[] = [];
  for (const id of bundle.packages.keys()) {
    const parsed = parsePackageIdentity(id);
    if (parsed && names.has(parsed.packageId)) out.push(id);
  }
  return out;
}

function detectDivergentVersions(bundle: Bundle): Array<{ packageId: string; versions: string[] }> {
  const byPkgId = new Map<string, string[]>();
  for (const id of bundle.packages.keys()) {
    const parsed = parsePackageIdentity(id);
    if (!parsed) continue;
    const list = byPkgId.get(parsed.packageId) ?? [];
    list.push(parsed.version);
    byPkgId.set(parsed.packageId, list);
  }
  const divergent: Array<{ packageId: string; versions: string[] }> = [];
  for (const [packageId, versions] of byPkgId) {
    if (versions.length > 1) {
      divergent.push({ packageId, versions: versions.sort() });
    }
  }
  return divergent;
}
