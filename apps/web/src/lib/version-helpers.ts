// SPDX-License-Identifier: Apache-2.0

import type { VersionDetailResponse } from "@appstrate/shared-types";
import { packageDetailPath } from "./package-paths";

export function getVersionRedirect(params: {
  type: string;
  packageId: string;
  versionParam: string | undefined;
  versionDetail: { version: string } | undefined;
  liveVersion: string | null | undefined;
  hasArchivableChanges: boolean;
}): { redirect: string } | { isHistoricalVersion: boolean } {
  const { type, packageId, versionParam, versionDetail, liveVersion, hasArchivableChanges } =
    params;
  const basePath = packageDetailPath(type, packageId);

  if (versionParam && !versionDetail) {
    return { redirect: basePath };
  }

  if (!versionParam || !versionDetail) {
    return { isHistoricalVersion: false };
  }

  // Any archived version is read-only — the active version is always what the user edits
  if (hasArchivableChanges) {
    return { isHistoricalVersion: true };
  }

  // No unarchived changes → latest version is editable, older versions are read-only
  const isLatest = versionDetail.version === liveVersion;
  return { isHistoricalVersion: !isLatest };
}

/**
 * Deterministic JSON serialization with recursively sorted object keys, so
 * two structurally-equal manifests that differ only in key insertion order
 * compare equal. Plain `JSON.stringify` is order-sensitive and would report a
 * spurious diff after a round-trip that reorders keys.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Check whether there are real content differences between active state and a version. */
export function hasActualChanges(
  latestVersion: VersionDetailResponse | undefined,
  currentManifest: Record<string, unknown> | undefined,
  currentContent: string | undefined | null,
): boolean {
  if (!latestVersion) return false;
  const manifestDiff =
    stableStringify(currentManifest ?? {}) !== stableStringify(latestVersion.manifest ?? {});
  const contentDiff =
    latestVersion.content != null &&
    currentContent != null &&
    latestVersion.content !== currentContent;
  return manifestDiff || contentDiff;
}
