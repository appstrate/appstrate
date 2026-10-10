// SPDX-License-Identifier: Apache-2.0

/**
 * FieldsStrategy — `api_key` / `basic` / `custom` acquisition: the user pastes
 * a credential bag, we validate + extract identity + persist. No `begin`
 * (non-interactive), no `reacquire` (a 401 surfaces as `needsReconnection`).
 *
 * Absorbs the former `connectIntegrationWithFields` verbatim so behaviour is
 * unchanged.
 */

import { unrenderableAuthorizedUriFields } from "@appstrate/afps-shared/authorized-uris";
import { toCredentialStringMap } from "@appstrate/connect/integration-credentials";

import {
  extractIdentity,
  readIntegrationAuth,
  saveIntegrationConnection,
  type IntegrationConnectionSummary,
} from "../integration-connections.ts";
import { maskCredentialLabel } from "./mask-label.ts";
import { validationFailed } from "../../lib/errors.ts";
import type {
  ConnectContext,
  ConnectCompleteInput,
  IntegrationConnectStrategy,
} from "./strategy.ts";
import {
  assertCredentialsMatchSchema,
  assertFieldsInput,
  requireNonEmptyCredentials,
} from "./strategy.ts";
import { resolveConnectionVariables } from "./connection-variables.ts";
import type { AfpsManifestAuth } from "../integration-manifest-helpers.ts";

export class FieldsStrategy implements IntegrationConnectStrategy {
  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    const credentials = assertFieldsInput(input, "FieldsStrategy");
    const { manifest, auth } = await readIntegrationAuth(ctx.scope, ctx.integrationId, ctx.authKey);
    requireNonEmptyCredentials(credentials);

    // Rejects missing required fields AND wrong-cased keys (e.g. `apiKey` for a
    // manifest declaring `api_key`), which would otherwise persist a connection
    // that looks healthy but whose `delivery.http` injection silently no-ops at
    // runtime (the field lookup misses → empty value → header never injected).
    assertCredentialsMatchSchema(auth.credentials?.schema, credentials);
    const variables = await resolveConnectionVariables(
      manifest,
      auth as unknown as AfpsManifestAuth,
      ctx.variables,
    );
    // #1627: an `authorized_uris` entry the submitted fields cannot render would refuse every
    // later call, so the connection is refused now. Never echoes the value. Judged on the
    // projection every read renders from, so a typed field (`port: 8443`) passes here as there.
    const unrenderable = unrenderableAuthorizedUriFields(
      auth.authorized_uris ?? [],
      toCredentialStringMap(credentials),
      variables ?? {},
    );
    if (unrenderable.length > 0) {
      throw validationFailed(
        unrenderable.map(({ root, field, expected }) => ({
          field: root === "variable" ? `variables.${field}` : `credentials.${field}`,
          code: root === "variable" ? "unrenderable_variable" : "unrenderable_authorized_uri",
          title: "Invalid Connection Field",
          message: `must be ${expected}`,
        })),
      );
    }

    const { accountId, identityClaims } = extractIdentity(manifest, ctx.authKey, credentials);
    // No upstream identity → derive a recognisable label from the secret itself
    // (masked fingerprint, e.g. `fc****f10b`) rather than fall back to
    // "Connexion N". Only honoured on INSERT — the persist layer never touches
    // `label` on reconnect, so this stays stable.
    const labelHint = maskCredentialLabel(auth.credentials?.schema, credentials);
    return saveIntegrationConnection(ctx.scope, {
      packageId: ctx.integrationId,
      authKey: ctx.authKey,
      accountId,
      credentials,
      identityClaims,
      actor: ctx.actor,
      variables,
      ...(labelHint ? { labelHint } : {}),
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
      ...(ctx.delegated ? { delegated: true } : {}),
    });
  }
}
