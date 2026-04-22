// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Public surface for `@appstrate/afps-runtime/bundle`.
 *
 * The multi-package {@link Bundle} contract (spec §4) is the primary
 * API. {@link LoadedBundle} is a flat path-keyed projection used by
 * runtime consumers that prefer single-map file access — both are
 * first-class and stable.
 *
 * Interop utilities at the bottom (`bundleToLoadedBundle`,
 * `loadedBundleToBundle`, `loadAnyBundleFrom*`) let callers move between
 * the two representations without re-decoding the archive.
 */

// ─── Core types + errors ────────────────────────────────────────────
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

// ─── Integrity primitives (RECORD + bundle.json merkle) ─────────────
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
// Byte-level SRI over a whole archive (used by platform storage layer
// to detect at-rest corruption — orthogonal to the Merkle integrity
// that ships inside Bundle.integrity).
export { computeIntegrity, type IntegrityCheckResult } from "./hash.ts";

// ─── Read / write / build ───────────────────────────────────────────
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

// ─── Validation ─────────────────────────────────────────────────────
// Primary: multi-package Bundle validator.
export {
  validateBundle,
  type BundleValidationIssue,
  type BundleValidationResult,
  type ValidateBundleOptions,
} from "./validate-bundle.ts";
// Secondary: AFPS single-package manifest validator — used when you
// only have a `LoadedBundle` (tooling, CLI inspect/verify paths).
export {
  validateAfpsManifest,
  type AfpsManifestValidationIssue,
  type AfpsManifestValidationResult,
  type ValidateAfpsManifestOptions,
} from "./validator.ts";

// ─── LoadedBundle flat surface + interop adapters ───────────────────
export { loadBundleFromBuffer, type LoadedBundle } from "./loader.ts";
export {
  bundleOfOneFromAfps,
  bundleToLoadedBundle,
  loadAnyBundleFromBuffer,
  loadAnyBundleFromFile,
  loadedBundleToBundle,
  type LoadAnyBundleOptions,
} from "./bridge.ts";

// ─── Prompt rendering ───────────────────────────────────────────────
export {
  renderPrompt,
  buildPromptView,
  type PromptView,
  type PromptViewProvider,
  type PromptViewUpload,
  type RenderPromptOptions,
} from "./prompt-renderer.ts";

// ─── Signing / trust root ───────────────────────────────────────────
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
