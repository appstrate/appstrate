// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * `bundleMcpServer` — high-level orchestrator for the AFPS mcp-server
 * bundler.
 *
 * In AFPS, the runnable MCP server lives in a separate `mcp-server`
 * package whose manifest is AFPS-native at the root (carrying MCPB-vocabulary
 * `server` / `tools` / `user_config` fields lifted alongside the AFPS identity
 * fields — see AFPS §3.4); an integration whose `source.kind: "local"`
 * references it via `source.server`. This bundler operates on the mcp-server
 * manifest.
 *
 * Pipeline:
 *
 *   1. Validate the source manifest with `mcpServerManifestSchema`.
 *   2. If `_meta["dev.appstrate/vendor"]` declares an npm/pypi source, run
 *      the matching resolver (npm → `vendorNpmPackage`, pypi →
 *      `vendorPypiPackage`). Else the manifest is already self-contained
 *      (`server.entry_point` points at in-bundle code) and we skip vendoring.
 *   3. Optionally run the Bun compat probe.
 *   4. Stitch the rewritten manifest + vendored files + caller files
 *      into a deterministic ZIP.
 *
 * Network and subprocess access are fully injectable so this module
 * is unit-testable without npm/pypi/Bun.
 */

import { mcpServerManifestSchema, type McpServerManifest } from "../mcp-server.ts";
import { vendorNpmPackage, type NpmVendorDeps, BundlerError } from "./npm-vendor.ts";
import { vendorPypiPackage, type PypiVendorDeps } from "./pypi-vendor.ts";
import { rewriteManifestForDistribution, suggestBundleFileName } from "./manifest-rewriter.ts";
import { packDeterministicZip } from "./packager.ts";
import { probeBunCompat, type BunProbeOptions } from "./bun-probe.ts";
import {
  VENDOR_META_KEY,
  type BundleMcpServerResult,
  type BunCompatProbeResult,
  type VendorResult,
  type VendorSource,
} from "./types.ts";

export interface BundleMcpServerInput {
  /**
   * Source AFPS-native mcp-server manifest (already parsed JSON). Carries
   * MCPB-vocabulary `server` / `tools` / `user_config` fields lifted to the
   * root alongside AFPS identity (`name`, `type`, `schema_version`,
   * `dependencies`).
   */
  manifest: unknown;

  /**
   * Optional extra files to embed in the bundle (paths are
   * POSIX-style relative to the bundle root, e.g. `"SERVER.md"`).
   * Conflicts with vendored files throw.
   */
  extraFiles?: Record<string, Uint8Array>;

  /** Pre-vendored `./server/` tree (skips network — sandbox-friendly). */
  prebuiltServerFiles?: Record<string, Uint8Array>;

  /** Inject test doubles for the npm path. */
  npmDeps?: NpmVendorDeps;
  /** Inject test doubles for the pypi path. */
  pypiDeps?: PypiVendorDeps;

  /** When set, run the Bun compat probe with these options. */
  bunProbe?: BunProbeOptions | true;
}

/**
 * Read the author-sugar vendoring source from
 * `_meta["dev.appstrate/vendor"]`. Returns `null` when absent (the manifest
 * is self-contained — `server.entry_point` already points at in-bundle code).
 */
export function readVendorSource(manifest: McpServerManifest): VendorSource | null {
  const meta = (manifest as { _meta?: Record<string, unknown> })._meta;
  const raw = meta?.[VENDOR_META_KEY] as Partial<VendorSource> | undefined;
  if (!raw || typeof raw !== "object") return null;
  if (raw.source !== "npm" && raw.source !== "pypi") {
    throw new BundlerError(
      `_meta["${VENDOR_META_KEY}"].source must be "npm" or "pypi"`,
      "MANIFEST_INVALID",
    );
  }
  if (typeof raw.identifier !== "string" || raw.identifier.length === 0) {
    throw new BundlerError(
      `_meta["${VENDOR_META_KEY}"].identifier is required`,
      "MANIFEST_INVALID",
    );
  }
  if (typeof raw.version !== "string" || raw.version.length === 0) {
    throw new BundlerError(`_meta["${VENDOR_META_KEY}"].version is required`, "MANIFEST_INVALID");
  }
  return {
    source: raw.source,
    identifier: raw.identifier,
    version: raw.version,
  };
}

