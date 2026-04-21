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

export {
  renderPrompt,
  buildPromptView,
  type PromptView,
  type PromptViewProvider,
  type PromptViewUpload,
  type RenderPromptOptions,
} from "./bundle/prompt-renderer.ts";
export { computeIntegrity, verifyIntegrity, type IntegrityCheckResult } from "./bundle/hash.ts";
export {
  loadBundleFromBuffer,
  loadBundleFromFile,
  BundleLoadError,
  type LoadedBundle,
  type LoadBundleOptions,
} from "./bundle/loader.ts";
export {
  validateBundle,
  type ValidationResult,
  type ValidationIssue,
  type ValidateBundleOptions,
} from "./bundle/validator.ts";
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
} from "./bundle/signing.ts";

export * from "./runner/index.ts";
export * from "./conformance/index.ts";
export * from "./resolvers/index.ts";
