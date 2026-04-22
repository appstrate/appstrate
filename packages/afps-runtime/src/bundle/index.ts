// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Public surface for `@appstrate/afps-runtime/bundle`.
 *
 * The new multi-package {@link Bundle} contract (spec §4) is the primary
 * API from Phase 1 onwards. The legacy single-package {@link LoadedBundle}
 * surface is kept during the migration — callers should prefer the new
 * API and use {@link loadedBundleToBundle} when bridging.
 */

// ─── New Bundle contract ────────────────────────────────────────────
export {
  BUNDLE_FORMAT_VERSION,
  parsePackageIdentity,
  formatPackageIdentity,
  type Bundle,
  type BundleFormatVersion,
  type BundleMetadata,
  type BundlePackage,
  type PackageCatalog,
  type PackageIdentity,
  type ParsedPackageIdentity,
  type ResolvedPackage,
  type AfpsManifest,
} from "./types.ts";
export { BundleError, type BundleErrorCode } from "./errors.ts";
export { DEFAULT_BUNDLE_LIMITS, resolveBundleLimits, type BundleLimits } from "./limits.ts";
export { canonicalJsonStringify } from "./canonical-json.ts";
export {
  bundleIntegrity,
  computeRecordEntries,
  integrityEqual,
  parseRecord,
  recordFileHash,
  recordIntegrity,
  serializeRecord,
  type RecordEntry,
} from "./integrity.ts";
export { readBundleFromBuffer, readBundleFromFile, type ReadBundleOptions } from "./read.ts";
export { writeBundleToBuffer, writeBundleToFile } from "./write.ts";
export {
  buildBundleFromAfps,
  buildBundleFromCatalog,
  extractRootFromAfps,
  type BuildBundleOptions,
} from "./build.ts";
export {
  InMemoryPackageCatalog,
  composeCatalogs,
  emptyPackageCatalog,
  type InMemoryCatalogOptions,
} from "./catalog.ts";
export {
  validateBundle as validateBundleV2,
  type BundleValidationIssue,
  type BundleValidationResult,
  type ValidateBundleV2Options,
} from "./validate-bundle.ts";
export { bundleOfOneFromAfps, loadedBundleToBundle } from "./bridge.ts";

// ─── Legacy single-package surface (deprecated, kept for migration) ─
export {
  renderPrompt,
  buildPromptView,
  type PromptView,
  type PromptViewProvider,
  type PromptViewUpload,
  type RenderPromptOptions,
} from "./prompt-renderer.ts";
export { computeIntegrity, verifyIntegrity, type IntegrityCheckResult } from "./hash.ts";
export {
  loadBundleFromBuffer,
  loadBundleFromFile,
  BundleLoadError,
  type LoadedBundle,
  type LoadBundleOptions,
} from "./loader.ts";
export {
  validateBundle,
  type ValidationResult,
  type ValidationIssue,
  type ValidateBundleOptions,
} from "./validator.ts";
export {
  canonicalBundleDigest,
  signBundle,
  signChildKey,
  verifyBundleSignature,
  verifySigstoreSignature,
  readBundleSignature,
  generateKeyPair,
  keyIdFromPublicKey,
  type BundleSignature,
  type TrustChainEntry,
  type TrustedKey,
  type TrustRoot,
  type KeyPair,
  type SignBundleOptions,
  type SignChildKeyOptions,
  type VerifySignatureResult,
  type VerifySignatureFailureReason,
} from "./signing.ts";
