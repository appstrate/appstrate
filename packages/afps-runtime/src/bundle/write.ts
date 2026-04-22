// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Write an in-memory {@link Bundle} to `.afps-bundle` bytes.
 *
 * Deterministic: two calls with the same input produce byte-identical
 * output. Achieved via:
 *  - sorted package identities in `bundle.json`
 *  - sorted file paths inside each package directory
 *  - canonical-JSON serialization of `bundle.json`
 *  - `zipSync` with `mtime: 0` (DOS epoch 1980-01-01)
 *  - stable compression level (`level: 0` — store only, no deflate)
 */

import { writeFile } from "node:fs/promises";
import { zipSync } from "fflate";
import { canonicalJsonStringify } from "./canonical-json.ts";
import {
  bundleIntegrity,
  computeRecordEntries,
  recordIntegrity,
  serializeRecord,
} from "./integrity.ts";
import { BUNDLE_FORMAT_VERSION, type Bundle, type PackageIdentity } from "./types.ts";
import { BundleError } from "./errors.ts";
import { parsePackageIdentity } from "./types.ts";

/**
 * Pinned DOS epoch (1980-01-01T00:00:00Z) for ZIP mtime. Any earlier
 * value crashes fflate; any later value makes outputs depend on wall
 * clock. This is the canonical "zero" for ZIP determinism.
 */
const DOS_EPOCH_MS = Date.UTC(1980, 0, 1, 0, 0, 0);

export async function writeBundleToFile(bundle: Bundle, path: string): Promise<void> {
  const buf = writeBundleToBuffer(bundle);
  await writeFile(path, buf);
}

export function writeBundleToBuffer(bundle: Bundle): Uint8Array {
  if (bundle.bundleFormatVersion !== BUNDLE_FORMAT_VERSION) {
    throw new BundleError(
      "VERSION_UNSUPPORTED",
      `writer only emits ${BUNDLE_FORMAT_VERSION}, got ${bundle.bundleFormatVersion}`,
      { got: bundle.bundleFormatVersion, expected: BUNDLE_FORMAT_VERSION },
    );
  }
  if (!bundle.packages.has(bundle.root)) {
    throw new BundleError(
      "BUNDLE_JSON_INVALID",
      `root ${bundle.root} not present in packages map`,
      { root: bundle.root },
    );
  }

  // Build the flat ZIP entry map, with paths keyed for zipSync. Iterate
  // identities in sorted order so both the ZIP central directory and
  // bundle.json come out in stable order.
  const sortedIds = [...bundle.packages.keys()].sort() as PackageIdentity[];
  const flatEntries: Record<string, Uint8Array> = {};
  const pkgIndex: Record<PackageIdentity, { path: string; integrity: string }> = {};

  for (const identity of sortedIds) {
    const pkg = bundle.packages.get(identity)!;
    const parsed = parsePackageIdentity(identity);
    if (!parsed) {
      throw new BundleError(
        "BUNDLE_JSON_INVALID",
        `invalid package identity in bundle: ${identity}`,
      );
    }
    const pkgPath = `packages/@${parsed.scope}/${parsed.name}/${parsed.version}/`;

    // Recompute RECORD so the writer is authoritative — callers that
    // mutated files in memory still produce a consistent archive.
    const recordBody = serializeRecord(computeRecordEntries(pkg.files));
    const recordBytes = new TextEncoder().encode(recordBody);
    const computedIntegrity = recordIntegrity(recordBody);

    // Emit files in sorted order. `fflate.zipSync` preserves insertion
    // order for the central directory, so sorted input = sorted output.
    const sortedPaths = [...pkg.files.keys()].filter((p) => p !== "RECORD").sort();
    flatEntries[`${pkgPath}RECORD`] = recordBytes;
    for (const p of sortedPaths) {
      flatEntries[`${pkgPath}${p}`] = pkg.files.get(p)!;
    }

    pkgIndex[identity] = { path: pkgPath, integrity: computedIntegrity };
  }

  // Bundle-level integrity: canonical JSON of the packages map only.
  const bundleLevel = new Map<PackageIdentity, { path: string; integrity: string }>();
  for (const id of sortedIds) bundleLevel.set(id, pkgIndex[id]!);
  const computedBundleIntegrity = bundleIntegrity(bundleLevel);

  // Build `bundle.json`. Use canonical-JSON so outputs are byte-stable
  // regardless of insertion order of metadata fields.
  const bundleJsonObj: Record<string, unknown> = {
    bundleFormatVersion: bundle.bundleFormatVersion,
    root: bundle.root,
    packages: pkgIndex,
    integrity: computedBundleIntegrity,
  };
  if (bundle.metadata && Object.keys(bundle.metadata).length > 0) {
    bundleJsonObj.metadata = bundle.metadata;
  }
  const bundleJson = canonicalJsonStringify(bundleJsonObj);
  flatEntries["bundle.json"] = new TextEncoder().encode(bundleJson);

  // fflate uses the DOS epoch (1980-01-01) as the earliest legal mtime.
  // Passing `mtime: 0` would be interpreted as Jan 1 1970 and rejected.
  // We pin to exactly the DOS epoch so outputs are byte-stable across
  // machines and wall-clock times. `level: 0` selects STORE (no deflate)
  // — fully deterministic. Spec §4.2 disclaims compression anyway.
  const zipInput: Record<string, [Uint8Array, { mtime?: number; level?: number }]> = {};
  for (const [key, value] of Object.entries(flatEntries)) {
    zipInput[key] = [value, { mtime: DOS_EPOCH_MS, level: 0 }];
  }
  return zipSync(
    zipInput as unknown as Parameters<typeof zipSync>[0],
    { level: 0, mtime: DOS_EPOCH_MS } as Parameters<typeof zipSync>[1],
  );
}
