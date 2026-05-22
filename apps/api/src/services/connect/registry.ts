// SPDX-License-Identifier: Apache-2.0

/**
 * Strategy selector (spec §4.2). Maps a manifest auth declaration to its
 * acquisition strategy:
 *
 *   - `oauth2`                       → OAuth2Strategy
 *   - `api_key` / `basic` / `custom` → FieldsStrategy
 *
 * `custom` gains TwoStep (declarative `connect.steps`) and Orchestrated
 * (`connect.tool`) branches in Phases 3–4; until then a `custom` auth is a
 * paste-the-bag Fields connect, matching today's behaviour. `oauth1` has no
 * working connect path (removed in Phase 7).
 */

import { invalidRequest } from "../../lib/errors.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import { OAuth2Strategy } from "./oauth2-strategy.ts";
import { FieldsStrategy } from "./fields-strategy.ts";
import type { IntegrationConnectStrategy } from "./strategy.ts";

type IntegrationAuthDef = NonNullable<IntegrationManifest["auths"]>[string];

export function resolveStrategy(auth: IntegrationAuthDef): IntegrationConnectStrategy {
  switch (auth.type) {
    case "oauth2":
      return new OAuth2Strategy();
    case "api_key":
    case "basic":
    case "custom":
      return new FieldsStrategy();
    default:
      throw invalidRequest(`Auth type '${auth.type}' has no connect strategy`);
  }
}
