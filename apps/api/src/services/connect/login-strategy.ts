// SPDX-License-Identifier: Apache-2.0

/**
 * LoginStrategy — declarative single-request acquisition (AFPS §7.7).
 *
 * Drives the pure `runLogin` engine with the user-submitted bootstrap
 * credentials as `inputs`, then persists the engine's `outputs` (injectables)
 * through the single credential writer. An auth that opts in with
 * `persist_login_secret` also keeps the inputs, in the non-injectable plane, so
 * `refreshConnectionCredential` can log in again ({@link runAuthLogin}).
 *
 * The secret never reaches a manifest author's code: the manifest carries only
 * `{{placeholder}}`s; the trusted engine substitutes the inputs.
 */

import { LoginError, runLogin, type LoginConfig } from "@appstrate/connect/connect";
import { badGateway, invalidRequest } from "../../lib/errors.ts";
import { logger } from "../../lib/logger.ts";
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
import {
  assertCredentialsMatchSchema,
  assertFieldsInput,
  loginInputRefused,
  loginRejected,
  loginTimedOut,
  loginUrlRefused,
  requireNonEmptyCredentials,
} from "./strategy.ts";
import { renderUrlTemplate } from "@appstrate/afps-shared/connection-variables";
import { resolveConnectionVariables } from "./connection-variables.ts";
import { maskCredentialLabel } from "./mask-label.ts";
import {
  getAppstrateConnectMeta,
  renderAuthAuthorizedUris,
  type AfpsManifestAuth,
} from "../integration-manifest-helpers.ts";

/** A login auth that keeps its inputs to log in again when its session is rejected or expires. */
export function persistsLoginSecret(auth: Pick<AfpsManifestAuth, "connect">): boolean {
  return (
    auth.connect?.login !== undefined &&
    getAppstrateConnectMeta(auth.connect)?.persist_login_secret === true
  );
}

/** The auth's login with typed `inputs`, its URL and `authorized_uris` rendered for `variables`. */
export async function runAuthLogin(
  auth: AfpsManifestAuth,
  inputs: Record<string, unknown>,
  variables: Readonly<Record<string, string>> | null,
): ReturnType<typeof runLogin> {
  const config = auth.connect as LoginConfig;
  const url = renderUrlTemplate(config.login.request.url, variables ?? {});
  if (url === null) {
    throw new LoginError(
      "connect.login.request.url renders no URL for this connection",
      "invalid_config",
    );
  }
  return runLogin(
    { ...config, login: { ...config.login, request: { ...config.login.request, url } } },
    {
      inputs,
      authorizedUris: renderAuthAuthorizedUris(auth, {}, variables ?? {}),
      allowAllUris: auth.allow_all_uris === true,
    },
  );
}

/** A login failure the submitter can act on, as its 4xx/5xx; any other stays the caller's 500. */
function loginRefusal(err: unknown, ctx: ConnectContext): unknown {
  if (!(err instanceof LoginError)) return err;
  if (err.reason === "upstream_failed" || err.reason === "timeout") {
    // The cause the 502/504 body leaves out: a status, a delay or an error class, never an input.
    logger.warn("connect.login did not complete", {
      integrationId: ctx.integrationId,
      authKey: ctx.authKey,
      reason: err.reason,
      error: err.message,
    });
  }
  switch (err.reason) {
    case "rejected":
      return loginRejected(
        `the service refused the submitted credentials (HTTP ${err.upstreamStatus}).`,
      );
    case "invalid_input":
      return loginInputRefused(err.field!);
    case "url_not_allowed":
      return err.fields?.length ? loginUrlRefused(err.fields) : err;
    case "upstream_failed":
      return badGateway("The service could not complete the login. Try again later.");
    case "timeout":
      return loginTimedOut(err.timeoutMs!);
    default:
      return err;
  }
}

export class LoginStrategy implements IntegrationConnectStrategy {
  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    const credentials = assertFieldsInput(input, "LoginStrategy");
    const { manifest, auth } = await readIntegrationAuth(ctx.scope, ctx.integrationId, ctx.authKey);
    if (!auth.connect) {
      throw invalidRequest(`Auth '${ctx.authKey}' has no connect.login declaration`);
    }
    requireNonEmptyCredentials(credentials);
    const inputs = assertCredentialsMatchSchema(auth.credentials?.schema, credentials);
    const afpsAuth = auth as unknown as AfpsManifestAuth;

    const variables = await resolveConnectionVariables(manifest, afpsAuth, ctx.variables);
    const { outputs, identityClaims, expiresAt } = await runAuthLogin(
      afpsAuth,
      inputs,
      variables,
    ).catch((err: unknown) => {
      throw loginRefusal(err, ctx);
    });

    // Identity source = injectable outputs + engine-promoted identity claims,
    // run through the same extractTokenIdentity mapping the other strategies use.
    const identitySource = { ...outputs, ...identityClaims };
    const identity = extractIdentity(manifest, ctx.authKey, identitySource);
    // AFPS §7.4 — refuse the connection if any `required_identity_claims`
    // came back missing/empty. The combined claim set is the engine-promoted
    // `identityClaims` ⊕ the manifest-mapped `identity.identityClaims` — same
    // bag we persist below, so the gate matches what would land on the row.
    const combinedClaims = { ...identityClaims, ...identity.identityClaims };
    assertRequiredIdentityClaims(manifest, ctx.authKey, combinedClaims);

    return saveIntegrationConnection(ctx.scope, {
      packageId: ctx.integrationId,
      authKey: ctx.authKey,
      accountId: identity.accountId,
      credentials: outputs,
      identityClaims: { ...identityClaims, ...identity.identityClaims },
      expiresAt: expiresAt ? new Date(expiresAt) : null,
      actor: ctx.actor,
      variables,
      labelHint: maskCredentialLabel(auth.credentials?.schema, credentials),
      ...(persistsLoginSecret(afpsAuth) ? { inputs: credentials } : {}),
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
    });
  }
}
