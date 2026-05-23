// SPDX-License-Identifier: Apache-2.0

/**
 * OrchestratedStrategy — code-driven login (spec §4.3). For the irreducible
 * cases the declarative Login can't express: CSRF/HTML scraping, stateful
 * cookie-jars, magic-links. The integration ships a `login` MCP tool; the
 * connect-run substrate executes it in a sandbox and returns a
 * {@link CredentialBundle}.
 *
 * Boundary (spec §4.7): EXECUTION (running the untrusted tool) lives in the
 * connect-run substrate and is reached here through an injected
 * {@link ConnectToolExecutor} — so this orchestration owns only strategy
 * selection + PERSISTENCE and stays unit/DB-testable without a container. The
 * executor's production binding (the connect-run substrate — sidecar run-start
 * hook / ephemeral spawn for `runAt: link`) is wired separately; the security
 * contract it must honour is fixed here:
 *
 *   - the tool receives field NAMES only (`inputFields`) — substitution of the
 *     transient `inputs` happens proxy-side, never in tool code;
 *   - the returned bundle's `outputs` are validated against `produces`
 *     (enforced inside the executor);
 *   - `persistLoginSecret` persists the bootstrap `inputs` in the v2 envelope's
 *     NON-injectable plane (so a future re-bootstrap can re-run the tool),
 *     never reachable by the injection path.
 */

import { invalidRequest } from "../../lib/errors.ts";
import type { IntegrationManifest } from "@appstrate/core/integration";
import type { AppScope } from "../../lib/scope.ts";
import type { Actor } from "@appstrate/connect";
import {
  extractIdentity,
  persistCredentialBundle,
  readIntegrationAuth,
  type IntegrationConnectionSummary,
} from "../integration-connections.ts";
import type {
  ConnectContext,
  ConnectCompleteInput,
  CredentialBundle,
  IntegrationConnectStrategy,
} from "./strategy.ts";

/** One connect-tool login run, handed to the {@link ConnectToolExecutor}. */
export interface ConnectToolExecution {
  scope: AppScope;
  /** Acquiring actor on first connect; absent on a system re-bootstrap (reacquire). */
  actor?: Actor;
  integrationPackageId: string;
  authKey: string;
  manifest: IntegrationManifest;
  /** MCP tool name from `connect.tool`. */
  toolName: string;
  /** Declared injectable outputs (`connect.produces`) — the runner validates against this. */
  produces?: readonly string[];
  /**
   * Transient bootstrap secrets (the submitted credential bag). Installed on
   * the egress path so the tool's `api_call` bodies resolve `{{name}}`
   * placeholders proxy-side. NEVER passed to tool code.
   */
  inputs: Record<string, string>;
  /** Names of the bootstrap fields the tool may reference as `{{name}}`. */
  inputFields: string[];
}

/**
 * Executes a connect-tool login dance in the sandbox and returns the captured
 * bundle. The boundary the OrchestratedStrategy depends on; production binds
 * the connect-run substrate, tests inject a fake.
 */
export interface ConnectToolExecutor {
  run(execution: ConnectToolExecution): Promise<CredentialBundle>;
}

export class OrchestratedStrategy implements IntegrationConnectStrategy {
  constructor(private readonly executor: ConnectToolExecutor) {}

  async complete(
    ctx: ConnectContext,
    input: ConnectCompleteInput,
  ): Promise<IntegrationConnectionSummary> {
    if (input.kind !== "fields") {
      throw new Error(`OrchestratedStrategy.complete: unexpected input kind '${input.kind}'`);
    }
    const { manifest, auth } = await readIntegrationAuth(
      ctx.scope,
      ctx.integrationPackageId,
      ctx.authKey,
    );
    const tool = auth.connect?.tool;
    if (!tool) {
      throw invalidRequest(`Auth '${ctx.authKey}' has no connect.tool declaration`);
    }
    const credentials = input.credentials;
    if (!credentials || Object.keys(credentials).length === 0) {
      throw invalidRequest("credentials payload cannot be empty", "credentials");
    }

    const bundle = await this.executor.run({
      scope: ctx.scope,
      actor: ctx.actor,
      integrationPackageId: ctx.integrationPackageId,
      authKey: ctx.authKey,
      manifest,
      toolName: tool,
      produces: auth.connect?.produces,
      inputs: credentials,
      inputFields: Object.keys(credentials),
    });

    // Identity from injectable outputs + promoted claims — same mapping the
    // other strategies use.
    const identitySource = { ...bundle.outputs, ...(bundle.identityClaims ?? {}) };
    const identity = extractIdentity(manifest, ctx.authKey, identitySource);

    // persistLoginSecret → persist the bootstrap bag in the NON-injectable
    // `inputs` plane (v2 envelope), so a later re-bootstrap can re-run the tool.
    const persistInputs = auth.connect?.persistLoginSecret ? credentials : undefined;

    const target = ctx.connectionId
      ? {
          kind: "update-owned" as const,
          scope: ctx.scope,
          actor: ctx.actor,
          connectionId: ctx.connectionId,
        }
      : { kind: "insert" as const, scope: ctx.scope, actor: ctx.actor };

    const summary = await persistCredentialBundle(target, {
      credentials: bundle.outputs,
      ...(persistInputs ? { inputs: persistInputs } : {}),
      accountId: identity.accountId,
      identityClaims: { ...(bundle.identityClaims ?? {}), ...identity.identityClaims },
      scopesGranted: bundle.scopesGranted ?? [],
      expiresAt: bundle.expiresAt ? new Date(bundle.expiresAt) : null,
      needsReconnection: false,
      ...(ctx.connectionId ? {} : { packageId: ctx.integrationPackageId, authKey: ctx.authKey }),
    });
    // insert / update-owned always return a summary (or throw).
    return summary!;
  }
}
