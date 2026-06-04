// SPDX-License-Identifier: Apache-2.0

/**
 * FieldsStrategy — `api_key` / `basic` / `custom` acquisition: the user pastes
 * a credential bag, we validate + extract identity + persist. No `begin`
 * (non-interactive), no `reacquire` (a 401 surfaces as `needsReconnection`).
 *
 * Absorbs the former `connectIntegrationWithFields` verbatim so behaviour is
 * unchanged.
 */

import type { JSONSchemaObject } from "@appstrate/core/form";

import {
  extractIdentity,
  readIntegrationAuth,
  saveIntegrationConnection,
  type IntegrationConnectionSummary,
} from "../integration-connections.ts";
import { validateConnectionCredentials } from "../schema.ts";
import { invalidRequest } from "../../lib/errors.ts";
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
    const { manifest, auth } = await readIntegrationAuth(ctx.scope, ctx.integrationId, ctx.authKey);
    requireNonEmptyCredentials(credentials);

    // Validate the pasted bag against the auth's declared credentials.schema.
    // Rejects missing required fields AND wrong-cased keys (e.g. `apiKey` for a
    // manifest declaring `api_key`), which would otherwise persist a connection
    // that looks healthy but whose `delivery.http` injection silently no-ops at
    // runtime (the field lookup misses → empty value → header never injected).
    const credsResult = validateConnectionCredentials(
      auth.credentials?.schema as JSONSchemaObject | undefined,
      credentials,
    );
    if (!credsResult.valid) {
      throw invalidRequest(
        `Credentials do not match the integration's declared schema: ${credsResult.errors
          .map((e) => `${e.field} ${e.message}`)
          .join("; ")}`,
        "credentials",
      );
    }

    const { accountId, identityClaims } = extractIdentity(manifest, ctx.authKey, credentials);
    return saveIntegrationConnection(ctx.scope, {
      packageId: ctx.integrationId,
      authKey: ctx.authKey,
      accountId,
      credentials,
      identityClaims,
      actor: ctx.actor,
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
    });
  }
}
