// SPDX-License-Identifier: Apache-2.0

/**
 * LoginStrategy — declarative single-request acquisition (spec §4.2, §4.8).
 *
 * Drives the pure `runLogin` engine with the user-submitted bootstrap
 * credentials as transient `inputs`, then persists the engine's `outputs`
 * (injectables) through the single credential writer. No `begin` (the user
 * submits the bootstrap bag like Fields), no `reacquire` yet — re-bootstrap
 * needs the persisted login secret (`persistLoginSecret`), which lands with
 * the structured envelope in a later phase.
 *
 * The secret never reaches a manifest author's code: the manifest carries only
 * `{{placeholder}}`s; the trusted engine substitutes the transient inputs.
 */

import { runLogin, type LoginConfig } from "@appstrate/connect/connect";
import { invalidRequest } from "../../lib/errors.ts";
import {
  assertRequiredIdentityClaims,
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

export class LoginStrategy implements IntegrationConnectStrategy {
  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    const credentials = assertFieldsInput(input, "LoginStrategy");
    const { manifest, auth } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationPackageId,
      ctx.authKey,
    );
    if (!auth.connect) {
      throw invalidRequest(`Auth '${ctx.authKey}' has no connect.login declaration`);
    }
    requireNonEmptyCredentials(credentials);

    // LoginStrategy substitutes `{{name}}` placeholders into HTTP request URLs,
    // headers, and bodies — only string-valued bootstrap inputs are meaningful.
    // Non-string values from the widened `ConnectCompleteInput.credentials`
    // shape get stringified so they still flow through (JSON-encoded objects
    // round-trip cleanly), but the canonical contract here is strings.
    const stringInputs: Record<string, string> = {};
    for (const [k, v] of Object.entries(credentials)) {
      stringInputs[k] = typeof v === "string" ? v : JSON.stringify(v);
    }

    const { outputs, identityClaims, expiresAt } = await runLogin(auth.connect as LoginConfig, {
      inputs: stringInputs,
      authorizedUris: (auth.authorized_uris as string[] | undefined) ?? null,
      allowAllUris: (auth.allow_all_uris as boolean | undefined) ?? false,
    });

    // Identity source = injectable outputs + engine-promoted identity claims,
    // run through the same extractTokenIdentity mapping the other strategies use.
    const identitySource = { ...outputs, ...identityClaims };
    const identity = extractIdentity(manifest, ctx.authKey, identitySource);
    // AFPS 2.0 §7.4 — refuse the connection if any `required_identity_claims`
    // came back missing/empty. The combined claim set is the engine-promoted
    // `identityClaims` ⊕ the manifest-mapped `identity.identityClaims` — same
    // bag we persist below, so the gate matches what would land on the row.
    const combinedClaims = { ...identityClaims, ...identity.identityClaims };
    assertRequiredIdentityClaims(manifest, ctx.authKey, combinedClaims);

    return saveIntegrationConnection(ctx.scope, {
      packageId: ctx.integrationPackageId,
      authKey: ctx.authKey,
      accountId: identity.accountId,
      credentials: outputs,
      identityClaims: { ...identityClaims, ...identity.identityClaims },
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      actor: ctx.actor,
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
    });
  }
}
