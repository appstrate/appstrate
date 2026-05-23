// SPDX-License-Identifier: Apache-2.0

/**
 * FieldsStrategy — `api_key` / `basic` / `custom` acquisition: the user pastes
 * a credential bag, we validate + extract identity + persist. No `begin`
 * (non-interactive), no `reacquire` (a 401 surfaces as `needsReconnection`).
 *
 * Absorbs the former `connectIntegrationWithFields` verbatim so behaviour is
 * unchanged.
 */

import { invalidRequest } from "../../lib/errors.ts";
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

export class FieldsStrategy implements IntegrationConnectStrategy {
  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    if (input.kind !== "fields") {
      throw new Error(`FieldsStrategy.complete: unexpected input kind '${input.kind}'`);
    }
    const credentials = input.credentials;
    const { manifest, auth } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationPackageId,
      ctx.authKey,
    );
    if (auth.type === "oauth2" || auth.type === "oauth1") {
      throw invalidRequest(
        `Auth '${ctx.authKey}' is type '${auth.type}' — use the OAuth flow, not the fields flow`,
      );
    }
    if (!credentials || Object.keys(credentials).length === 0) {
      throw invalidRequest("credentials payload cannot be empty", "credentials");
    }

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
