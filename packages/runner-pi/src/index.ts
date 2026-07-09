// SPDX-License-Identifier: Apache-2.0

export {
  PiRunner,
  installSessionBridge,
  derivePiCompactionSettings,
  type PiRunnerOptions,
  type PiModelConfig,
  type BridgeableSession,
  type InternalSink,
} from "./pi-runner.ts";

export { deriveProviderFromApi, PROVIDER_BY_API } from "./provider-map.ts";

// Warms `@mariozechner/pi-coding-agent` (dynamic import) so the container
// entrypoint can overlap its ~200ms eval with network-bound provisioning
// instead of paying it on the pre-session boot path. `Type` (pi-ai, cheap) is a
// static value export for building tool parameter schemas; the SDK type surface
// (Model/Api/ExtensionFactory/ExtensionAPI/AuthStorage) rides through here so
// consumers (e.g. the chat module's Pi engine) never import the vendor SDK
// directly — the single-import-surface guard is the barrel.
export { Type, loadPiCodingAgentSdk, type PiCodingAgentSdk } from "./pi-sdk.ts";
export type {
  Api,
  KnownApi,
  Model,
  AuthStorage,
  ExtensionAPI,
  ExtensionFactory,
} from "./pi-sdk.ts";

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
  CURRENT_RUNTIME_PROTOCOL_VERSION,
  type RuntimeReadyPayload,
  type BootProgressOptions,
} from "./runtime-ready.ts";

export {
  startSinkHeartbeat,
  type StartSinkHeartbeatOptions,
  type SinkHeartbeatHandle,
} from "./sink-heartbeat.ts";

export type { AppstrateToolCtx, AppstrateCtxProvider } from "./tool-context.ts";

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
} from "./runtime-tools/runtime-tool-extensions.ts";

export {
  spillResourcesToWorkspace,
  type ResourceSpillOptions,
} from "./runtime-tools/resource-spill.ts";
