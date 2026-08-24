// SPDX-License-Identifier: Apache-2.0

export {
  PiRunner,
  installSessionBridge,
  derivePiCompactionSettings,
  preserveRequestedThinkingLevel,
  prepareRequestedThinkingLevel,
  setPiRuntimeCredential,
  type PiRunnerOptions,
  type PiModelConfig,
  type BridgeableSession,
  type InternalSink,
} from "./pi-runner.ts";

// Same rule as the `pi-sdk.ts` block below: only what something OUTSIDE the
// package imports FROM THE BARREL. Four more sat here and none had such a
// reader — `PI_SDK_VERSION` / `PI_SDK_VERSION_HEADER` reach the sidecar through
// the `./provider-map` subpath (`runtime-pi/sidecar/pi-messages-backend.ts`),
// and `ALIAS_PI_PROVIDER_KEY` / `PI_PROVIDER_BY_MODEL_PROVIDER` are read only
// inside this package. knip cannot see the difference — `index.ts` is an entry,
// so an export here always has "a reader". Re-add a line only when something
// outside the package actually imports it from `@appstrate/runner-pi`.
export { deriveProviderFromApi, derivePiProvider, PROVIDER_BY_API } from "./provider-map.ts";

// The llm-proxy's path convention, declared once. Read by `apps/api` to mount
// the proxy routes, and by the chat engine + the CLI to build the base URL a
// vendor client is pointed at — the three used to spell it out separately.
export {
  LLM_PROXY_ROUTES,
  isProxiedApiShape,
  llmProxyBaseUrl,
  llmProxyUrlPath,
  type LlmProxyRoute,
  type ProxiedApiShape,
} from "./llm-proxy-routes.ts";

// Warms `@earendil-works/pi-coding-agent` (dynamic import) so the container
// entrypoint can overlap its ~200ms eval with network-bound provisioning
// instead of paying it on the pre-session boot path. `Type` (pi-ai, cheap) is a
// static value export for building tool parameter schemas; the SDK type surface
// (Model/Api/Message/ExtensionFactory/ExtensionAPI) rides through here so
// consumers (e.g. the chat module's Pi engine) never import the vendor SDK
// directly — the single-import-surface guard is the barrel.
//
// This list is deliberately the *consumed* surface, not everything `pi-sdk.ts`
// holds. `streamSimple`/`SimpleStreamOptions`/`AssistantMessageEventStream`,
// `Transport`, `KnownApi`, `Context` and `ModelRuntime` were re-exported here
// for the AI-SDK chat loop and its generic dispatch seam; #1173 folded every
// chat turn onto `runPiChat`, and no consumer has imported them from this
// barrel since. They remain in `pi-sdk.ts` for in-package use — re-add a line
// here only when something outside the package actually imports it.
export { Type, loadPiCodingAgentSdk, type PiCodingAgentSdk } from "./pi-sdk.ts";
export type { Api, Model, Message, ExtensionAPI, ExtensionFactory } from "./pi-sdk.ts";
export type { PiSdkAgentSessionEvent, PiSdkAssistantMessageEvent, PiSdkUsage } from "./pi-sdk.ts";

export { prepareBundleForPi, type PrepareBundleOptions } from "./bundle-extensions.ts";

export {
  buildApiCallExtensionFactory,
  type BuildApiCallExtensionFactoryOptions,
} from "./api-call-bridge.ts";

export {
  buildRuntimePiEnv,
  pickOperatorSidecarEnv,
  SIDECAR_OPERATOR_ENV_KEYS,
  type RuntimePiEnvOptions,
  type RuntimePiModelConfig,
  type SidecarOperatorEnvKey,
} from "./container-env.ts";

export {
  emitRuntimeReady,
  emitBootProgress,
  type RuntimeReadyPayload,
  type BootProgressOptions,
} from "./runtime-ready.ts";

export {
  startSinkHeartbeat,
  type StartSinkHeartbeatOptions,
  type SinkHeartbeatHandle,
} from "./sink-heartbeat.ts";

export {
  RUN_HISTORY_INJECTED_TOOL,
  RECALL_MEMORY_INJECTED_TOOL,
  RUNTIME_INJECTED_TOOLS,
  type RuntimeInjectedTool,
} from "./runtime-tools/index.ts";

export {
  buildRuntimeToolFactories,
  callToolResultToPi,
  type BuildRuntimeToolFactoriesOptions,
  type RuntimeEventEmitter,
} from "./runtime-tools/mcp-forward.ts";

export {
  buildRuntimeToolExtensions,
  type BuildRuntimeToolExtensionsOptions,
  buildPublishFileExtension,
  type BuildPublishFileExtensionOptions,
} from "./runtime-tools/runtime-tool-extensions.ts";

export {
  spillResourcesToWorkspace,
  type ResourceSpillOptions,
} from "./runtime-tools/resource-spill.ts";
