// SPDX-License-Identifier: Apache-2.0

/**
 * TwoStepStrategy — declarative multi-step acquisition (spec §4.2, §4.8).
 *
 * Drives the pure `runTwoStep` engine with the user-submitted bootstrap
 * credentials as transient `inputs`, then persists the engine's `outputs`
 * (injectables) through the single credential writer. No `begin` (the user
 * submits the bootstrap bag like Fields), no `reacquire` yet — re-bootstrap
 * needs the persisted login secret (`persistLoginSecret`), which lands with
 * the structured envelope in a later phase.
 *
 * The secret never reaches a manifest author's code: the manifest carries only
 * `{{placeholder}}`s; the trusted engine substitutes the transient inputs.
 */

import { runTwoStep, type TwoStepConfig } from "@appstrate/connect/connect";
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

export class TwoStepStrategy implements IntegrationConnectStrategy {
  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    if (input.kind !== "fields") {
      throw new Error(`TwoStepStrategy.complete: unexpected input kind '${input.kind}'`);
    }
    const { manifest, auth } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationPackageId,
      ctx.authKey,
    );
    if (!auth.connect) {
      throw invalidRequest(`Auth '${ctx.authKey}' has no connect.steps declaration`);
    }
    if (!input.credentials || Object.keys(input.credentials).length === 0) {
      throw invalidRequest("credentials payload cannot be empty", "credentials");
    }

    const { outputs, identityClaims, expiresAt } = await runTwoStep(auth.connect as TwoStepConfig, {
      inputs: input.credentials,
      authorizedUris: auth.authorizedUris ?? null,
      allowAllUris: auth.allowAllUris ?? false,
    });

    // Identity source = injectable outputs + engine-promoted identity claims,
    // run through the same extractTokenIdentity mapping the other strategies use.
    const identitySource = { ...outputs, ...identityClaims };
    const identity = extractIdentity(manifest, ctx.authKey, identitySource);

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
