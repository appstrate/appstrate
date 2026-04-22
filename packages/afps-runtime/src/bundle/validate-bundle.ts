// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Validate a multi-package {@link Bundle} against the AFPS spec.
 *
 * Runs:
 *   - AFPS manifest schema check per package (via `@afps-spec/schema`)
 *   - `schemaVersion` major check per package
 *   - `type = "agent"` for the root when `agentOnlyRoot` is on
 *   - Prompt template syntax check on the root's `prompt.md` if present
 *   - Cycle + divergent-version detection (non-fatal warnings)
 *
 * See `validator.ts` for the single-package (`LoadedBundle`) equivalent
 * kept for backward compat during the migration.
 */

import {
  agentManifestSchema,
  skillManifestSchema,
  toolManifestSchema,
  providerManifestSchema,
} from "@afps-spec/schema";
import { validateTemplate } from "../template/mustache.ts";
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
    | "VERSION_DIVERGENCE";
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
  /** Accepted schemaVersion MAJORs. Default: `[1]`. */
  supportedMajors?: readonly number[];
  /**
   * Require the root package's `type` to be `"agent"`. Default: `true`.
   * The runtime executes agents; a bundle whose root is a skill/tool/
   * provider won't run end-to-end.
   */
  agentOnlyRoot?: boolean;
}

export function validateBundle(
  bundle: Bundle,
  opts: ValidateBundleOptions = {},
): BundleValidationResult {
  const supportedMajors = opts.supportedMajors ?? [1];
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
  const rawType = manifest["type"];

  if (isRoot && ctx.agentOnlyRoot && rawType !== "agent") {
    ctx.issues.push({
      code: "UNSUPPORTED_TYPE",
      identity,
      path: "manifest.type",
      message: `root package must be type: "agent" (got ${JSON.stringify(rawType)})`,
      severity: "error",
    });
  }

  const schema = schemaForType(rawType);
  if (!schema) {
    if (!isRoot) {
      ctx.issues.push({
        code: "UNSUPPORTED_TYPE",
        identity,
        path: "manifest.type",
        message: `unknown package type ${JSON.stringify(rawType)}`,
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
    const data = parseResult.data as { schemaVersion?: string };
    if (!data.schemaVersion) {
      ctx.issues.push({
        code: "SCHEMA_VERSION_MISSING",
        identity,
        path: "manifest.schemaVersion",
        message: 'manifest must declare a schemaVersion (e.g. "1.1")',
        severity: "error",
      });
    } else {
      const major = Number(data.schemaVersion.split(".")[0]);
      if (!ctx.supportedMajors.includes(major)) {
        ctx.issues.push({
          code: "SCHEMA_VERSION_UNSUPPORTED",
          identity,
          path: "manifest.schemaVersion",
          message: `schemaVersion ${data.schemaVersion} is not supported (majors: ${ctx.supportedMajors.join(", ")})`,
          severity: "error",
        });
      }
    }
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
}

function schemaForType(
  type: unknown,
): typeof agentManifestSchema | typeof skillManifestSchema | null {
  switch (type) {
    case "agent":
      return agentManifestSchema;
    case "skill":
      return skillManifestSchema;
    case "tool":
      return toolManifestSchema as unknown as typeof agentManifestSchema;
    case "provider":
      return providerManifestSchema as unknown as typeof agentManifestSchema;
    default:
      return null;
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
  for (const section of ["skills", "tools", "providers"] as const) {
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
