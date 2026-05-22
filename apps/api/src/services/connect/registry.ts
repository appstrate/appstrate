// SPDX-License-Identifier: Apache-2.0

/**
 * Strategy selector (spec §4.2). Maps a manifest auth declaration to its
 * acquisition strategy:
 *
 *   - `oauth2`                          → OAuth2Strategy
 *   - `custom` + `connect.steps`        → TwoStepStrategy (declarative)
 *   - `custom` + `connect.tool`         → OrchestratedStrategy (code, needs executor)
 *   - `api_key` / `basic` / bare custom → FieldsStrategy (paste-the-bag)
 *
 * `oauth1` has no working connect path (removed in Phase 7).
 *
 * `connect.tool` (Orchestrated) requires a {@link ConnectToolExecutor} — the
 * connect-run substrate that actually runs the untrusted login tool. Callers
 * that can supply one (the connect-run / sidecar boot path) pass it; the plain
 * dashboard connect path does not, and resolving a `connect.tool` auth without
 * an executor is a structured error rather than a silent half-acquisition.
 */

import { invalidRequest } from "../../lib/errors.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { OAuth2Strategy } from "./oauth2-strategy.ts";
import { FieldsStrategy } from "./fields-strategy.ts";
import { TwoStepStrategy } from "./twostep-strategy.ts";
import { OrchestratedStrategy, type ConnectToolExecutor } from "./orchestrated-strategy.ts";
import type { IntegrationConnectStrategy } from "./strategy.ts";

type IntegrationAuthDef = NonNullable<IntegrationManifest["auths"]>[string];

export interface ResolveStrategyOptions {
  /** Connect-run substrate, required to resolve a `custom` + `connect.tool` auth. */
  connectToolExecutor?: ConnectToolExecutor;
}

export function resolveStrategy(
  auth: IntegrationAuthDef,
  opts: ResolveStrategyOptions = {},
): IntegrationConnectStrategy {
  switch (auth.type) {
    case "oauth2":
      return new OAuth2Strategy();
    case "custom":
      // Declarative multi-step login → TwoStep.
      if (auth.connect?.steps) return new TwoStepStrategy();
      // Code-orchestrated login → Orchestrated (requires the connect-run substrate).
      if (auth.connect?.tool) {
        if (!opts.connectToolExecutor) {
          throw invalidRequest(
            `Auth '${auth.connect.tool}' uses connect.tool (orchestrated login), which runs in the connect-run substrate and is not available on this path`,
          );
        }
        return new OrchestratedStrategy(opts.connectToolExecutor);
      }
      // Otherwise paste-the-bag Fields.
      return new FieldsStrategy();
    case "api_key":
    case "basic":
      return new FieldsStrategy();
    default:
      throw invalidRequest(`Auth type '${auth.type}' has no connect strategy`);
  }
}
