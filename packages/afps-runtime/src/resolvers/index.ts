// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 runtime resolvers.
 *
 * Three interfaces mirroring `dependencies.tools[]`, `.providers[]`,
 * `.skills[]` on an agent manifest. The runtime supplies default
 * "bundled" implementations that read content shipped inside the `.afps`
 * file; runners supply external implementations (notably `ProviderResolver`)
 * for anything that lives outside the bundle.
 *
 * Specification: `afps-spec/spec.md` §8.
 */

export type {
  Bundle,
  BundlePackage,
  DependencyRef,
  ToolRef,
  ProviderRef,
  SkillRef,
  JSONSchema,
  Tool,
  ToolContext,
  ToolResult,
  ResolvedSkill,
  ToolResolver,
  ProviderResolver,
  SkillResolver,
  SpecRunResult,
} from "./types.ts";

// RunEvent lives in src/types/ — re-exported here for convenience so
// resolver authors can import all the types they need from one place.
export type { RunEvent } from "@afps-spec/types";

export {
  BundledToolResolver,
  BundledToolResolutionError,
  type BundledToolModule,
} from "./bundled-tool-resolver.ts";
export { BundledSkillResolver, BundledSkillResolutionError } from "./bundled-skill-resolver.ts";
export { resolvePackageRef, readPackageText, readPackageBytes } from "./bundle-adapter.ts";

// Provider-resolver surface — tool factory + concrete impls.
export {
  makeProviderTool,
  matchesAuthorizedUriSpec,
  providerToolName,
  readProviderMeta,
  resolveBodyStream,
  serializeFetchResponse,
  slugifyProviderId,
  type ProviderMeta,
  type ProviderCallRequest,
  type ProviderCallResponse,
  type ProviderCallFn,
  type MakeProviderToolOptions,
} from "./provider-tool.ts";
export {
  SidecarProviderResolver,
  type SidecarProviderResolverOptions,
} from "./sidecar-provider-resolver.ts";
export {
  LocalProviderResolver,
  type LocalCredentialsFile,
  type LocalProviderResolverOptions,
} from "./local-provider-resolver.ts";
export {
  RemoteAppstrateProviderResolver,
  type RemoteAppstrateProviderResolverOptions,
} from "./remote-appstrate-provider-resolver.ts";

// Run history tool — sidecar-backed fetch of prior-run metadata.
export {
  makeRunHistoryTool,
  createSidecarRunHistoryCall,
  type RunHistoryRequest,
  type RunHistoryResponse,
  type RunHistoryEntry,
  type RunHistoryField,
  type RunHistoryCallFn,
  type MakeRunHistoryToolOptions,
  type CreateSidecarRunHistoryCallOptions,
} from "./run-history-tool.ts";

// Spec-compliant platform tools (memory, state, output, report, log)
// — the runtime no longer hardcodes these internally; agents declare
// them in dependencies.tools[] and a BundledToolResolver loads them.
export {
  memoryTool,
  stateTool,
  outputTool,
  reportTool,
  logTool,
  PLATFORM_TOOLS,
  platformToolOverrides,
} from "./platform-tools.ts";
