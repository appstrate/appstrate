// SPDX-License-Identifier: Apache-2.0

import type { BrowserProviderBinding } from "@appstrate/core/sidecar-types";
import type { IntegrationManifest } from "@appstrate/core/integration";

import { logger } from "../lib/logger.ts";
import {
  authenticateBrowserConnectionAttempt,
  authenticateBrowserConnectionAttemptById,
  consumeBrowserAttemptHandoff,
  failBrowserConnectionAttempt,
  finalizeBrowserConnectionBinding,
  setBrowserAttemptInteraction,
  type BrowserAttemptView,
} from "./browser-connection-state.ts";
import type { BrowserConnectExecutor } from "./connect/browser-strategy.ts";
import { resolveStrategy } from "./connect/registry.ts";
import {
  getAppstrateConnectMeta,
  getBrowserCompanionMeta,
  getBrowserConnectExecutor,
  type AfpsManifestAuth,
} from "./integration-manifest-helpers.ts";
import { readIntegrationAuth } from "./integration-connections.ts";

export interface BrowserCompanionContext {
  attempt: BrowserAttemptView;
  displayName: string;
  icon: string | null;
  startUrl: string;
  allowedOrigins: string[];
  manifest: IntegrationManifest;
  auth: NonNullable<IntegrationManifest["auths"]>[string];
  toolName: string;
  produces: string[];
  sessionMode: "exportable" | "browser-bound";
}

/**
 * Convert the auth's URL-pattern envelope into the exact HTTPS origins the
 * companion may export. Host wildcards are deliberately unsupported: portable
 * state is bearer material and must never be scoped to an attacker-chosen host.
 */
export function deriveCompanionAllowedOrigins(auth: AfpsManifestAuth): string[] {
  const origins = new Set<string>();
  for (const pattern of auth.authorized_uris ?? []) {
    if (typeof pattern !== "string" || pattern.length > 2048) continue;
    try {
      const url = new URL(pattern);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        /[*?{}[\]]/.test(url.hostname)
      ) {
        continue;
      }
      origins.add(url.origin);
    } catch {
      // Install-time manifest validation owns the broader error. Companion
      // acquisition simply fails closed on a non-literal origin.
    }
  }
  return [...origins].sort();
}

export async function resolveBrowserCompanionContext(
  attempt: BrowserAttemptView,
): Promise<BrowserCompanionContext> {
  const { manifest, auth: rawAuth } = await readIntegrationAuth(
    attempt.scope,
    attempt.integrationId,
    attempt.authKey,
  );
  const auth = rawAuth as AfpsManifestAuth;
  const connect = auth.connect;
  const meta = getAppstrateConnectMeta(connect);
  const executor = getBrowserConnectExecutor(connect);
  const companion = getBrowserCompanionMeta(connect);
  if (!meta?.tool || !executor || !companion || meta.run_at !== "link") {
    throw new Error("BROWSER_UNAVAILABLE: integration has no local companion flow");
  }
  // The hybrid handoff requires a portable state artifact. Browser-bound
  // drivers have no meaningful state to transfer between machines.
  if (executor.session_mode !== "exportable" || !(meta.produces ?? []).includes("browser_state")) {
    throw new Error("BROWSER_UNAVAILABLE: companion flow requires exportable browser_state");
  }
  const allowedOrigins = deriveCompanionAllowedOrigins(auth);
  if (
    allowedOrigins.length === 0 ||
    !allowedOrigins.includes(new URL(companion.start_url).origin)
  ) {
    throw new Error("BROWSER_UNAVAILABLE: companion start URL is outside authorized origins");
  }
  return {
    attempt,
    displayName: manifest.display_name ?? attempt.integrationId,
    icon: manifest.icon ?? null,
    startUrl: companion.start_url,
    allowedOrigins,
    manifest,
    auth: rawAuth,
    toolName: meta.tool,
    produces: [...(meta.produces ?? [])],
    sessionMode: executor.session_mode,
  };
}

export async function readBrowserCompanionContext(
  attemptId: string,
  token: string,
  options: { claim?: boolean } = {},
): Promise<BrowserCompanionContext> {
  const attempt = await authenticateBrowserConnectionAttempt(attemptId, token, options);
  return resolveBrowserCompanionContext(attempt);
}

function safeBrowserErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\b(BROWSER_[A-Z_]{1,64})\b/);
  return match?.[1] ?? "BROWSER_UNAVAILABLE";
}

/**
 * Run the target-provider proof independently of the companion's handoff HTTP
 * request. The DB transition in consumeBrowserAttemptHandoff is the claim: two
 * API instances may enqueue the attempt, but only one can move it from
 * state_received to provisioning.
 */
export async function provisionBrowserConnectionAttempt(
  attemptId: string,
  executor: BrowserConnectExecutor,
): Promise<void> {
  let context: BrowserCompanionContext | undefined;
  try {
    // Resolve public manifest metadata before claiming expensive provider work.
    // Authentication happened at the route; this internal read is scoped by the
    // attempt row itself and never trusts caller-supplied org/application ids.
    const attempt = await authenticateBrowserConnectionAttemptById(attemptId);
    context = await resolveBrowserCompanionContext(attempt);
    const browserState = await consumeBrowserAttemptHandoff(attemptId);
    const providerBinding: BrowserProviderBinding = {
      // Before the final integration connection exists, the attempt id is the
      // unique immutable allocation owner. It is never accepted as a run lease.
      bindingId: attemptId,
      provider: context.attempt.targetProvider,
      profileRef: context.attempt.profileRef,
      stateVersion: 1,
      ...(context.attempt.proxy ? { proxy: context.attempt.proxy } : {}),
    };
    const strategy = resolveStrategy(context.auth, { browserConnectExecutor: executor });
    const connection = await strategy.complete(
      {
        scope: context.attempt.scope,
        actor: context.attempt.actor,
        integrationId: context.attempt.integrationId,
        authKey: context.attempt.authKey,
        ...(context.attempt.connectionId ? { connectionId: context.attempt.connectionId } : {}),
        browserProviderBinding: providerBinding,
        onBrowserInteractionRequired: ({ url }) => setBrowserAttemptInteraction(attemptId, url),
      },
      { kind: "fields", credentials: { browser_state: browserState } },
    );
    await finalizeBrowserConnectionBinding({ attemptId, connectionId: connection.id });
  } catch (error) {
    // Losing the atomic state_received claim is expected if another API
    // instance already started the same attempt. Do not overwrite its status.
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("browser companion attempt is invalid or expired")) return;
    await failBrowserConnectionAttempt(attemptId, safeBrowserErrorCode(error)).catch(
      () => undefined,
    );
    logger.error("Browser companion provisioning failed", {
      attemptId,
      integrationId: context?.attempt.integrationId,
      error: message,
    });
  }
}

export const _test = { safeBrowserErrorCode };
