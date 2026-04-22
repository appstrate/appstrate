// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * @appstrate/afps-runtime — portable runtime for AFPS agent bundles.
 *
 * Top-level barrel exports. The package is organised into subpath
 * entrypoints (see the `exports` field in package.json) so callers can
 * import the narrow surface they need; the top-level re-exports the
 * full public API for convenience.
 *
 * The multi-package {@link Bundle} contract (spec §4) is the single
 * runtime representation — every resolver, runner, and tool consumes
 * Bundle directly via `Bundle.packages.get(identity)`.
 *
 * AFPS 1.3 introduces three spec-aligned resolver interfaces
 * (ToolResolver, ProviderResolver, SkillResolver). They live under
 * `@appstrate/afps-runtime/resolvers`.
 */

export const VERSION = "0.0.0";

export * from "./interfaces/index.ts";
export * from "./types/index.ts";
export * from "./events/index.ts";
export * from "./sinks/index.ts";
export * from "./template/index.ts";

// Multi-package Bundle contract (spec §4) — the single runtime
// representation.
export {
  BUNDLE_FORMAT_VERSION,
  BundleError,
  DEFAULT_BUNDLE_LIMITS,
  InMemoryPackageCatalog,
  buildBundleFromAfps,
  buildBundleFromCatalog,
  bundleIntegrity,
  canonicalJsonStringify,
  composeCatalogs,
  computeRecordEntries,
  emptyPackageCatalog,
  extractRootFromAfps,
  formatPackageIdentity,
  integrityEqual,
  parsePackageIdentity,
  parseRecord,
  readBundleFromBuffer,
  readBundleFromFile,
  recordFileHash,
  recordIntegrity,
  resolveBundleLimits,
  serializeRecord,
  validateBundle,
  writeBundleToBuffer,
  writeBundleToFile,
  type AfpsManifest,
  type BuildBundleOptions,
  type Bundle,
  type BundleErrorCode,
  type BundleFormatVersion,
  type BundleLimits,
  type BundleMetadata,
  type BundlePackage,
  type BundleValidationIssue,
  type BundleValidationResult,
  type InMemoryCatalogOptions,
  type PackageCatalog,
  type PackageIdentity,
  type ParsedPackageIdentity,
  type ReadBundleOptions,
  type RecordEntry,
  type ResolvedPackage,
  type ValidateBundleOptions,
} from "./bundle/index.ts";

// Prompt rendering.
export {
  renderPrompt,
  buildPromptView,
  type PromptView,
  type PromptViewProvider,
  type PromptViewUpload,
  type RenderPromptOptions,
} from "./bundle/index.ts";

// Archive-level SRI integrity helpers (orthogonal to Bundle.integrity).
export { computeIntegrity, type IntegrityCheckResult } from "./bundle/index.ts";

// Signature policy wrapper (3-state off/warn/required).
export {
  verifyBundleWithPolicy,
  BundleSignaturePolicyError,
  type SignaturePolicy,
  type SignaturePolicyReason,
  type VerifyBundlePolicyOptions,
  type VerifyBundlePolicyOutcome,
} from "./bundle/index.ts";

// Signing + trust root.
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
} from "./bundle/index.ts";

export * from "./runner/index.ts";
export * from "./conformance/index.ts";
export * from "./resolvers/index.ts";
