// SPDX-License-Identifier: Apache-2.0

import { packageDetailPath } from "./package-paths";

export function getVersionRedirect(params: {
  type: string;
  packageId: string;
  versionParam: string | undefined;
  versionDetail: { version: string } | undefined;
  liveVersion: string | null | undefined;
  hasDraftChanges: boolean;
}): { redirect: string } | { isHistoricalVersion: boolean } {
  const { type, packageId, versionParam, versionDetail, liveVersion, hasDraftChanges } = params;
  const basePath = packageDetailPath(type, packageId);

  if (versionParam && !versionDetail) {
    return { redirect: basePath };
  }

  if (!versionParam || !versionDetail) {
    return { isHistoricalVersion: false };
  }

  // A draft exists → any published version is read-only
  if (hasDraftChanges) {
    return { isHistoricalVersion: true };
  }

  // No draft → latest version is editable, older versions are read-only
  const isLatest = versionDetail.version === liveVersion;
  return { isHistoricalVersion: !isLatest };
}
