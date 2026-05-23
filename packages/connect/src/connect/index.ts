// SPDX-License-Identifier: Apache-2.0

// `connect` — unified credential acquisition primitive (spec §4).
// Barrel for the pure, import-cost-free contracts consumed by the
// orchestration layer (apps/api) and the sidecar executor.

export type { CredentialBundle } from "./types.ts";
export type { ConnectContext, BeginOptions, BeginResult } from "./strategy.ts";
export { runLogin, LoginError, DEFAULT_LOGIN_LIMITS } from "./login-engine.ts";
export type {
  LoginConfig,
  LoginStep,
  LoginRequest,
  LoginExtractor,
  LoginLimits,
  LoginContext,
  LoginResult,
} from "./login-engine.ts";
