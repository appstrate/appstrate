// SPDX-License-Identifier: Apache-2.0

// `connect` — unified credential acquisition primitive (spec §4).
// Barrel for the pure, import-cost-free contracts consumed by the
// orchestration layer (apps/api) and the sidecar executor.

export type { CredentialBundle } from "./types.ts";
export type { ConnectContext, BeginOptions, BeginResult } from "./strategy.ts";
export { runLogin, LoginError } from "./login-engine.ts";
// Only `LoginConfig` is consumed across the package boundary (apps/api's
// login-strategy passes a manifest's `connect` block as `LoginConfig`). The
// engine's granular sub-types (LoginStep/Request/Extractor/Limits/Context/
// Result) stay internal — callers rely on inference, not named imports.
export type { LoginConfig } from "./login-engine.ts";
