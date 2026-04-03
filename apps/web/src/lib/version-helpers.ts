// SPDX-License-Identifier: Apache-2.0

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
