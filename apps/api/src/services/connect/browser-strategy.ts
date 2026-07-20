// SPDX-License-Identifier: Apache-2.0

import type { Actor } from "@appstrate/connect";
import type { BrowserAcquisitionResult, CredentialBundle } from "@appstrate/connect/connect";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { BrowserSessionMode } from "@appstrate/core/sidecar-types";

import { invalidRequest } from "../../lib/errors.ts";
import type { AppScope } from "../../lib/scope.ts";
import { toBrowserCapabilityApiError } from "../browser-capability-error-mapping.ts";
import {
  getAppstrateConnectMeta,
  getBrowserConnectExecutor,
  type AfpsManifestConnect,
} from "../integration-manifest-helpers.ts";
import {
  extractIdentity,
  persistCredentialBundle,
  readIntegrationAuth,
  type IntegrationConnectionSummary,
} from "../integration-connections.ts";
import type {
  ConnectCompleteInput,
  ConnectContext,
  IntegrationConnectStrategy,
} from "./strategy.ts";
import { assertFieldsInput, connectionTarget, requireNonEmptyCredentials } from "./strategy.ts";

export interface BrowserConnectExecution {
  readonly scope: AppScope;
  readonly actor?: Actor;
  readonly integrationId: string;
  readonly authKey: string;
  readonly manifest: IntegrationManifest;
  readonly toolName: string;
  readonly produces: readonly string[];
  readonly sessionMode: Exclude<BrowserSessionMode, "none">;
  /** Transient bootstrap inputs, delivered only through the trusted channel. */
  readonly inputs: Record<string, unknown>;
  /** Streams a provider-hosted live session to the trusted connect UI. */
  readonly onInteractionRequired?: (interaction: { url: string }) => void | Promise<void>;
  /** Cancels the paid browser workload when the connect client goes away. */
  readonly signal?: AbortSignal;
}

export interface BrowserConnectExecutor {
  run(execution: BrowserConnectExecution): Promise<BrowserAcquisitionResult>;
}

function validateAcquisitionResult(
  result: BrowserAcquisitionResult,
  produces: readonly string[],
  sessionMode: BrowserConnectExecution["sessionMode"],
): CredentialBundle {
  if (
    !result ||
    typeof result !== "object" ||
    !result.proof ||
    result.proof.succeeded !== true ||
    typeof result.proof.kind !== "string" ||
    result.proof.kind.length === 0 ||
    result.proof.kind.length > 128
  ) {
    throw invalidRequest("Browser acquisition did not provide a successful authenticated proof");
  }
  if (!result.outputs || typeof result.outputs !== "object" || Array.isArray(result.outputs)) {
    throw invalidRequest("Browser acquisition returned malformed outputs");
  }
  const allowed = new Set(produces);
  const outputEntries = Object.entries(result.outputs);
  if (outputEntries.length > 256) {
    throw invalidRequest("Browser acquisition returned too many outputs");
  }
  for (const [key, value] of outputEntries) {
    if (!allowed.has(key)) {
      throw invalidRequest(`Browser acquisition returned undeclared output '${key}'`);
    }
    if (typeof value !== "string" || value.length > 1_048_576) {
      throw invalidRequest(`Browser acquisition returned malformed output '${key}'`);
    }
  }
  if (sessionMode === "exportable" && outputEntries.length === 0) {
    throw invalidRequest("Exportable browser acquisition returned no injectable output");
  }
  if (
    result.expiresAt !== undefined &&
    result.expiresAt !== null &&
    (typeof result.expiresAt !== "string" || !Number.isFinite(Date.parse(result.expiresAt)))
  ) {
    throw invalidRequest("Browser acquisition returned an invalid expiration timestamp");
  }
  return {
    outputs: result.outputs,
    ...(result.identityClaims ? { identityClaims: result.identityClaims } : {}),
    ...(result.scopesGranted ? { scopesGranted: result.scopesGranted } : {}),
    ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
  };
}

function assertSupportedLinkSessionMode(sessionMode: BrowserConnectExecution["sessionMode"]): void {
  if (sessionMode === "browser-bound") {
    throw invalidRequest(
      "Browser-bound link sessions require the runtime-state store and lease service; " +
        "use session_mode='exportable' or run_at='run-start' until that subsystem is enabled",
    );
  }
}

/**
 * Secret-aware browser connect strategy. Unlike OrchestratedStrategy, the
 * trusted browser executor receives bootstrap values because it must submit
 * them to Chromium. Selection requires the separately-authorized browser
 * driver capability; the executor enforces that grant against the concrete
 * package version before this method can persist anything.
 */
export class BrowserConnectStrategy implements IntegrationConnectStrategy {
  constructor(private readonly executor: BrowserConnectExecutor) {}

  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    const credentials = assertFieldsInput(input, "BrowserConnectStrategy");
    requireNonEmptyCredentials(credentials);
    const { manifest, auth } = await readIntegrationAuth(ctx.scope, ctx.integrationId, ctx.authKey);
    const connect = auth.connect as AfpsManifestConnect | undefined;
    const meta = getAppstrateConnectMeta(connect);
    const executor = getBrowserConnectExecutor(connect);
    if (connect?.tool === undefined || !meta?.tool || !executor) {
      throw invalidRequest(`Auth '${ctx.authKey}' has no browser connect executor declaration`);
    }
    if (meta.run_at === "run-start") {
      throw invalidRequest("Run-start browser acquisition stores bootstrap inputs at link time");
    }
    assertSupportedLinkSessionMode(executor.session_mode);

    const produces = meta.produces ?? [];
    let rawResult: BrowserAcquisitionResult;
    try {
      rawResult = await this.executor.run({
        scope: ctx.scope,
        actor: ctx.actor,
        integrationId: ctx.integrationId,
        authKey: ctx.authKey,
        manifest,
        toolName: meta.tool,
        produces,
        sessionMode: executor.session_mode,
        inputs: credentials,
        ...(ctx.onBrowserInteractionRequired
          ? { onInteractionRequired: ctx.onBrowserInteractionRequired }
          : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (error) {
      const mapped = toBrowserCapabilityApiError(error);
      if (mapped) throw mapped;
      throw error;
    }
    const bundle = validateAcquisitionResult(rawResult, produces, executor.session_mode);
    const identitySource = { ...bundle.outputs, ...(bundle.identityClaims ?? {}) };
    const identity = extractIdentity(manifest, ctx.authKey, identitySource);
    const persistInputs = meta.persist_login_secret ? credentials : undefined;

    const summary = await persistCredentialBundle(connectionTarget(ctx), {
      credentials: bundle.outputs,
      ...(persistInputs ? { inputs: persistInputs } : {}),
      accountId: identity.accountId,
      identityClaims: { ...(bundle.identityClaims ?? {}), ...identity.identityClaims },
      scopesGranted: bundle.scopesGranted ?? [],
      expiresAt: bundle.expiresAt ? new Date(bundle.expiresAt) : null,
      needsReconnection: false,
      ...(ctx.connectionId ? {} : { packageId: ctx.integrationId, authKey: ctx.authKey }),
    });
    return summary!;
  }
}

export const _test = { validateAcquisitionResult, assertSupportedLinkSessionMode };
