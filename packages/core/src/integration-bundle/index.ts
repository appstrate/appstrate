// Copyright 2025-2026 Appstrate
// SPDX-License-Identifier: Apache-2.0

/**
 * `bundleIntegration` — high-level orchestrator for the AFPS
 * integration bundler (Phase 1.05).
 *
 * Pipeline:
 *
 *   1. Validate the source manifest with `integrationManifestSchema`.
 *   2. If `server.package` is set, run the matching resolver
 *      (npm → `vendorNpmPackage`, pypi → `vendorPypiPackage`). Else
 *      the manifest is already self-contained (`entryPoint` set or
 *      `type: docker | http`) and we skip vendoring.
 *   3. Optionally run the Bun compat probe.
 *   4. Stitch the rewritten manifest + vendored files + caller files
 *      into a deterministic ZIP.
 *
 * Network and subprocess access are fully injectable so this module
 * is unit-testable without npm/pypi/Bun.
 */

import { integrationManifestSchema, type IntegrationManifest } from "../integration.ts";
import { vendorNpmPackage, type NpmVendorDeps, BundlerError } from "./npm-vendor.ts";
import { vendorPypiPackage, type PypiVendorDeps } from "./pypi-vendor.ts";
import { rewriteManifestForDistribution, suggestBundleFileName } from "./manifest-rewriter.ts";
import { packDeterministicZip } from "./packager.ts";
import { probeBunCompat, type BunProbeOptions } from "./bun-probe.ts";
import type { BundleIntegrationResult, BunCompatProbeResult, VendorResult } from "./types.ts";

export interface BundleIntegrationInput {
  /** Source manifest (already parsed JSON). */
  manifest: unknown;

  /**
   * Optional extra files to embed in the bundle (paths are
   * POSIX-style relative to the bundle root, e.g. `"INTEGRATION.md"`,
   * `"tools.lock.json"`). Conflicts with vendored files throw.
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

  /** Override the manifest indent (default `2`). */
  jsonIndent?: 0 | 2 | 4;
}

export async function bundleIntegration(
  input: BundleIntegrationInput,
): Promise<BundleIntegrationResult> {
  const parseRes = integrationManifestSchema.safeParse(input.manifest);
  if (!parseRes.success) {
    const detail = parseRes.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new BundlerError(`integration manifest is invalid: ${detail}`, "MANIFEST_INVALID");
  }
  const source = parseRes.data;

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
    JSON.stringify(distributedManifest, null, input.jsonIndent ?? 2) + "\n",
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
  manifest: IntegrationManifest,
  input: BundleIntegrationInput,
): Promise<VendorResult | null> {
  const server = manifest.server;
  if (server.type !== "npx" && server.type !== "uvx") return null;
  if (!server.package) {
    // Already-vendored author input (entryPoint set, no package): no
    // network step, but we still need to "promote" the runtime type
    // to node/uv so the distributed manifest is runnable (D31).
    if (!server.entryPoint) {
      throw new BundlerError(
        `server.type "${server.type}" with no package requires entryPoint`,
        "MANIFEST_INVALID",
      );
    }
    const now = (input.npmDeps?.now ?? input.pypiDeps?.now ?? (() => new Date()))();
    return {
      files: {},
      rewrittenServerType: server.type === "npx" ? "node" : "uv",
      rewrittenEntryPoint: server.entryPoint,
      resolution: {
        registryType: server.type === "npx" ? "npm" : "pypi",
        identifier: manifest.name,
        versionRequested: "(prebuilt)",
        versionResolved: manifest.version,
        integrity: "(prebuilt)",
        resolvedAt: now.toISOString(),
      },
    };
  }
  if (server.package.registryType === "npm") {
    return vendorNpmPackage(
      {
        identifier: server.package.identifier,
        versionRange: server.package.version,
        registryBaseUrl: server.package.registryBaseUrl,
      },
      input.npmDeps,
    );
  }
  if (server.package.registryType === "pypi") {
    return vendorPypiPackage(
      {
        identifier: server.package.identifier,
        versionRange: server.package.version,
        registryBaseUrl: server.package.registryBaseUrl,
      },
      input.pypiDeps,
    );
  }
  throw new BundlerError(
    `server.package.registryType "${(server.package as { registryType: string }).registryType}" is not supported by the bundler`,
    "UNSUPPORTED_REGISTRY",
  );
}

export { BundlerError } from "./npm-vendor.ts";
export { rewriteManifestForDistribution, suggestBundleFileName } from "./manifest-rewriter.ts";
export { packDeterministicZip, DOS_EPOCH_MS } from "./packager.ts";
export { probeBunCompat } from "./bun-probe.ts";
export type * from "./types.ts";
