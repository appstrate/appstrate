// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * AFPS runtime resolvers.
 *
 * Interfaces for loading in-bundle `dependencies.skills[]` content plus the
 * integration `api_call` surface. The runtime supplies a default "bundled"
 * skill implementation that reads content shipped inside the `.afps` file;
 * runners supply external implementations (notably the integration credential
 * resolvers) for anything that lives outside the bundle.
 *
 * NOTE: the `Tool` types here are the generic MCP Tool protocol from
 * `@afps-spec/types` — they describe the shape of a tool surfaced to the LLM
 * (e.g. the integration `api_call` tool built by `makeApiCallTool`). In AFPS
 * tools come from spawned `mcp-server` packages (§3.4) and integrations
 * (§3.5), NOT from loading a package `entrypoint` module in-process.
 *
 * Specification: `afps-spec/spec.md` §8.
 */

export type {
  Bundle,
  BundlePackage,
  DependencyRef,
  SkillRef,
  JSONSchema,
  Tool,
  ToolContext,
  ToolResult,
  ResolvedSkill,
  SkillResolver,
} from "./types.ts";

// RunEvent lives in src/types/ — re-exported here for convenience so
// resolver authors can import all the types they need from one place.
export type { RunEvent } from "@afps-spec/types";

export { BundledSkillResolver, BundledSkillResolutionError } from "./bundled-skill-resolver.ts";
export { resolvePackageRef, readPackageText, readPackageBytes } from "./bundle-adapter.ts";

// Canonical `delivery.http` credential-injection resolver (shared with
// `@appstrate/connect`, which re-exports these).
export {
  resolveHttpDelivery,
  type HttpDeliveryConfig,
  type HttpDeliveryPlan,
} from "./http-delivery.ts";

// Canonical `{{var}}` credential substitution — shared by the platform
// credential proxy (`@appstrate/connect` re-export), the delivery.http
// renderer, and the portable integration resolver.
export { substituteVars } from "./template-vars.ts";

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
  resolveSafeFile,
  resolveSafePath,
  resolveWorkspaceFile,
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

// Shared, credential-source-agnostic outbound-HTTP engine: authorized_uris
// + SSRF preflight and the manual redirect-follower (per-hop SSRF + per-hop
// allowlist + hybrid credential-strip + cookie capture). Consumed by the
// sidecar's `executeApiCall` (platform path) AND the local CLI resolver.
export {
  MAX_REDIRECTS,
  matchesAuthorizedUri,
  hostLiterallyAllowlisted,
  stripUserInfoAndFragment,
  redactHost,
  mergeSetCookieIntoJar,
  fetchFollowingRedirectsCapturingCookies,
  guardedFetch,
  RedirectBlockedError,
} from "./api-call-engine.ts";

// Integration `api_call` surface — the portable equivalent of the platform's
// `{ns}__api_call` MCP tool. Reuses the same HTTP core (`makeApiCallTool`) as
// the runtime's spawned-integration resolvers.
export {
  LocalIntegrationResolver,
  RemoteAppstrateIntegrationResolver,
  readIntegrationRefs,
  readApiCallIntegrationMetas,
  apiCallToolName,
  type IntegrationApiCallResolver,
  type IntegrationRef,
} from "./integration-api-call.ts";
