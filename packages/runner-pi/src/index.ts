// SPDX-License-Identifier: Apache-2.0

// Same rule as every block below, and it holds for TYPES as much as values: a
// line here is only what something OUTSIDE the package imports FROM THE BARREL.
// `installSessionBridge` (#1202) and `preserveRequestedThinkingLevel` (#1209)
// lost their last such reader and came off this list.
//
// So did fifteen `Options`/payload types across the blocks below — an options
// type is re-exported next to its function by reflex, but no consumer here ever
// names one (they pass an object literal). Every symbol dropped for either
// reason stays exported from its own module for in-package use; only the
// re-export line goes. knip is what sees this now: `includeEntryExports` is on
// for this workspace (`knip.config.ts`), so a barrel line with no reader fails
// the gate instead of being invisible.
export {
  PiRunner,
  derivePiCompactionSettings,
  prepareRequestedThinkingLevel,
  setPiRuntimeCredential,
  type PiRunnerOptions,
  type PiModelConfig,
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
  llmProxyBaseUrl,
  llmProxyUrlPath,
  type ProxiedApiShape,
} from "./llm-proxy-routes.ts";
// `isProxiedApiShape` is NOT here: grepped, and it is read only inside
// `llm-proxy-routes.ts` (and its test, from the source path). It was added with
// the four above, six lines under the rule that forbids it — which is the point
// of the rule, since knip cannot see a barrel export with no reader.
// `LlmProxyRoute` went further and is no longer exported at all.

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

export { prepareBundleForPi } from "./bundle-extensions.ts";

export { buildApiCallExtensionFactory } from "./api-call-bridge.ts";

export { buildRuntimePiEnv, pickOperatorSidecarEnv } from "./container-env.ts";
// `SIDECAR_OPERATOR_ENV_KEYS` is NOT here: #1178 removed its last external
// reader. The platform forwards operator env through `pickOperatorSidecarEnv`;
// the key list itself is read only inside this package (`container-env.ts` and
// its tests).

export { emitRuntimeReady, emitBootProgress } from "./runtime-ready.ts";

export { startSinkHeartbeat, type SinkHeartbeatHandle } from "./sink-heartbeat.ts";

// `RUN_HISTORY_INJECTED_TOOL` / `RECALL_MEMORY_INJECTED_TOOL` are NOT here:
// their one outside consumer (`runtime-pi/sidecar/mcp.ts`) imports them from
// the `./runtime-tools` subpath, the same barrel-vs-subpath split as
// `PI_SDK_VERSION` above.
export { RUNTIME_INJECTED_TOOLS } from "./runtime-tools/index.ts";

export {
  buildRuntimeToolFactories,
  callToolResultToPi,
  type RuntimeEventEmitter,
} from "./runtime-tools/mcp-forward.ts";

export {
  buildRuntimeToolExtensions,
  buildPublishFileExtension,
} from "./runtime-tools/runtime-tool-extensions.ts";

export { spillResourcesToWorkspace } from "./runtime-tools/resource-spill.ts";
