// SPDX-License-Identifier: Apache-2.0

export {
  PiRunner,
  installSessionBridge,
  type PiRunnerOptions,
  type PiModelConfig,
  type BridgeableSession,
  type InternalSink,
} from "./pi-runner.ts";

export { prepareBundleForPi, type PrepareBundleOptions } from "./bundle-extensions.ts";

export {
  buildApiCallExtensionFactory,
  readIntegrationRefs,
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
