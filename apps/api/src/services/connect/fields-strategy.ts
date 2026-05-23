// SPDX-License-Identifier: Apache-2.0

/**
 * FieldsStrategy — `api_key` / `basic` / `custom` acquisition: the user pastes
 * a credential bag, we validate + extract identity + persist. No `begin`
 * (non-interactive), no `reacquire` (a 401 surfaces as `needsReconnection`).
 *
 * Absorbs the former `connectIntegrationWithFields` verbatim so behaviour is
 * unchanged.
 */

import {
  extractIdentity,
  readIntegrationAuth,
  saveIntegrationConnection,
  type IntegrationConnectionSummary,
} from "../integration-connections.ts";
import type {
  ConnectContext,
  ConnectCompleteInput,
  IntegrationConnectStrategy,
} from "./strategy.ts";
import { assertFieldsInput, requireNonEmptyCredentials } from "./strategy.ts";

export class FieldsStrategy implements IntegrationConnectStrategy {
  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    const credentials = assertFieldsInput(input, "FieldsStrategy");
    const { manifest } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationPackageId,
      ctx.authKey,
    );
    requireNonEmptyCredentials(credentials);

    const { accountId, identityClaims } = extractIdentity(manifest, ctx.authKey, credentials);
    return saveIntegrationConnection(ctx.scope, {
      packageId: ctx.integrationPackageId,
      authKey: ctx.authKey,
      accountId,
      credentials,
      identityClaims,
      actor: ctx.actor,
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
    });
  }
}