export async function bundleMcpServer(input: BundleMcpServerInput): Promise<BundleMcpServerResult> {
  const parseRes = mcpServerManifestSchema.safeParse(input.manifest);
  if (!parseRes.success) {
    const detail = parseRes.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BundlerError(`mcp-server manifest is invalid: ${detail}`, "MANIFEST_INVALID");
  }
  const source = parseRes.data as McpServerManifest;

  const vendorResult = await runVendor(source, input);

  // Construct the file tree.
  const tree: Record<string, Uint8Array> = {};
  if (vendorResult) {
    for (const [k, v] of Object.entries(vendorResult.files)) {
      tree[k] = v;
    }
  }
  if (input.prebuiltServerFiles) {
    for (const [k, v] of Object.entries(input.prebuiltServerFiles)) {
      if (tree[k]) {
        throw new BundlerError(
          `prebuiltServerFiles conflicts with vendored file: ${k}`,
          "FILE_CONFLICT",
        );
      }
      tree[k] = v;
    }
  }
  if (input.extraFiles) {
    for (const [k, v] of Object.entries(input.extraFiles)) {
      if (k === "manifest.json") {
        throw new BundlerError(
          "extraFiles must not include manifest.json (the bundler writes it)",
          "RESERVED_PATH",
        );
      }
      if (tree[k]) {
        throw new BundlerError(`extraFiles conflicts with vendored file: ${k}`, "FILE_CONFLICT");
      }
      tree[k] = v;
    }
  }

  let bunCompat: BunCompatProbeResult | undefined;
  if (input.bunProbe && vendorResult && vendorResult.rewrittenServerType === "node") {
    const probeOpts: BunProbeOptions = input.bunProbe === true ? {} : input.bunProbe;
    bunCompat = await probeBunCompat(
      vendorResult.files,
      vendorResult.rewrittenEntryPoint,
      probeOpts,
    );
  }

  // Distributed manifest: rewrite if vendoring happened, else mirror.
  const distributedManifest = vendorResult
    ? rewriteManifestForDistribution(source, vendorResult, bunCompat)
    : source;

  const manifestBytes = new TextEncoder().encode(
    JSON.stringify(distributedManifest, null, 2) + "\n",
  );
  tree["manifest.json"] = manifestBytes;

  const afps = packDeterministicZip(tree);
  return {
    afps,
    manifest: distributedManifest,
    suggestedFileName: suggestBundleFileName(distributedManifest),
    bunCompat,
  };
}

async function runVendor(
  manifest: McpServerManifest,
  input: BundleMcpServerInput,
): Promise<VendorResult | null> {
  const vendor = readVendorSource(manifest);
  // Self-contained mcp-server (entry_point points at in-bundle code) — nothing
  // to vendor.
  if (!vendor) return null;
  if (vendor.source === "npm") {
    return vendorNpmPackage(
      {
        identifier: vendor.identifier,
        versionRange: vendor.version,
      },
      input.npmDeps,
    );
  }
  return vendorPypiPackage(
    {
      identifier: vendor.identifier,
      versionRange: vendor.version,
    },
    input.pypiDeps,
  );
}

export { BundlerError } from "./npm-vendor.ts";
export { rewriteManifestForDistribution, suggestBundleFileName } from "./manifest-rewriter.ts";
export { packDeterministicZip, DOS_EPOCH_MS } from "./packager.ts";
export { probeBunCompat, probeStdioCompat } from "./bun-probe.ts";
export type { StdioProbeOptions } from "./bun-probe.ts";
export type * from "./types.ts";
