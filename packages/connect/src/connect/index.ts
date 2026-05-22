// SPDX-License-Identifier: Apache-2.0

// `connect` — unified credential acquisition primitive (spec §4).
// Barrel for the pure, import-cost-free contracts consumed by the
// orchestration layer (apps/api) and the sidecar executor.

export type { CredentialBundle } from "./types.ts";
export type {
  ConnectContext,
  BeginOptions,
  BeginResult,
  ConnectInput,
  ConnectStrategy,
} from "./strategy.ts";
export { runTwoStep, TwoStepError, DEFAULT_TWOSTEP_LIMITS } from "./twostep-engine.ts";
export type {
  TwoStepConfig,
  TwoStepStep,
  TwoStepRequest,
  TwoStepExtractor,
  TwoStepLimits,
  TwoStepContext,
  TwoStepResult,
} from "./twostep-engine.ts";
export { validateConnectToolResult, ConnectToolContractError } from "./tool-contract.ts";
export type {
  ConnectToolContext,
  ConnectToolResult,
  ConnectToolErrorReason,
} from "./tool-contract.ts";
