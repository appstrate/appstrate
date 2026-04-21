// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

export {
  renderPrompt,
  buildPromptView,
  type PromptView,
  type PromptViewProvider,
  type PromptViewUpload,
  type RenderPromptOptions,
} from "./prompt-renderer.ts";
export {
  resolvePreludes,
  MapPreludeResolver,
  PreludeResolutionError,
  type PreludeRef,
  type PreludeResolver,
} from "./preludes.ts";
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
