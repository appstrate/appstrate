// SPDX-License-Identifier: Apache-2.0

/**
 * LoginSecretStrategy — `custom` + `connect.tool` + `runAt: "run-start"`
 * acquisition (P2). At dashboard connect we store ONLY the login secret; the
 * session itself is minted later, at each agent run, by the sidecar's
 * connect-login primitive (`runConnectLogin`) calling the integration's
 * `login` MCP tool.
 *
 * This strategy is therefore the inverse of OrchestratedStrategy: it does NOT
 * run the login tool here (no `connectToolExecutor`), it just persists the
 * submitted credential bag in the v2 envelope's NON-injectable `inputs` plane
 * (so the sidecar can re-run the tool at run-start) with an EMPTY injectable
 * `outputs` plane (no session yet). The result is a "secret stored, session
 * pending" connection.
 *
 * Security: the login secret lands ONLY in the `inputs` plane — the injection
 * path (`decryptCredentialsToStringMap`) never reads it. Spawn-side, the
 * resolver decrypts it (`decryptCredentialInputsToStringMap`) into the
 * sidecar-only `connectLogin.inputs`, where it is substituted proxy-side and
 * never handed to tool code.
 *
 * No `reacquire`: the session is freshly minted on every run from the stored
 * secret, so there is no long-lived session to refresh.
 */

import {
  persistCredentialBundle,
  readIntegrationAuth,
  type IntegrationConnectionSummary,
} from "../integration-connections.ts";
import type {
  ConnectContext,
  ConnectCompleteInput,
  IntegrationConnectStrategy,
} from "./strategy.ts";
import { assertFieldsInput, requireNonEmptyCredentials, connectionTarget } from "./strategy.ts";

export class LoginSecretStrategy implements IntegrationConnectStrategy {
  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    const credentials = assertFieldsInput(input, "LoginSecretStrategy");
    requireNonEmptyCredentials(credentials);
    // Read the auth (validates the manifest declares it). The session is
    // minted at run-start, so we don't run the tool or extract identity here.
    await readIntegrationAuth(ctx.scope, ctx.integrationId, ctx.authKey);

    const target = connectionTarget(ctx);

    const summary = await persistCredentialBundle(target, {
      // No injectable outputs yet — the session is minted at run-start.
      credentials: {},
      // The login secret, persisted in the NON-injectable `inputs` plane.
      inputs: credentials,
      accountId: "default",
      identityClaims: {},
      scopesGranted: [],
      expiresAt: null,
      needsReconnection: false,
      ...(ctx.connectionId ? {} : { packageId: ctx.integrationId, authKey: ctx.authKey }),
    });
    // insert / update-owned always return a summary (or throw).
    return summary!;
  }
}
