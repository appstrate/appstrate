// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Validate a multi-package {@link Bundle} against the AFPS 2.0 spec.
 *
 * Runs:
 *   - AFPS 2.0 manifest schema check per package (via `@afps-spec/schema`),
 *     dispatched across the four package types `agent | skill | mcp-server |
 *     integration`.
 *   - `schema_version` MAJOR policy check on the types that carry one
 *     (`agent` requires it; `skill`/`integration` declare it optionally;
 *     `mcp-server` carries an MCPB `manifest_version` instead and is exempt).
 *   - `type = "agent"` for the root when `agentOnlyRoot` is on
 *   - Prompt template syntax check on the root's `prompt.md` if present
 *   - Cycle + divergent-version detection (non-fatal warnings)
 */

import {
  agentManifestSchema,
  skillManifestSchema,
  mcpServerManifestSchema,
  integrationManifestSchema,
} from "@afps-spec/schema";
import type { z } from "zod";
import { validateTemplate } from "../template/mustache.ts";
import { MCP_SERVER_META_KEY } from "../types/manifest.ts";
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
  /** Accepted `schema_version` MAJORs. Default: `[2]` (AFPS 2.0). */
  supportedMajors?: readonly number[];
  /**
   * Require the root package's `type` to be `"agent"`. Default: `true`.
   * The runtime executes agents; a bundle whose root is a skill /
   * mcp-server / integration won't run end-to-end.
   */
  agentOnlyRoot?: boolean;
}

export function validateBundle(
  bundle: Bundle,
  opts: ValidateBundleOptions = {},
): BundleValidationResult {
  const supportedMajors = opts.supportedMajors ?? [2];
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
  // AFPS 2.0 (§3.4): an mcp-server manifest IS a verbatim MCPB manifest. It
  // carries no top-level AFPS `type` — its identity (and `type: "mcp-server"`)
  // lives under `_meta["dev.afps/mcp-server"]`. Recognise it by either signal.
  const meta = manifest["_meta"] as Record<string, unknown> | undefined;
  const afpsMcp = meta?.[MCP_SERVER_META_KEY] as { type?: unknown } | undefined;
  const isMcpServer = manifest["type"] === "mcp-server" || afpsMcp?.type === "mcp-server";
  const effectiveType: unknown = isMcpServer ? "mcp-server" : manifest["type"];

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
}

/**
 * The four AFPS 2.0 package-type schemas. The `tool`/`provider` package types
 * (and their `@afps-spec` schemas) were removed in 2.0 — `mcp-server` (MCPB,
 * §3.4) and `integration` (§3.5/§7) replace them.
 */
type TypeSchema =
  | typeof agentManifestSchema
  | typeof skillManifestSchema
  | typeof mcpServerManifestSchema
  | typeof integrationManifestSchema;

function schemaForType(type: unknown): TypeSchema | null {
  switch (type) {
    case "agent":
      return agentManifestSchema;
    case "skill":
      return skillManifestSchema;
    case "mcp-server":
      return mcpServerManifestSchema;
    case "integration":
      return integrationManifestSchema;
    default:
      return null;
  }
}

/**
 * Enforce the `schema_version` MAJOR policy per package type (AFPS 2.0,
 * snake_case `schema_version`).
 *
 *   - `agent`       — `schema_version` is REQUIRED by the AFPS schema, so a
 *     missing/invalid one already surfaces as a MANIFEST_SCHEMA error above.
 *     Here we additionally enforce the runtime's supported-MAJOR policy.
 *   - `skill` / `integration` — `schema_version` is OPTIONAL. When present we
 *     enforce the MAJOR policy; when absent we accept it (the AFPS schema does).
 *   - `mcp-server` — carries an MCPB `manifest_version` instead of an AFPS
 *     `schema_version`, so it is exempt from this check entirely.
 */
function checkSchemaVersion(
  type: unknown,
  data: z.infer<TypeSchema>,
  identity: PackageIdentity,
  ctx: { supportedMajors: readonly number[]; issues: BundleValidationIssue[] },
): void {
  if (type === "mcp-server") return;

  const schemaVersion = (data as { schema_version?: unknown }).schema_version;

  if (typeof schemaVersion !== "string" || schemaVersion.length === 0) {
    // agent REQUIRES schema_version (already flagged by MANIFEST_SCHEMA);
    // skill/integration may omit it — accept silently.
    if (type === "agent") {
      ctx.issues.push({
        code: "SCHEMA_VERSION_MISSING",
        identity,
        path: "manifest.schema_version",
        message: 'agent manifest must declare a schema_version (e.g. "2.0")',
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
  for (const section of ["skills", "mcp_servers", "integrations"] as const) {
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
