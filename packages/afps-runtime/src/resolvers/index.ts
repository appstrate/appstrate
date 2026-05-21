// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS 1.3 runtime resolvers.
 *
 * Interfaces mirroring `dependencies.tools[]` and `.skills[]` on an agent
 * manifest, plus the integration `api_call` surface. The runtime supplies
 * default "bundled" implementations that read content shipped inside the
 * `.afps` file; runners supply external implementations (notably the
 * integration credential resolvers) for anything that lives outside the
 * bundle.
 *
 * Specification: `afps-spec/spec.md` §8.
 */

export type {
  Bundle,
  BundlePackage,
  DependencyRef,
  ToolRef,
  SkillRef,
  JSONSchema,
  Tool,
  ToolContext,
  ToolResult,
  ResolvedSkill,
  ToolResolver,
  SkillResolver,
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

// Reusable credential-injecting HTTP-call core — tool factory + helpers.
export {
  ABSOLUTE_MAX_RESPONSE_SIZE,
  defaultInlineLimit,
  MAX_REQUEST_BODY_SIZE,
  MAX_STREAMED_BODY_SIZE,
  STREAMING_THRESHOLD,
  makeApiCallTool,
  matchesAuthorizedUriSpec,
  isReproducibleBody,
  apiCallRequestJsonSchema,
  resolveBodyForFetch,
  resolveBodyStream,
  resolveSafeFile,
  resolveSafePath,
  serializeFetchResponse,
  type MakeApiCallToolOptions,
  type ApiCallContext,
  type ApiCallFn,
  type ApiCallRequest,
  type ApiCallResponse,
  type ApiCallResponseBody,
  type ApiCallMeta,
  type ResolveBodyStreamOptions,
  type ResolvedRequestBody,
  type SerializeFetchResponseContext,
} from "./http-call-core.ts";

// Integration `api_call` surface (provider→integration unification) — the
// portable equivalent of the platform's `{ns}__api_call` MCP tool. Reuses
// the same HTTP core (`makeApiCallTool`) as the provider resolvers.
export {
  LocalIntegrationResolver,
  RemoteAppstrateIntegrationResolver,
  readIntegrationRefs,
  readApiCallIntegrationMeta,
  apiCallToolName,
  type IntegrationApiCallResolver,
  type IntegrationRef,
  type ApiCallIntegrationMeta,
  type HttpDeliveryConfig,
  type LocalIntegrationCredentialsFile,
  type LocalIntegrationResolverOptions,
  type RemoteAppstrateIntegrationResolverOptions,
} from "./integration-api-call.ts";

// Spec-compliant platform tools (note, pin, output, log) — the
// runtime no longer hardcodes these internally; agents declare them in
// dependencies.tools[] and a BundledToolResolver loads them.
export { noteTool, pinTool, outputTool, logTool, PLATFORM_TOOLS } from "./platform-tools.ts";
