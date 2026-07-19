// SPDX-License-Identifier: Apache-2.0

/**
 * Strategy selector (spec §4.2). Maps a manifest auth declaration to its
 * acquisition strategy:
 *
 *   - `oauth2`                                  → OAuth2Strategy
 *   - `custom` + `connect.login`                → LoginStrategy (declarative)
 *   - `custom` + `connect.tool`                 → OrchestratedStrategy (code, needs executor)
 *   - `api_key` / `basic` / `mtls` / bare custom → FieldsStrategy (paste-the-bag)
 *
 * `mtls` (AFPS §7.2) reuses FieldsStrategy: the user pastes a credential
 * bag (client certificate PEM + private key PEM, optional intermediate chain),
 * the manifest's `credentials.schema` validates the shape, and the bag is
 * persisted on the connection. At runtime the integration spawn resolver
 * materialises those fields into `delivery.files` entries — the runtime adapter
 * writes them to the runner's filesystem at the manifest-declared paths where
 * the HTTPS client loads them as cert + key.
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
import { LoginStrategy } from "./login-strategy.ts";
import { LoginSecretStrategy } from "./login-secret-strategy.ts";
import { OrchestratedStrategy, type ConnectToolExecutor } from "./orchestrated-strategy.ts";
import { BrowserConnectStrategy, type BrowserConnectExecutor } from "./browser-strategy.ts";
import {
  getAppstrateConnectMeta,
  getBrowserConnectExecutor,
  type AfpsManifestConnect,
} from "../integration-manifest-helpers.ts";
import type { IntegrationConnectStrategy } from "./strategy.ts";

type IntegrationAuthDef = NonNullable<IntegrationManifest["auths"]>[string];

export interface ResolveStrategyOptions {
  /** Connect-run substrate, required to resolve a `custom` + `connect.tool` auth. */
  connectToolExecutor?: ConnectToolExecutor;
  /** Trusted browser acquisition substrate; separate from ordinary connect.tool. */
  browserConnectExecutor?: BrowserConnectExecutor;
}

export function resolveStrategy(
  auth: IntegrationAuthDef,
  opts: ResolveStrategyOptions = {},
): IntegrationConnectStrategy {
  switch (auth.type) {
    case "oauth2":
      return new OAuth2Strategy();
    case "custom": {
      // Declarative single login request → Login.
      const connect = auth.connect as AfpsManifestConnect | undefined;
      if (connect?.login) return new LoginStrategy();
      // AFPS: `connect.tool` is the marker object `{}`; the orchestrated
      // tool name + `run_at` policy live under `connect._meta["dev.appstrate/connect"]`.
      const connectMeta = getAppstrateConnectMeta(connect);
      const browserExecutor = getBrowserConnectExecutor(connect);
      // connect.tool + run_at:"run-start" → store-the-secret only (P2). The
      // session is minted at each agent run by the sidecar's connect-login
      // primitive — no executor needed at dashboard connect.
      if (connect?.tool !== undefined && connectMeta?.run_at === "run-start") {
        return new LoginSecretStrategy();
      }
      if (connect?.tool !== undefined && browserExecutor) {
        if (!opts.browserConnectExecutor) {
          throw invalidRequest(
            `Auth tool '${connectMeta?.tool ?? "?"}' requires the trusted browser connect executor, which is not available on this path`,
          );
        }
        return new BrowserConnectStrategy(opts.browserConnectExecutor);
      }
      // Code-orchestrated login → Orchestrated (requires the connect-run substrate).
      if (connect?.tool !== undefined) {
        if (!opts.connectToolExecutor) {
          throw invalidRequest(
            `Auth tool '${connectMeta?.tool ?? "?"}' uses connect.tool (orchestrated login), which runs in the connect-run substrate and is not available on this path`,
          );
        }
        return new OrchestratedStrategy(opts.connectToolExecutor);
      }
      // Otherwise paste-the-bag Fields.
      return new FieldsStrategy();
    }
    case "api_key":
    case "basic":
    case "mtls":
      // mtls reuses FieldsStrategy: the user pastes cert + key PEM (and an
      // optional chain) and the manifest's `credentials.schema` validates the
      // bag. The integration spawn resolver materialises the fields into
      // `delivery.files` entries at runtime — there is no separate acquisition
      // step beyond storing the user-supplied credentials.
      return new FieldsStrategy();
    default:
      throw invalidRequest(`Auth type '${auth.type}' has no connect strategy`);
  }
}
