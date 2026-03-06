/**
 * Re-export layer for package-versions.
 *
 * The actual implementation lives in package-versions-impl.ts.
 * This indirection exists because bun:test's `mock.module` is process-global
 * (first call wins). Marketplace tests mock "./package-versions.ts" with stubs,
 * while package-versions.test.ts needs the real implementation — it imports
 * from "./package-versions-impl.ts" which is never mocked.
 */
export {
  createPackageVersion,
  listPackageVersions,
  getLatestVersionId,
  getLatestVersionWithManifest,
  resolveVersion,
  getVersionForDownload,
  getVersionDetail,
  getVersionCount,
  yankVersion,
  deletePackageVersion,
  addDistTag,
  removeDistTag,
  getMatchingDistTags,
  getVersionInfo,
  getLatestVersionCreatedAt,
  createVersionFromDraft,
  createVersionAndUpload,
  replaceVersionContent,
} from "./package-versions-impl.ts";

export type { VersionDetail } from "./package-versions-impl.ts";
